"""Offline byte-scanner fixtures; no real weights or model success are qualified."""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("offline_model_artifacts", HERE / "model_artifacts.py")
artifacts = importlib.util.module_from_spec(spec)
with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden in offline tests")):
    spec.loader.exec_module(artifacts)
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def fixture_entry(name, raw):
    # This helper-only manifest is deliberately unrelated to actual weight bytes.
    if name in artifacts._SHARDS:
        algorithm, digest = "sha256", hashlib.sha256(raw).hexdigest()
    else:
        algorithm = "git-blob-sha1"
        digest = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
    return {"name": name, "size": len(raw), "algorithm": algorithm, "digest": digest}


class ModelArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="factory-model-artifact-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.directory = self.base / artifacts.REVISION
        self.directory.mkdir()
        self.index = {"name": "model.safetensors.index.json", "totalSize": 256,
                      "tensorCount": 4, "shards": list(artifacts._SHARDS)}
        self.contents = {name: ("synthetic-fixture-only:" + name).encode()
                         for name in artifacts._REQUIRED_FILES}
        self.replace_index({"metadata": {"total_size": 256},
                            "weight_map": {f"fixture.tensor.{number}": name
                                           for number, name in enumerate(artifacts._SHARDS)}})
        self.entries = [fixture_entry(name, self.contents[name])
                        for name in sorted(self.contents)]
        for name, raw in self.contents.items():
            (self.directory / name).write_bytes(raw)

    def replace_index(self, value):
        self.contents[self.index["name"]] = encoded(value)

    def write_index(self, raw):
        (self.directory / self.index["name"]).write_bytes(raw)
        self.entries = [fixture_entry(entry["name"], raw) if entry["name"] == self.index["name"] else entry
                        for entry in self.entries]

    def scan_fixture(self):
        return artifacts._verify_files(self.directory, self.entries, self.index)

    def public_failure(self, function, *args):
        captured = io.StringIO()
        with redirect_stdout(captured), redirect_stderr(captured), self.assertRaises(artifacts.ModelArtifactError) as raised:
            function(*args)
        self.assertEqual(str(raised.exception), "Pinned model artifacts are unavailable or invalid.")
        self.assertEqual(raised.exception.code, "MODEL_ARTIFACTS_UNAVAILABLE")
        self.assertIsNone(raised.exception.__context__)
        self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(captured.getvalue(), "")
        self.assertNotIn(str(self.base), str(raised.exception))

    def symlink(self, target, link, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (NotImplementedError, OSError) as error:
            if isinstance(error, NotImplementedError) or getattr(error, "winerror", None) == 1314:
                self.skipTest("This OS account cannot create a symlink fixture")
            raise

    def test_fixed_manifest_exact_revision_license_files_and_authoritative_digests(self):
        raw = (HERE / "model-artifacts.json").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), artifacts.MANIFEST_SHA256)
        manifest = artifacts._manifest(CONFIG)
        self.assertEqual(manifest["model"], "Qwen/Qwen2.5-Coder-7B-Instruct")
        self.assertEqual(manifest["revision"], "c03e6d358207e414f1eca0bb1891e29f1db0e242")
        self.assertEqual(manifest["license"], "Apache-2.0")
        self.assertEqual(len(manifest["files"]), 13)
        self.assertEqual(sum(row["size"] for row in manifest["files"]), 15242805878)
        shards = [row for row in manifest["files"] if row["name"] in artifacts._SHARDS]
        self.assertEqual(sum(row["size"] for row in shards), 15231271864)
        self.assertTrue(all(row["algorithm"] == "sha256" and len(row["digest"]) == 64 for row in shards))
        self.assertTrue(all(row["algorithm"] == "git-blob-sha1" for row in manifest["files"] if row["name"] not in artifacts._SHARDS))
        self.assertEqual(manifest["index"], {"name": "model.safetensors.index.json",
                         "totalSize": 15231233024, "tensorCount": 339, "shards": list(artifacts._SHARDS)})

    def test_expected_receipt_is_closed_source_bound_metadata_without_weight_validation(self):
        with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden")), \
             patch.object(artifacts, "_verify_files", side_effect=AssertionError("Expected metadata must not scan model files")):
            proof = artifacts.expected_artifact_proof(CONFIG)
        self.assertEqual(set(proof), {"schemaVersion", "manifestSha256", "validatorSha256", "model", "revision",
                                    "license", "fileCount", "shardCount", "verifiedBytes", "tensorBytes"})
        self.assertEqual(proof["validatorSha256"], hashlib.sha256((HERE / "model_artifacts.py").read_bytes()).hexdigest())
        self.assertEqual(proof["manifestSha256"], artifacts.MANIFEST_SHA256)
        self.assertEqual((proof["fileCount"], proof["shardCount"], proof["verifiedBytes"], proof["tensorBytes"]),
                         (13, 4, 15242805878, 15231233024))

    def test_wrong_model_revision_or_license_has_only_generic_public_failure(self):
        for key in ("model", "revision", "license"):
            with self.subTest(key=key):
                config = {**CONFIG, key: "private-wrong-value"}
                self.public_failure(artifacts.validate_model_artifacts, self.directory, config)
                self.public_failure(artifacts.expected_artifact_proof, config)

    def test_wrong_directory_revision_and_relative_paths_are_refused(self):
        self.public_failure(artifacts.validate_model_artifacts, self.base, CONFIG)
        self.public_failure(artifacts.validate_model_artifacts, Path(artifacts.REVISION), CONFIG)

    def test_actual_pinned_manifest_cannot_accept_tiny_synthetic_weights(self):
        self.public_failure(artifacts.validate_model_artifacts, self.directory, CONFIG)
        manifest = artifacts._manifest(CONFIG)
        for shard in artifacts._SHARDS:
            with self.subTest(shard=shard), self.assertRaises(artifacts._InvalidArtifact):
                # Exercise each real LFS size guard, independently of other fixtures.
                artifacts._stream_file(self.directory, next(row for row in manifest["files"] if row["name"] == shard))

    def test_fake_hub_metadata_cannot_replace_missing_actual_artifacts(self):
        for name in self.contents:
            (self.directory / name).unlink()
        metadata = self.directory / ".cache" / "huggingface" / "download"
        metadata.mkdir(parents=True)
        (metadata / "complete.metadata").write_text("claim: weights-cached", encoding="utf-8")
        self.public_failure(artifacts.validate_model_artifacts, self.directory, CONFIG)

    def test_manifest_extra_field_or_changed_digest_cannot_override_fixed_source_pin(self):
        modified = self.base / "model-artifacts.json"
        manifest = json.loads((HERE / "model-artifacts.json").read_bytes())
        for alteration in (lambda value: value.update({"privateExtra": "private-marker"}),
                           lambda value: value["files"][0].update({"digest": "0" * 40})):
            candidate = json.loads(json.dumps(manifest))
            alteration(candidate)
            modified.write_bytes(encoded(candidate))
            with patch.object(artifacts, "_MANIFEST_PATH", modified):
                self.public_failure(artifacts.expected_artifact_proof, CONFIG)

    def test_helper_source_changed_after_import_is_not_reported_as_original_executing_code(self):
        modified = self.base / "model_artifacts.py"
        modified.write_bytes((HERE / "model_artifacts.py").read_bytes() + b"\n# changed source\n")
        with patch.object(artifacts, "_VALIDATOR_PATH", modified):
            self.public_failure(artifacts.expected_artifact_proof, CONFIG)

    def test_fixture_scanner_accepts_exact_synthetic_bytes_and_ignores_legitimate_extras(self):
        metadata = self.directory / ".cache" / "huggingface"
        metadata.mkdir(parents=True)
        (metadata / "download.metadata").write_text("synthetic incomplete metadata", encoding="utf-8")
        (self.directory / "unrelated.incomplete").write_bytes(b"ignored-extra")
        self.assertEqual(self.scan_fixture(), sum(len(raw) for raw in self.contents.values()))

    def test_fixture_missing_each_required_artifact_is_refused(self):
        for name, raw in self.contents.items():
            with self.subTest(name=name):
                (self.directory / name).unlink()
                with self.assertRaises((artifacts._InvalidArtifact, FileNotFoundError)):
                    self.scan_fixture()
                (self.directory / name).write_bytes(raw)

    def test_fixture_truncated_or_oversized_shard_is_refused_before_hash_read(self):
        name = artifacts._SHARDS[0]
        entry = next(row for row in self.entries if row["name"] == name)
        for raw in (self.contents[name][:-1], self.contents[name] + b"x"):
            (self.directory / name).write_bytes(raw)
            with patch.object(artifacts.os, "read", side_effect=AssertionError("Wrong size must fail before reading")), \
                 self.assertRaises(artifacts._InvalidArtifact):
                artifacts._stream_file(self.directory, entry)

    def test_fixture_same_size_hash_corruption_is_refused(self):
        for name, original in self.contents.items():
            with self.subTest(name=name):
                (self.directory / name).write_bytes(bytes([original[0] ^ 1]) + original[1:])
                with self.assertRaises(artifacts._InvalidArtifact):
                    self.scan_fixture()
                (self.directory / name).write_bytes(original)

    def test_git_blob_hash_includes_header_and_rejects_plain_content_sha1(self):
        entry = next(row for row in self.entries if row["name"] == "config.json")
        wrong = {**entry, "digest": hashlib.sha1(self.contents["config.json"]).hexdigest()}
        with self.assertRaises(artifacts._InvalidArtifact):
            artifacts._stream_file(self.directory, wrong)

    def test_fresh_regular_file_named_and_descriptor_stats_agree_without_windows_ctime_guessing(self):
        entry = next(row for row in self.entries if row["name"] == "config.json")
        identity, raw = artifacts._stream_file(self.directory, entry, capture_limit=4096)
        self.assertEqual(raw, self.contents["config.json"])
        self.assertEqual(identity, artifacts._file_identity((self.directory / "config.json").lstat()))

    def test_fixture_reads_are_sequential_at_most_one_mib_without_read_bytes(self):
        name = artifacts._SHARDS[0]
        raw = b"fixture-block:" * (artifacts.MAX_READ_BYTES // 14 * 3) + b"tail"
        (self.directory / name).write_bytes(raw)
        self.entries = [fixture_entry(name, raw) if row["name"] == name else row for row in self.entries]
        requests, positions = [], []
        real_read = os.read
        def bounded_read(descriptor, size):
            requests.append(size)
            positions.append((descriptor, os.lseek(descriptor, 0, os.SEEK_CUR)))
            return real_read(descriptor, size)
        with patch.object(artifacts.os, "read", side_effect=bounded_read), \
             patch.object(Path, "read_bytes", side_effect=AssertionError("Unbounded read forbidden")), \
             patch.object(Path, "read_text", side_effect=AssertionError("Unbounded read forbidden")):
            self.scan_fixture()
        self.assertTrue(requests and all(0 < size <= 1024 * 1024 for size in requests))
        self.assertGreaterEqual(requests.count(1024 * 1024), 2)
        self.assertTrue(any(position >= 2 * 1024 * 1024 for _, position in positions))

    def test_fixture_growth_while_hashing_is_refused(self):
        entry = next(row for row in self.entries if row["name"] == artifacts._SHARDS[0])
        real_read, changed = os.read, False
        def grow(descriptor, size):
            nonlocal changed
            result = real_read(descriptor, size)
            if not changed:
                changed = True
                with (self.directory / entry["name"]).open("ab") as target:
                    target.write(b"growth")
            return result
        with patch.object(artifacts.os, "read", side_effect=grow), self.assertRaises(artifacts._InvalidArtifact):
            artifacts._stream_file(self.directory, entry)

    def test_fixture_mutation_after_earlier_file_hash_is_refused_at_final_identity_check(self):
        target = self.directory / "LICENSE"
        real_stream, calls = artifacts._stream_file, 0
        def mutate(*args, **kwargs):
            nonlocal calls
            result = real_stream(*args, **kwargs)
            calls += 1
            if calls == 2:
                target.write_bytes(b"x" * len(self.contents["LICENSE"]))
            return result
        with patch.object(artifacts, "_stream_file", side_effect=mutate), self.assertRaises(artifacts._InvalidArtifact):
            self.scan_fixture()

    def test_fixture_named_file_replacement_after_hash_is_refused(self):
        target = self.directory / "LICENSE"
        replacement = self.directory / "replacement-fixture"
        replacement.write_bytes(self.contents["LICENSE"])
        real_stream, replaced = artifacts._stream_file, False
        def replace(*args, **kwargs):
            nonlocal replaced
            result = real_stream(*args, **kwargs)
            if not replaced:
                replaced = True
                os.replace(replacement, target)
            return result
        with patch.object(artifacts, "_stream_file", side_effect=replace), self.assertRaises(artifacts._InvalidArtifact):
            self.scan_fixture()

    def test_fixture_required_file_symlink_is_refused(self):
        target = self.directory / "LICENSE"
        original = self.base / "original-license"
        target.rename(original)
        self.symlink(original, target)
        with self.assertRaises(artifacts._InvalidArtifact):
            self.scan_fixture()

    def test_fixture_directory_and_parent_symlinks_are_refused(self):
        link = self.base / "model-link"
        self.symlink(self.directory, link, directory=True)
        with self.assertRaises(artifacts._InvalidArtifact):
            artifacts._verify_files(link, self.entries, self.index)
        parent_link = self.base / "parent-link"
        self.symlink(self.base, parent_link, directory=True)
        with self.assertRaises(artifacts._InvalidArtifact):
            artifacts._verify_files(parent_link / artifacts.REVISION, self.entries, self.index)

    def test_fixture_hardlink_and_nonregular_artifact_are_refused(self):
        target = self.directory / "LICENSE"
        os.link(target, self.base / "license-hardlink")
        with self.assertRaises(artifacts._InvalidArtifact):
            self.scan_fixture()
        (self.base / "license-hardlink").unlink()
        target.unlink()
        target.mkdir()
        with self.assertRaises(artifacts._InvalidArtifact):
            self.scan_fixture()

    def test_fixture_unsafe_index_references_are_refused_even_with_matching_fixture_digest(self):
        for filename in ("../outside.safetensors", "nested/file.safetensors", "C:\\secret", "/absolute", "bad\0name"):
            with self.subTest(filename=filename):
                value = {"metadata": {"total_size": 256},
                         "weight_map": {f"fixture.tensor.{number}": name for number, name in enumerate(artifacts._SHARDS)}}
                value["weight_map"]["fixture.tensor.0"] = filename
                self.write_index(encoded(value))
                with self.assertRaises(artifacts._InvalidArtifact):
                    self.scan_fixture()

    def test_fixture_index_requires_exact_all_shard_refs_tensor_count_and_total_size(self):
        baseline = {"metadata": {"total_size": 256},
                    "weight_map": {f"fixture.tensor.{number}": name for number, name in enumerate(artifacts._SHARDS)}}
        modifications = [lambda v: v["weight_map"].update({"fixture.tensor.0": artifacts._SHARDS[1]}),
                         lambda v: v["weight_map"].pop("fixture.tensor.0"),
                         lambda v: v["metadata"].update({"total_size": 255}),
                         lambda v: v["metadata"].update({"total_size": True}),
                         lambda v: v.update({"extra": "private-marker"})]
        for mutate in modifications:
            candidate = json.loads(json.dumps(baseline))
            mutate(candidate)
            self.write_index(encoded(candidate))
            with self.assertRaises(artifacts._InvalidArtifact):
                self.scan_fixture()

    def test_fixture_index_duplicate_keys_nonfinite_values_and_overflow_are_refused(self):
        for raw in (b'{"metadata":{"total_size":256,"total_size":256},"weight_map":{}}',
                    b'{"metadata":{"total_size":NaN},"weight_map":{}}',
                    b'x' * (artifacts.MAX_INDEX_BYTES + 1)):
            self.write_index(raw)
            with self.assertRaises(artifacts._InvalidArtifact):
                self.scan_fixture()

    def test_import_has_no_cloud_dependency_or_network_and_public_failure_has_no_raw_path(self):
        fresh_spec = importlib.util.spec_from_file_location("second_offline_model_artifacts", HERE / "model_artifacts.py")
        fresh = importlib.util.module_from_spec(fresh_spec)
        with patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden")):
            fresh_spec.loader.exec_module(fresh)
            self.assertEqual(fresh.expected_artifact_proof(CONFIG)["manifestSha256"], artifacts.MANIFEST_SHA256)
            with self.assertRaises(fresh.ModelArtifactError) as raised:
                fresh.validate_model_artifacts(self.base / "private-marker" / artifacts.REVISION, CONFIG)
        self.assertNotIn("private-marker", str(raised.exception))
        self.assertNotIn(str(self.base), str(raised.exception))


if __name__ == "__main__":
    unittest.main()
