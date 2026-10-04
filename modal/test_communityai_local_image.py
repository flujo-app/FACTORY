"""Offline exclusivity counterfactuals with fake Docker; no image operations."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("local_image", Path(__file__).with_name("build_communityai_local_image.py"))
local_image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local_image)
PREP_SPEC = importlib.util.spec_from_file_location("prepare_image", Path(__file__).with_name("prepare_communityai_local_image.py"))
prepare_image = importlib.util.module_from_spec(PREP_SPEC)
PREP_SPEC.loader.exec_module(prepare_image)
COMPILER_TAG = "factory-communityai-compiler:test"
RUNTIME_TAG = "factory-communityai-runtime:test"
COMPILER_IID = "sha256:" + "1" * 64
RUNTIME_IID = "sha256:" + "2" * 64


def preparation(root):
    (root / "context").mkdir()
    (root / "inputs.json").write_text(json.dumps({
        "context_files": {}, "factory_runtime_source_label": "fixture-source",
        "source_commit": "fixture-source", "factory_commit": "fixture-factory"}))


def raced_exists(filename):
    """Force both callers to observe absent before either can reserve a file."""
    gate = threading.Barrier(2, timeout=5)
    original = Path.exists

    def observe(path):
        if path.name == filename:
            gate.wait()
            return False
        return original(path)

    return observe


class ExclusivityTests(unittest.TestCase):
    def test_interrupted_receipt_replacement_preserves_prior_intent_or_pid_and_cannot_replay(self):
        for failing_update in (1, 2):
            with self.subTest(failing_update=failing_update), \
                    tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
                root = Path(folder)
                preparation(root)
                record_path = root / "role-build.process.json"
                arguments = dict(compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
                wait_calls, prior_bytes, prepared_replacements = [], [], []
                real_fsync = local_image.os.fsync
                update_count = 0

                def fake_popen(*args, **kwargs):
                    self.assertEqual(json.loads(record_path.read_bytes())["phase"], "intent")
                    return type("FakeDocker", (), {"pid": "fixture-only",
                        "wait": lambda self: wait_calls.append("wait") or 7})()

                def interrupt_replacement(descriptor):
                    nonlocal update_count
                    update_count += 1
                    if update_count == failing_update:
                        prior_bytes.append(record_path.read_bytes())
                        temporary = list(root.glob("role-build.process.json.*.tmp"))
                        self.assertEqual(len(temporary), 1)
                        # Complete JSON is visible before fsync: the write was
                        # flushed, yet the prior receipt has not been replaced.
                        prepared_replacements.append(json.loads(temporary[0].read_bytes()))
                        raise OSError("injected interruption preparing replacement")
                    real_fsync(descriptor)

                with patch.object(local_image, "image_id", return_value=COMPILER_IID), \
                        patch.object(local_image.subprocess, "Popen", side_effect=fake_popen) as popen, \
                        patch.object(local_image.os, "fsync", side_effect=interrupt_replacement), \
                        redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(OSError, "injected interruption"):
                        local_image.build(root, **arguments)
                    self.assertEqual(popen.call_count, 1)
                    self.assertEqual(record_path.read_bytes(), prior_bytes[0])
                    retained = json.loads(prior_bytes[0])
                    self.assertEqual(retained["phase"], "intent" if failing_update == 1 else "running")
                    self.assertEqual(retained["pid"], None if failing_update == 1 else "fixture-only")
                    self.assertIsNone(retained["exit_code"])
                    self.assertEqual(wait_calls, [] if failing_update == 1 else ["wait"])
                    self.assertEqual(prepared_replacements[0]["phase"], "running" if failing_update == 1 else "closed")
                    with self.assertRaisesRegex(ValueError, "do not restart"):
                        local_image.build(root, **arguments)
                    self.assertEqual(popen.call_count, 1)
                    self.assertEqual(record_path.read_bytes(), prior_bytes[0])

    def test_two_stale_absent_build_observations_start_only_one_fake_docker(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            preparation(root)
            arguments = dict(compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
            with patch.object(local_image, "image_id", return_value=COMPILER_IID), \
                    patch.object(Path, "exists", raced_exists("role-build.process.json")), \
                    patch.object(local_image.subprocess, "Popen", side_effect=RuntimeError("fake Docker entry")) as popen:
                with ThreadPoolExecutor(max_workers=2) as callers:
                    results = [callers.submit(local_image.build, root, **arguments) for _ in range(2)]
                    errors = []
                    for result in results:
                        try:
                            result.result(timeout=8)
                        except Exception as error:
                            errors.append(error)
                self.assertEqual(popen.call_count, 1)
                self.assertEqual(sum(isinstance(error, FileExistsError) for error in errors), 1)
                self.assertEqual(sum(str(error) == "fake Docker entry" for error in errors), 1)
            record_path = root / "role-build.process.json"
            reserved = record_path.read_bytes()
            self.assertEqual(json.loads(reserved)["phase"], "intent")
            with patch.object(local_image, "image_id", return_value=COMPILER_IID), \
                    patch.object(local_image.subprocess, "Popen") as forbidden:
                with self.assertRaisesRegex(ValueError, "do not restart"):
                    local_image.build(root, **arguments)
                forbidden.assert_not_called()
            self.assertEqual(record_path.read_bytes(), reserved)

    def test_orphaned_log_is_not_replaced_and_reserved_unknown_intent_cannot_replay(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            preparation(root)
            log_path = root / "role-build.log"
            log_path.write_bytes(b"retained orphaned log\n")
            with patch.object(local_image, "image_id", return_value=COMPILER_IID), \
                    patch.object(local_image.subprocess, "Popen") as forbidden:
                with self.assertRaises(FileExistsError):
                    local_image.build(root, compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
                with self.assertRaisesRegex(ValueError, "do not restart"):
                    local_image.build(root, compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
                forbidden.assert_not_called()
            self.assertEqual(log_path.read_bytes(), b"retained orphaned log\n")
            self.assertEqual(json.loads((root / "role-build.process.json").read_text())["phase"], "intent")

    def test_two_qualification_writers_cannot_replace_each_others_result(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            original = {"phase": "closed", "exit_code": 0, "compiler_iid_expected": COMPILER_IID,
                        "compiler_iid_before": COMPILER_IID, "compiler_iid_after": COMPILER_IID,
                        "compiler_tag": COMPILER_TAG, "argv": ["--tag", RUNTIME_TAG], "pid": "fixture-only",
                        "qualification_error": "retained fixture error", "source_commit": "fixture-source",
                        "factory_commit": "fixture-factory"}
            original_path = root / "role-build.process.json"
            original_path.write_text(json.dumps(original))
            original_bytes = original_path.read_bytes()
            metadata = {"buildx.build.ref": "fixture-only", "buildx.build.provenance": {"materials": [{
                "uri": "pkg:docker/factory-communityai-compiler@test?platform=linux%2Famd64",
                "digest": {"sha256": "1" * 64}}]}, "containerimage.config.digest": RUNTIME_IID}
            raw_metadata = json.dumps(metadata).encode()
            (root / "role.metadata.json").write_bytes(raw_metadata)
            original.update(buildkit_metadata_sha256=hashlib.sha256(raw_metadata).hexdigest(),
                            buildkit_ref="fixture-only", buildkit_output_config_iid=RUNTIME_IID, runtime_iid=RUNTIME_IID)
            original_path.write_text(json.dumps(original))
            original_bytes = original_path.read_bytes()
            (root / "role.iid").write_text(RUNTIME_IID)
            binding = {"compiler_tag": COMPILER_TAG, "config_iid": COMPILER_IID,
                       "rootfs_chain_id": "sha256:" + "3" * 64}
            with patch.object(Path, "exists", raced_exists("role-local-qualification.json")), \
                    patch.object(local_image, "compiler_binding", return_value=binding), \
                    patch.object(local_image, "image_id", return_value=RUNTIME_IID):
                with ThreadPoolExecutor(max_workers=2) as callers:
                    results = [callers.submit(local_image.qualify_existing, root, expected_runtime_iid=RUNTIME_IID)
                               for _ in range(2)]
                    successful, rejected = [], []
                    for result in results:
                        try:
                            successful.append(result.result(timeout=8))
                        except FileExistsError as error:
                            rejected.append(error)
            self.assertEqual(len(successful), 1)
            self.assertEqual(len(rejected), 1)
            self.assertEqual(original_path.read_bytes(), original_bytes)
            qualified_path = root / "role-local-qualification.json"
            retained = qualified_path.read_bytes()
            self.assertEqual(json.loads(retained), successful[0])
            with patch.object(local_image, "compiler_binding") as forbidden:
                with self.assertRaisesRegex(ValueError, "immutable qualification"):
                    local_image.qualify_existing(root, expected_runtime_iid=RUNTIME_IID)
                forbidden.assert_not_called()
            self.assertEqual(qualified_path.read_bytes(), retained)


class ProvenanceTests(unittest.TestCase):
    def test_dirty_or_crlf_working_files_cannot_replace_exact_committed_blobs(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            source, factory = root / "owner", root / "factory"
            source.mkdir()
            (factory / "modal").mkdir(parents=True)
            lock = b'[[package]]\nname = "setuptools"\nversion = "81.0.0"\nwheels = [{ url = "https://example.invalid/setuptools-py3-none-any.whl", hash = "sha256:' + b"1" * 64 + b'" }]\n'
            (source / "uv.lock").write_bytes(lock)
            committed_files = {
                "communityai_bootstrap.py": b"# reviewed bootstrap\n",
                "communityai_runtime.py": f'SOURCE_COMMIT = "{prepare_image.SOURCE_COMMIT}"\n'.encode(),
                "communityai_runtime_watchdog.py": b"# reviewed watchdog\n",
                "communityai-model-manifest.json": b'{"reviewed": true}\n',
            }
            working_files = {}
            for index, (name, blob) in enumerate(committed_files.items()):
                # A normalized Git diff can hide CRLF conversion; dirty bytes
                # also must never enter a committed-source preparation.
                working = blob.replace(b"\n", b"\r\n") if index % 2 == 0 else b"dirty unreviewed file\n"
                (factory / "modal" / name).write_bytes(working)
                working_files[name] = working
            recipe_path = "modal/Dockerfile.communityai-runtime"
            (factory / recipe_path).write_bytes(b"dirty unreviewed working recipe\n")
            committed = b"FROM committed-reviewed-input\n"

            def fake_git(worktree, *args):
                if args == ("rev-parse", "HEAD"):
                    value = prepare_image.SOURCE_COMMIT if Path(worktree) == source else prepare_image.FACTORY_COMMIT
                    return value.encode()
                if args[0] in ("status", "diff"):
                    return b""
                if args == ("show", f"{prepare_image.SOURCE_COMMIT}:uv.lock"):
                    return lock
                if args == ("show", f"{prepare_image.FACTORY_COMMIT}:{recipe_path}"):
                    return committed
                for name, blob in committed_files.items():
                    if args == ("show", f"{prepare_image.FACTORY_COMMIT}:modal/{name}"):
                        return blob
                raise AssertionError(f"Unexpected fake Git read: {args}")

            def fake_archive(argv, **kwargs):
                archive = Path(argv[argv.index("-o") + 1])
                with tarfile.open(archive, "w") as bundle:
                    info = tarfile.TarInfo("uv.lock")
                    info.size = len(lock)
                    bundle.addfile(info, io.BytesIO(lock))

            with patch.object(prepare_image, "git", side_effect=fake_git), \
                    patch.object(prepare_image.subprocess, "run", side_effect=fake_archive):
                record = prepare_image.prepare(source, factory, root / "prepared")
            self.assertEqual((root / "prepared/context/Dockerfile.runtime").read_bytes(), committed)
            self.assertEqual(record["factory_recipe_git_blob_sha256"], hashlib.sha256(committed).hexdigest())
            self.assertEqual((factory / recipe_path).read_bytes(), b"dirty unreviewed working recipe\n")
            for name, blob in committed_files.items():
                self.assertEqual((root / "prepared/context/factory" / name).read_bytes(), blob)
                self.assertEqual(record["context_files"][f"factory/{name}"], hashlib.sha256(blob).hexdigest())
                self.assertEqual((factory / "modal" / name).read_bytes(), working_files[name])

    def test_added_removed_and_symbolic_context_inputs_fail_before_fake_docker(self):
        for change in ("added", "removed", "symbolic"):
            with self.subTest(change=change), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
                root = Path(folder)
                preparation(root)
                file = root / "context/reviewed.txt"
                file.write_bytes(b"pinned")
                inputs = json.loads((root / "inputs.json").read_text())
                inputs["context_files"] = {"reviewed.txt": hashlib.sha256(b"pinned").hexdigest()}
                (root / "inputs.json").write_text(json.dumps(inputs))
                if change == "added":
                    (root / "context/unpinned.py").write_bytes(b"unreviewed")
                elif change == "removed":
                    file.unlink()
                real_is_symlink = Path.is_symlink
                def is_symlink(path):
                    return (change == "symbolic" and path == file) or real_is_symlink(path)
                with patch.object(Path, "is_symlink", is_symlink), \
                        patch.object(local_image, "image_id") as inspect_image, \
                        patch.object(local_image.subprocess, "Popen") as forbidden:
                    with self.assertRaisesRegex(ValueError, "context"):
                        local_image.build(root, compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
                    inspect_image.assert_not_called()
                    forbidden.assert_not_called()

    def test_legacy_qualification_requires_the_retained_metadata_witness_and_output(self):
        for mismatch in ("missing_witness", "metadata_hash", "reference", "output", "valid"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
                root = Path(folder)
                original = {"phase": "closed", "exit_code": 0, "compiler_iid_expected": COMPILER_IID,
                            "compiler_iid_before": COMPILER_IID, "compiler_iid_after": COMPILER_IID,
                            "compiler_tag": COMPILER_TAG, "argv": ["--tag", RUNTIME_TAG], "pid": "fixture-only",
                            "qualification_error": "retained fixture error", "source_commit": "fixture-source",
                            "factory_commit": "fixture-factory"}
                (root / "role-build.process.json").write_text(json.dumps(original))
                metadata = {"buildx.build.ref": "fixture-only", "containerimage.config.digest": RUNTIME_IID,
                            "buildx.build.provenance": {"materials": [{
                                "uri": "pkg:docker/factory-communityai-compiler@test?platform=linux%2Famd64",
                                "digest": {"sha256": "1" * 64}}]}}
                if mismatch == "output":
                    metadata["containerimage.config.digest"] = "sha256:" + "9" * 64
                raw_metadata = json.dumps(metadata).encode()
                (root / "role.metadata.json").write_bytes(raw_metadata)
                (root / "role.iid").write_text(RUNTIME_IID)
                witness = {"metadata_sha256": hashlib.sha256(raw_metadata).hexdigest(),
                           "buildkit_ref": metadata["buildx.build.ref"],
                           "output_config_iid": metadata["containerimage.config.digest"]}
                if mismatch == "metadata_hash":
                    witness["metadata_sha256"] = "0" * 64
                elif mismatch == "reference":
                    witness["buildkit_ref"] = "foreign-build"
                witness_path = root / "separately-retained-witness.json"
                witness_path.write_text(json.dumps(witness))
                arguments = {} if mismatch == "missing_witness" else {"metadata_witness": witness_path}
                binding = {"compiler_tag": COMPILER_TAG, "config_iid": COMPILER_IID,
                           "rootfs_chain_id": "sha256:" + "3" * 64}
                with patch.object(local_image, "compiler_binding", return_value=binding) as inspect_compiler, \
                        patch.object(local_image, "image_id", return_value=RUNTIME_IID) as inspect_runtime:
                    if mismatch == "valid":
                        result = local_image.qualify_existing(root, expected_runtime_iid=RUNTIME_IID, **arguments)
                        self.assertEqual(result["metadata_witness_kind"], "separately_retained_file")
                        self.assertEqual(result["buildkit_metadata_sha256"], witness["metadata_sha256"])
                    else:
                        with self.assertRaises(ValueError):
                            local_image.qualify_existing(root, expected_runtime_iid=RUNTIME_IID, **arguments)
                        inspect_compiler.assert_not_called()
                        inspect_runtime.assert_not_called()
                        self.assertFalse((root / "role-local-qualification.json").exists())

    def test_new_build_keeps_output_witness_when_compiler_guard_fails(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            preparation(root)
            metadata = {"buildx.build.ref": "fixture-only", "containerimage.config.digest": RUNTIME_IID}
            raw_metadata = json.dumps(metadata).encode()
            compiler_reads = 0

            def fake_image_id(tag):
                nonlocal compiler_reads
                if tag == COMPILER_TAG:
                    compiler_reads += 1
                    return COMPILER_IID if compiler_reads == 1 else "sha256:" + "9" * 64
                return RUNTIME_IID

            def fake_popen(*args, **kwargs):
                (root / "role.metadata.json").write_bytes(raw_metadata)
                (root / "role.iid").write_text(RUNTIME_IID)
                return type("FakeDocker", (), {"pid": "fixture-only", "wait": lambda self: 0})()

            with patch.object(local_image, "image_id", side_effect=fake_image_id), \
                    patch.object(local_image.subprocess, "Popen", side_effect=fake_popen), \
                    redirect_stdout(io.StringIO()):
                result = local_image.build(root, compiler_tag=COMPILER_TAG, compiler_iid=COMPILER_IID, runtime_tag=RUNTIME_TAG)
            self.assertEqual(result["exit_code"], 0)
            self.assertIn("compiler tag changed", result["qualification_error"])
            self.assertEqual(result["buildkit_metadata_sha256"], hashlib.sha256(raw_metadata).hexdigest())
            self.assertEqual(result["buildkit_ref"], "fixture-only")
            self.assertEqual(result["buildkit_output_config_iid"], RUNTIME_IID)
            self.assertEqual(result["runtime_iid"], RUNTIME_IID)


if __name__ == "__main__":
    unittest.main()
