"""Check the fixed snapshot in a network-disabled Linux container; no model loads.

The caller mounts the already verified model snapshot read-only and supplies
separate writable scratch. Successful hashing and rejected constructors are
local image evidence, not a remote Volume, GPU, inference or admission grant.
"""

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid

from drift.artifact_snapshot import validate_artifact_snapshot
from drift.model_manifest import ManifestArtifactVerifier, ManifestError, ModelManifest
from drift.node.loading import make_manifest_loader
from drift.server.server import Server
from drift.utils.disk_cache import allow_cache_reads
import communityai_bootstrap
import communityai_runtime


def generation(path):
    item = path.lstat()
    return [item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            item.st_ctime_ns, item.st_mode, item.st_nlink]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    args = parser.parse_args()
    root, cache = args.artifact_root.resolve(strict=True), args.cache_dir.resolve()
    assert os.name == "posix" and os.statvfs(root).f_flag & os.ST_RDONLY
    assert communityai_runtime.SOURCE_COMMIT == "681deb528a2d83a354a991a032c6ffa8d14a4242"
    manifest_path = Path(communityai_bootstrap.RUNTIME_MANIFEST)
    assert hashlib.sha256(manifest_path.read_bytes()).hexdigest() == communityai_bootstrap.MANIFEST_RAW_SHA256
    manifest = ModelManifest.load(manifest_path)
    assert manifest.digest_id == communityai_bootstrap.MANIFEST_DIGEST
    expected = sorted(artifact.path for artifact in manifest.artifacts)
    assert sorted(path.name for path in root.iterdir()) == expected
    before = {name: generation(root / name) for name in expected}
    assert all((root / name).is_file() and not (root / name).is_symlink()
               and before[name][-1] == 1 for name in expected)

    probe = root / (".factory-write-probe-" + uuid.uuid4().hex)
    try:
        with probe.open("xb"):
            pass
    except OSError as exc:
        assert exc.errno == errno.EROFS, "Snapshot write refusal must be the read-only mount"
    else:
        probe.unlink()
        raise AssertionError("Snapshot mount is writable")

    cache.mkdir(parents=True, exist_ok=False)
    assert validate_artifact_snapshot(manifest, root, cache_dir=cache) == root
    verifier = ManifestArtifactVerifier(manifest, repository=manifest.source.repository,
                                        revision=manifest.source.revision, artifact_root=root,
                                        cache_dir=str(cache), cache_only=True)
    verifier.ensure_startup_metadata(include_tokenizer=True)
    with allow_cache_reads(str(cache)):
        assert (cache / "blocks.lock").is_file()
    assert not (root / "blocks.lock").exists()

    rejected = []
    with tempfile.TemporaryDirectory(dir=cache) as folder:
        fixtures = Path(folder)
        for kind, expected_error in (("missing", "Could not read artifact config.json"),
                                     ("corrupt", "Artifact config.json has size"),
                                     ("sidecar", "Undeclared artifact snapshot file"),
                                     ("link", "links or reparse points")):
            bad = fixtures / kind
            bad.mkdir()
            if kind == "corrupt":
                (bad / "config.json").write_bytes(b"invalid")
            elif kind == "sidecar":
                (bad / "undeclared.json").write_bytes(b"{}")
            elif kind == "link":
                (bad / "config.json").symlink_to(root / "config.json")
            for constructor in ("worker", "text_loader"):
                scratch = fixtures / (kind + "-" + constructor + "-cache")
                try:
                    if constructor == "worker":
                        Server(initial_peers=[], dht_prefix=manifest.dht_prefix,
                               converted_model_name_or_path=manifest.source.repository,
                               throughput=0.01, block_indices="0:14", device="cpu",
                               model_manifest=manifest, artifact_root=bad, cache_dir=str(scratch))
                    else:
                        make_manifest_loader(manifest, initial_peers=[], artifact_root=str(bad),
                                             cache_dir=str(scratch))()
                except ManifestError as exc:
                    assert expected_error in str(exc), str(exc)
                    rejected.append({"case": kind, "constructor": constructor,
                                     "exception": type(exc).__name__, "message": str(exc)})
                else:
                    raise AssertionError("Invalid snapshot passed an actual constructor")
                assert not scratch.exists(), "Rejected constructor wrote its scratch directory"

    after = {name: generation(root / name) for name in expected}
    assert before == after and sorted(path.name for path in root.iterdir()) == expected
    print(json.dumps({"scope": "local_read_only_snapshot_and_rejected_loader_constructors",
                      "source_commit": communityai_runtime.SOURCE_COMMIT,
                      "manifest_digest": manifest.digest_id, "artifact_root": str(root),
                      "cache_dir": str(cache), "verified_files": len(expected),
                      "verified_bytes": sum(artifact.size for artifact in manifest.artifacts),
                      "read_only_mount_verified": True, "writable_blocks_lock_verified": True,
                      "snapshot_generation_unchanged": True, "rejected": rejected,
                      "model_loaded": False, "inference_verified": False,
                      "remote_volume_verified": False, "admission": "NO_ADMISSION"}), flush=True)


if __name__ == "__main__":
    main()
