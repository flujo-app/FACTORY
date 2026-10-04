"""Build one prepared role image with an explicitly checked local tag/IID binding.

This local-only path neither weakens the deployment helper's registry digest
contract nor makes the tag immutable. It requires the same compiler image ID
before and after build and the actual BuildKit material identity. Classic Docker
can emit the inspected rootfs chain ID rather than the image config ID. Both
remain separate from a registry manifest digest. No push or role
start is performed. A caller's observation timeout is not build completion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def image_id(tag):
    result = subprocess.run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


def verify_context(context, recorded_files):
    """Require the whole current context, without links or extra file inputs."""
    context = Path(context)
    pending = [context]
    actual = {}
    while pending:
        path = pending.pop()
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError("Prepared context contains a symbolic link or junction")
        if path.is_file():
            relative = path.relative_to(context).as_posix()
            actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif path.is_dir():
            pending.extend(path.iterdir())
        else:
            raise ValueError("Prepared context contains an unsupported file type")
    if set(actual) != set(recorded_files):
        raise ValueError("Prepared context file set differs from the complete retained input set")
    for relative, expected in recorded_files.items():
        if actual[relative] != expected:
            raise ValueError(f"Prepared input changed: {relative}")


def compiler_binding(tag, expected_iid):
    """One actual local image inspection binds its config and ordered rootfs."""
    result = subprocess.run(["docker", "image", "inspect", tag, "--format", "{{json .}}"],
                            check=True, capture_output=True, text=True)
    image = json.loads(result.stdout)
    if image["Id"] != expected_iid or image["Os"] != "linux" or image["Architecture"] != "amd64":
        raise ValueError("Actual local compiler image differs from the retained Linux amd64 image")
    rootfs = image["RootFS"]
    layers = rootfs.get("Layers", [])
    if rootfs["Type"] != "layers" or not layers or any(re.fullmatch(r"sha256:[0-9a-f]{64}", item) is None for item in layers):
        raise ValueError("Exact ordered compiler diff IDs are required")
    chain = layers[0]
    for diff_id in layers[1:]:
        chain = "sha256:" + hashlib.sha256((chain + " " + diff_id).encode()).hexdigest()
    return {"compiler_tag": tag, "config_iid": image["Id"], "rootfs_diff_ids": layers,
            "rootfs_chain_id": chain, "repo_digests": image["RepoDigests"],
            "descriptor": image.get("Descriptor"), "architecture": image["Architecture"], "os": image["Os"]}


def verify_material(materials, binding):
    expected_uri = "pkg:docker/" + binding["compiler_tag"].replace(":", "@") + "?platform=linux%2Famd64"
    matches = [item for item in materials if item["uri"] == expected_uri]
    if len(matches) != 1:
        raise ValueError("The exact owned compiler material URI is required once")
    reported = "sha256:" + matches[0]["digest"]["sha256"]
    if reported == binding["config_iid"]:
        kind = "config_image_id"
    elif reported == binding["rootfs_chain_id"]:
        kind = "classic_docker_rootfs_chain_id"
    else:
        raise ValueError("BuildKit compiler material matches neither actual image config nor rootfs chain")
    return {"material": matches[0], "identity_kind": kind, "reported_digest": reported}


def qualify_existing(prepared, *, expected_runtime_iid, metadata_witness=None):
    """Qualify retained facts separately; never edits/restarts the build receipt."""
    prepared = Path(prepared).resolve()
    target = prepared / "role-local-qualification.json"
    if target.exists():
        raise ValueError("Existing immutable qualification result must be read")
    original_path = prepared / "role-build.process.json"
    raw_original = original_path.read_bytes()
    original = json.loads(raw_original)
    if original["phase"] != "closed" or original["exit_code"] != 0:
        raise ValueError("An actually completed successful Docker build is required")
    expected_compiler = original["compiler_iid_expected"]
    if original["compiler_iid_before"] != expected_compiler or original["compiler_iid_after"] != expected_compiler:
        raise ValueError("Retained compiler binding differed before/after the original build")
    raw_metadata = (prepared / "role.metadata.json").read_bytes()
    metadata = json.loads(raw_metadata)
    actual_metadata_sha = hashlib.sha256(raw_metadata).hexdigest()
    fields = ("buildkit_metadata_sha256", "buildkit_ref", "buildkit_output_config_iid")
    if all(field in original for field in fields):
        witness = {"metadata_sha256": original[fields[0]], "buildkit_ref": original[fields[1]],
                   "output_config_iid": original[fields[2]]}
        witness_kind, witness_sha, witness_path = "original_build_record", hashlib.sha256(raw_original).hexdigest(), None
    elif any(field in original for field in fields):
        raise ValueError("Original build record has an incomplete metadata witness")
    else:
        if metadata_witness is None:
            raise ValueError("Legacy build requires an explicit separately retained metadata witness file")
        witness_path = str(Path(metadata_witness).resolve())
        raw_witness = Path(witness_path).read_bytes()
        witness = json.loads(raw_witness)
        witness_kind, witness_sha = "separately_retained_file", hashlib.sha256(raw_witness).hexdigest()
    if set(witness) != {"metadata_sha256", "buildkit_ref", "output_config_iid"}:
        raise ValueError("Exact metadata witness fields are required")
    if witness["metadata_sha256"] != actual_metadata_sha:
        raise ValueError("BuildKit metadata bytes differ from the retained witness")
    if witness["buildkit_ref"] != metadata["buildx.build.ref"]:
        raise ValueError("BuildKit reference differs from the retained witness")
    output_config_iid = metadata["containerimage.config.digest"]
    if witness["output_config_iid"] != output_config_iid or output_config_iid != expected_runtime_iid:
        raise ValueError("BuildKit output config differs from the expected runtime IID or retained witness")
    if "runtime_iid" in original and original["runtime_iid"] != expected_runtime_iid:
        raise ValueError("Original build output differs from the expected runtime IID")
    binding = compiler_binding(original["compiler_tag"], expected_compiler)
    material = verify_material(metadata["buildx.build.provenance"]["materials"], binding)
    runtime_tag = original["argv"][original["argv"].index("--tag") + 1]
    retained_iid = (prepared / "role.iid").read_text().strip()
    if retained_iid != expected_runtime_iid or image_id(runtime_tag) != expected_runtime_iid:
        raise ValueError("The actual existing role image differs from the retained build result")
    final_binding = compiler_binding(original["compiler_tag"], expected_compiler)
    if final_binding != binding:
        raise ValueError("Local compiler inspection changed during qualification")
    record = {"scope": "existing_local_image_material_qualification_only",
              "qualification_process_pid": os.getpid(),
              "original_build_pid": original["pid"], "original_build_exit_code": original["exit_code"],
              "original_qualification_error_retained": original["qualification_error"],
              "original_build_receipt_sha256": hashlib.sha256(raw_original).hexdigest(),
              "buildkit_metadata_sha256": actual_metadata_sha, "buildkit_output_config_iid": output_config_iid,
              "metadata_witness_kind": witness_kind, "metadata_witness_sha256": witness_sha,
              "metadata_witness_path": witness_path,
              "buildkit_ref": metadata["buildx.build.ref"], "compiler_binding": binding,
              "compiler_material": material, "runtime_tag": runtime_tag, "runtime_iid": expected_runtime_iid,
              "source_commit": original["source_commit"], "factory_commit": original["factory_commit"],
              "local_material_qualified": True, "registry_digest_qualified": False,
              "portable_rebuild_qualified": False, "imports_verified": False,
              "inference_verified": False, "deployment_verified": False}
    with target.open("x", encoding="utf-8") as result_file:
        result_file.write(json.dumps(record, indent=2) + "\n")
    return record


def build(prepared, *, compiler_tag, compiler_iid, runtime_tag):
    prepared = Path(prepared).resolve()
    for tag in (compiler_tag, runtime_tag):
        if re.fullmatch(r"factory-communityai-[a-z0-9-]+:[a-z0-9-]+", tag) is None:
            raise ValueError("An explicit owned local Factory image tag is required")
    if compiler_tag == runtime_tag:
        raise ValueError("Compiler and role image tags must be distinct")
    if re.fullmatch(r"sha256:[0-9a-f]{64}", compiler_iid) is None:
        raise ValueError("An exact retained local compiler image ID is required")
    inputs = json.loads((prepared / "inputs.json").read_text())
    context = prepared / "context"
    verify_context(context, inputs["context_files"])
    if inputs["factory_runtime_source_label"] != inputs["source_commit"]:
        raise ValueError("Reviewed Factory runtime label must match the exported source")
    before = image_id(compiler_tag)
    if before != compiler_iid:
        raise ValueError("Owned local compiler tag differs from the retained image ID")
    record_path = prepared / "role-build.process.json"
    if record_path.exists():
        raise ValueError("Existing build handle must be observed; do not restart this preparation")
    argv = ["docker", "buildx", "build", "--platform", "linux/amd64", "--load",
            "--file", str(context / "Dockerfile.runtime"),
            "--build-arg", f"BUILD_RUNTIME_IMAGE={compiler_tag}",
            "--label", f"org.opencontainers.image.revision={inputs['source_commit']}",
            "--label", f"factory.local-compiler-iid={compiler_iid}",
            "--tag", runtime_tag, "--iidfile", str(prepared / "role.iid"),
            "--metadata-file", str(prepared / "role.metadata.json"), "--progress", "plain", str(context)]
    record = {"scope": "local_role_image_build_only", "argv": argv,
              "source_commit": inputs["source_commit"], "factory_commit": inputs["factory_commit"],
              "compiler_tag": compiler_tag, "compiler_iid_expected": compiler_iid,
              "compiler_iid_before": before, "compiler_iid_after": None,
              "compiler_reference_kind": "local_tag_with_checked_IID_binding",
              "registry_digest_qualified": False, "portable_rebuild_qualified": False,
              "deployment_verified": False, "phase": "intent", "pid": None,
              "started_at_unix": time.time(), "exit_code": None, "qualification_error": None}

    def retain():
        # Prepare a complete replacement beside the exclusively reserved
        # receipt. An interrupted write leaves the prior receipt readable.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=prepared,
                                         prefix=record_path.name + ".", suffix=".tmp", delete=False) as replacement:
            replacement.write(json.dumps(record, indent=2) + "\n")
            replacement.flush()
            os.fsync(replacement.fileno())
        # Close the temporary handle before replacement, including on Windows.
        # A failed preparation leaves its owned temp file for inspection.
        os.replace(replacement.name, record_path)

    # Reserve this preparation before any Docker build starts. A stale exists()
    # observation cannot let another owner replace the intent or replay it.
    with record_path.open("x", encoding="utf-8") as intent_file:
        intent_file.write(json.dumps(record, indent=2) + "\n")
    with (prepared / "role-build.log").open("xb") as log:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        record.update(phase="running", pid=child.pid)
        retain()
        print(json.dumps({"pid": child.pid, "record": str(record_path)}), flush=True)
        # This waits on the same build handle. External observation deadlines do
        # not silently kill/restart the underlying Docker/BuildKit operation.
        record["exit_code"] = child.wait()
    record.update(phase="closed", closed_at_unix=time.time())
    retain()
    if record["exit_code"] == 0:
        try:
            raw_metadata = (prepared / "role.metadata.json").read_bytes()
            record["buildkit_metadata_sha256"] = hashlib.sha256(raw_metadata).hexdigest()
            metadata = json.loads(raw_metadata)
            record["buildkit_ref"] = metadata["buildx.build.ref"]
            record["buildkit_output_config_iid"] = metadata["containerimage.config.digest"]
            record["runtime_iid"] = (prepared / "role.iid").read_text().strip()
            # Output facts survive a later compiler/material qualification error.
            retain()
            if record["buildkit_output_config_iid"] != record["runtime_iid"]:
                raise ValueError("BuildKit output config differs from the retained role image IID")
            if image_id(runtime_tag) != record["runtime_iid"]:
                raise ValueError("Owned role image tag differs from the build result")
            record["compiler_iid_after"] = image_id(compiler_tag)
            if record["compiler_iid_after"] != compiler_iid:
                raise ValueError("Owned compiler tag changed during build")
            materials = metadata["buildx.build.provenance"]["materials"]
            record["buildkit_materials"] = materials
            record["compiler_binding"] = compiler_binding(compiler_tag, compiler_iid)
            record["compiler_material"] = verify_material(materials, record["compiler_binding"])
        except Exception as exc:
            record["qualification_error"] = f"{type(exc).__name__}: {exc}"
        retain()
    print(json.dumps(record), flush=True)
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", required=True)
    parser.add_argument("--compiler-tag", required=True)
    parser.add_argument("--compiler-iid", required=True)
    parser.add_argument("--runtime-tag", required=True)
    result = build(**vars(parser.parse_args()))
    raise SystemExit(result["exit_code"] or bool(result["qualification_error"]))
