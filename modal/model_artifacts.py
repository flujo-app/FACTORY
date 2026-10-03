"""Verify this pinned model's bytes without loading tensors or contacting a service.

Each scan reads all required artifacts sequentially, using at most 1 MiB per
read. Its wall time and IO cost are unmeasured. Validation is a point-in-time
filesystem check: vLLM's later independent opens are not an atomic transaction
with this scan. Call immediately before use; do not permit concurrent writers.
"""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat


MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
REVISION = "c03e6d358207e414f1eca0bb1891e29f1db0e242"
LICENSE = "Apache-2.0"
MANIFEST_SHA256 = "ea5fea61938c24162b0a0735f0dfe42a0fc750ea5566b47f377caba57aff71e5"
MAX_READ_BYTES = 1024 * 1024
MAX_INDEX_BYTES = 64 * 1024
MAX_MANIFEST_BYTES = 16 * 1024
MAX_VALIDATOR_BYTES = 128 * 1024
_VALIDATOR_PATH = Path(__file__).absolute()
_MANIFEST_PATH = _VALIDATOR_PATH.with_name("model-artifacts.json")
_SHARDS = tuple(f"model-{number:05d}-of-00004.safetensors" for number in range(1, 5))
_REQUIRED_FILES = frozenset(("LICENSE", "README.md", "config.json",
                           "generation_config.json", "merges.txt",
                           "model.safetensors.index.json", "tokenizer.json",
                           "tokenizer_config.json", "vocab.json", *_SHARDS))
_OPEN_FLAGS = (os.O_RDONLY | getattr(os, "O_BINARY", 0)
               | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
               | getattr(os, "O_NONBLOCK", 0))


class ModelArtifactError(RuntimeError):
    """Public failure contains no paths, artifact content, or underlying error."""

    code = "MODEL_ARTIFACTS_UNAVAILABLE"

    def __init__(self):
        super().__init__("Pinned model artifacts are unavailable or invalid.")


class _InvalidArtifact(Exception):
    pass


def _require(value):
    if not value:
        raise _InvalidArtifact()


def _integer(value, minimum=0):
    _require(type(value) is int and minimum <= value <= 2**53 - 1)
    return value


def _object(value, keys):
    _require(type(value) is dict and set(value) == set(keys))
    return value


def _json(raw):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result)
            result[key] = value
        return result

    def invalid_constant(_):
        raise _InvalidArtifact()

    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs,
                      parse_constant=invalid_constant)


def _filename(name):
    _require(type(name) is str and 1 <= len(name) <= 100
             and name not in (".", "..")
             and not any(character in name for character in "/\\:\0"))
    return name


def _not_link(info):
    _require(not stat.S_ISLNK(info.st_mode)
             and not (getattr(info, "st_file_attributes", 0)
                      & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))


def _regular(info):
    _not_link(info)
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)


def _file_identity(info):
    # Windows Python 3.13 can report different st_ctime semantics for named
    # versus descriptor stats. Birth time agrees across both; POSIX retains
    # change-time detection in addition to modification time and identity.
    secondary_time = (getattr(info, "st_birthtime_ns", None) if os.name == "nt"
                      else info.st_ctime_ns)
    return tuple(getattr(info, name) for name in
                 ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns",
                  "st_nlink", "st_uid")) + (secondary_time,)


def _directory_identity(info):
    # Extra Hub metadata can legitimately change a directory's timestamps.
    return (info.st_dev, info.st_ino, info.st_mode)


def _directories(directory):
    directory = Path(directory)
    _require(directory.is_absolute() and ".." not in directory.parts)
    paths = [Path(directory.anchor)]
    for component in directory.parts[1:]:
        paths.append(paths[-1] / component)
    result = []
    for entry in paths:
        info = entry.lstat()
        _not_link(info)
        _require(stat.S_ISDIR(info.st_mode))
        result.append((entry, _directory_identity(info)))
    return result


def _check_directories(identities):
    for entry, expected in identities:
        info = entry.lstat()
        _not_link(info)
        _require(stat.S_ISDIR(info.st_mode)
                 and _directory_identity(info) == expected)


@contextmanager
def _directory_handle(directory, identities):
    descriptor = None
    try:
        if os.open in os.supports_dir_fd and hasattr(os, "O_DIRECTORY"):
            descriptor = os.open(directory, _OPEN_FLAGS | os.O_DIRECTORY)
            _require(_directory_identity(os.fstat(descriptor)) == identities[-1][1])
        yield descriptor
        if descriptor is not None:
            _require(_directory_identity(os.fstat(descriptor)) == identities[-1][1])
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _stream_file(directory, entry, directory_descriptor=None, capture_limit=None):
    """Internal byte-verification primitive, also tested on synthetic fixtures."""
    name, size = _filename(entry["name"]), _integer(entry["size"], 1)
    _require(entry["algorithm"] in ("sha256", "git-blob-sha1"))
    digest_size = 64 if entry["algorithm"] == "sha256" else 40
    _require(type(entry["digest"]) is str
             and re.fullmatch(r"[a-f0-9]{" + str(digest_size) + r"}", entry["digest"]))
    if capture_limit is not None:
        _require(size <= capture_limit)
    filename = directory / name
    before = filename.lstat()
    _regular(before)
    _require(before.st_size == size)
    descriptor = None
    try:
        descriptor = (os.open(name, _OPEN_FLAGS, dir_fd=directory_descriptor)
                      if directory_descriptor is not None else os.open(filename, _OPEN_FLAGS))
        opened = os.fstat(descriptor)
        _regular(opened)
        _require(_file_identity(before) == _file_identity(opened))
        hasher = hashlib.sha256() if entry["algorithm"] == "sha256" else hashlib.sha1()
        if entry["algorithm"] == "git-blob-sha1":
            hasher.update(f"blob {size}\0".encode("ascii"))
        captured = bytearray() if capture_limit is not None else None
        remaining = size
        while remaining:
            chunk = os.read(descriptor, min(MAX_READ_BYTES, remaining))
            _require(chunk and len(chunk) <= min(MAX_READ_BYTES, remaining))
            remaining -= len(chunk)
            hasher.update(chunk)
            if captured is not None:
                captured.extend(chunk)
        _require(os.read(descriptor, 1) == b"")
        after = os.fstat(descriptor)
        named = filename.lstat()
        _regular(after)
        _regular(named)
        _require(_file_identity(opened) == _file_identity(after) == _file_identity(named)
                 and hasher.hexdigest() == entry["digest"])
        return _file_identity(after), bytes(captured) if captured is not None else None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _small_file(filename, limit):
    directory = filename.parent
    identities = _directories(directory)
    before = filename.lstat()
    _regular(before)
    _require(0 < before.st_size <= limit)
    descriptor = None
    try:
        descriptor = os.open(filename, _OPEN_FLAGS)
        opened = os.fstat(descriptor)
        _regular(opened)
        _require(_file_identity(before) == _file_identity(opened))
        result = bytearray()
        while len(result) <= limit:
            chunk = os.read(descriptor, min(MAX_READ_BYTES, limit + 1 - len(result)))
            if not chunk:
                break
            result.extend(chunk)
        named = filename.lstat()
        _regular(named)
        _require(len(result) == before.st_size
                 and _file_identity(opened) == _file_identity(os.fstat(descriptor)) == _file_identity(named))
        _check_directories(identities)
        return bytes(result)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _manifest(config):
    _require(type(config) is dict and config.get("model") == MODEL
             and config.get("revision") == REVISION and config.get("license") == LICENSE)
    raw = _small_file(_MANIFEST_PATH, MAX_MANIFEST_BYTES)
    _require(hashlib.sha256(raw).hexdigest() == MANIFEST_SHA256)
    value = _object(_json(raw), ("schemaVersion", "model", "revision", "license", "source", "files", "index"))
    _require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
             and value["model"] == MODEL and value["revision"] == REVISION and value["license"] == LICENSE)
    source = _object(value["source"], ("tree", "revision"))
    urls = {"tree": f"https://huggingface.co/api/models/{MODEL}/tree/{REVISION}?recursive=true&expand=true",
            "revision": f"https://huggingface.co/api/models/{MODEL}/revision/{REVISION}"}
    for key, url in urls.items():
        row = _object(source[key], ("url", "sha256"))
        _require(row["url"] == url and type(row["sha256"]) is str
                 and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]))
    files = value["files"]
    _require(type(files) is list and len(files) == len(_REQUIRED_FILES))
    names = set()
    for entry in files:
        _object(entry, ("name", "size", "algorithm", "digest"))
        name = _filename(entry["name"])
        _require(name not in names)
        names.add(name)
        _integer(entry["size"], 1)
        algorithm = "sha256" if name in _SHARDS else "git-blob-sha1"
        _require(entry["algorithm"] == algorithm and type(entry["digest"]) is str
                 and re.fullmatch(r"[a-f0-9]{" + ("64" if name in _SHARDS else "40") + r"}", entry["digest"]))
    _require(names == _REQUIRED_FILES)
    index = _object(value["index"], ("name", "totalSize", "tensorCount", "shards"))
    _require(index["name"] == "model.safetensors.index.json" and index["shards"] == list(_SHARDS))
    _integer(index["totalSize"], 1)
    _integer(index["tensorCount"], 1)
    return value


def _check_index(raw, expected):
    _require(len(raw) <= MAX_INDEX_BYTES)
    value = _object(_json(raw), ("metadata", "weight_map"))
    metadata = _object(value["metadata"], ("total_size",))
    _require(_integer(metadata["total_size"], 1) == expected["totalSize"])
    weight_map = value["weight_map"]
    _require(type(weight_map) is dict and len(weight_map) == expected["tensorCount"])
    shards = set()
    for tensor, filename in weight_map.items():
        _require(type(tensor) is str and 1 <= len(tensor) <= 512)
        shards.add(_filename(filename))
    _require(shards == set(expected["shards"]))


def _verify_files(directory, files, index):
    """Internal fixture-testable scanner; only the public API binds the real manifest."""
    identities = _directories(directory)
    observed = []
    index_bytes = None
    with _directory_handle(directory, identities) as directory_descriptor:
        for entry in files:
            capture = MAX_INDEX_BYTES if entry["name"] == index["name"] else None
            identity, raw = _stream_file(directory, entry, directory_descriptor, capture)
            observed.append((entry["name"], identity))
            if capture is not None:
                index_bytes = raw
        _require(index_bytes is not None)
        _check_index(index_bytes, index)
        for name, identity in observed:
            info = (directory / name).lstat()
            _regular(info)
            _require(_file_identity(info) == identity)
        _check_directories(identities)
    return sum(entry["size"] for entry in files)


def _source_sha256():
    value = hashlib.sha256(_small_file(_VALIDATOR_PATH, MAX_VALIDATOR_BYTES)).hexdigest()
    _require(value == _INITIAL_VALIDATOR_SHA256)
    return value


def _proof(manifest, validator_digest):
    return {"schemaVersion": 1, "manifestSha256": MANIFEST_SHA256,
            "validatorSha256": validator_digest, "model": MODEL, "revision": REVISION,
            "license": LICENSE, "fileCount": len(manifest["files"]),
            "shardCount": len(manifest["index"]["shards"]),
            "verifiedBytes": sum(entry["size"] for entry in manifest["files"]),
            "tensorBytes": manifest["index"]["totalSize"]}


def expected_artifact_proof(config):
    """Return expected receipt values; this function does NOT validate model bytes."""
    try:
        validator_digest = _source_sha256()
        manifest = _manifest(config)
        _require(_source_sha256() == validator_digest)
        return _proof(manifest, validator_digest)
    except Exception:
        pass
    raise ModelArtifactError()


def validate_model_artifacts(model_path, config):
    """Return the closed receipt only after every fixed artifact's size/hash passes."""
    try:
        validator_digest = _source_sha256()
        manifest = _manifest(config)
        directory = Path(model_path)
        _require(directory.is_absolute() and directory.name == REVISION)
        verified_bytes = _verify_files(directory, manifest["files"], manifest["index"])
        _require(_source_sha256() == validator_digest and _manifest(config) == manifest)
        proof = _proof(manifest, validator_digest)
        _require(verified_bytes == proof["verifiedBytes"])
        return proof
    except Exception:
        pass
    raise ModelArtifactError()


# No model data, network, provider SDK, or heavyweight inference library is used
# during import. Detect later replacement of the actual executing source file.
try:
    _INITIAL_VALIDATOR_SHA256 = hashlib.sha256(_small_file(_VALIDATOR_PATH, MAX_VALIDATOR_BYTES)).hexdigest()
except Exception:
    _INITIAL_VALIDATOR_SHA256 = None
