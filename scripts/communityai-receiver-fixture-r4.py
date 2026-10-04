"""Offline schema/digest probe for the pinned CommunityAI PR35 ingress.

Distinct R4; leave the old-ingress R3 SDK-refusal receipt unchanged.
Run only after source review, using the pinned bundled Python with -I -S -B.
This file never imports DRIFT/server, starts ASGI, or invokes original admission.
"""

import sys
import socket
import _socket


class OfflineBoundaryDenied(RuntimeError):
    pass


DENIED_BOUNDARY_ATTEMPTS = []


def _deny_socket(*_args, **_kwargs):
    DENIED_BOUNDARY_ATTEMPTS.append("socket primitive")
    raise OfflineBoundaryDenied("OFFLINE_SOCKET_DENIED")


class _DeniedSocket(socket.socket):
    def __new__(cls, *_args, **_kwargs):
        return _deny_socket()


# Install before Pydantic or any extracted code. The audit hook also catches
# retained native socket references. These are process-local guards, not an OS
# sandbox, kernel confinement proof, or a census of other processes.
socket.socket = _DeniedSocket
socket.SocketType = _DeniedSocket
_socket.socket = _DeniedSocket
for _name in (
    "create_connection", "create_server", "socketpair", "fromfd",
    "getaddrinfo", "gethostbyname", "gethostbyname_ex", "gethostbyaddr",
    "getnameinfo",
):
    if hasattr(socket, _name):
        setattr(socket, _name, _deny_socket)
    if hasattr(_socket, _name):
        setattr(_socket, _name, _deny_socket)


def _deny_external_audit(event, _args):
    if event.startswith("socket.") or event in (
        "subprocess.Popen", "os.system", "os.posix_spawn", "sqlite3.connect",
    ):
        DENIED_BOUNDARY_ATTEMPTS.append(event)
        raise OfflineBoundaryDenied("OFFLINE_EXTERNAL_BOUNDARY_DENIED")


sys.addaudithook(_deny_external_audit)

import ast
import hashlib
import json
import os
import stat
import types
from pathlib import Path
from typing import List, Literal, Optional, Union


PYTHON_ROOT = Path(
    "C:/Users/Moe/.cache/codex-runtimes/codex-primary-runtime/dependencies/python"
)
SITE_PACKAGES = PYTHON_ROOT / "Lib/site-packages"
INGRESS_ROOT = Path(
    "C:/Users/Moe/.codex/worktrees/openai-stream-usage/petals-revival"
)
MAX_PIN_BYTES = 16 * 1024 * 1024
EXPECTED_PYTHON_VERSION = (3, 12, 14)
EXPECTED_PYDANTIC_VERSION = "2.13.5"
EXPECTED_CORE_VERSION = "2.46.5"

# Explicit commitments exist before parsing, validation, or observation. These
# are synthetic public fixture values, not a registered live model/credential.
FIXTURE_MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
PRECOMMITTED_SDK_UTF8 = (
    b'{"model":"sha256:1111111111111111111111111111111111111111111111111111111111111111",'
    b'"messages":[{"role":"user","content":"offline bridge fixture"}],'
    b'"temperature":1,"stream":true,"max_tokens":8,'
    b'"stream_options":{"include_usage":true}}'
)
PRECOMMITTED_NORMALIZED_UTF8 = (
    b'{"max_tokens":8,"messages":[{"content":"offline bridge fixture","role":"user"}],'
    b'"model":"sha256:1111111111111111111111111111111111111111111111111111111111111111",'
    b'"n":1,"stream":true,"stream_options":{"include_usage":true},"temperature":1.0}'
)
EXPECTED_NORMALIZED_SHA256 = "21a0d9be9d903deba02504bb66506208338bc4423c8669a71db1904d21aa4890"

SOURCE_EXPECTATIONS = (
    (INGRESS_ROOT / "src/drift/api/server.py", 31921,
     "9725a900ecfd565b1eb69ecc11888cf0a6494a985dccf28de353e3a0d7a34d60"),
    (INGRESS_ROOT / "src/drift/factory_admission.py", 4865,
     "c38fe244152332b2c24ec07128948cc77f28aedae321e3cdd58e1d0b8430f888"),
)
RUNTIME_EXPECTATIONS = (
    (PYTHON_ROOT / "python.exe", 107312,
     "372c2eae555b344520bf147be0096e009069aeca4e7f78d6aecea6d53158056a"),
    (PYTHON_ROOT / "python312.dll", 6985520,
     "c1ce6d603041759061139f482c4b90c4ac9db676e30abf52fda66a794aab1bd0"),
    (SITE_PACKAGES / "pydantic-2.13.5.dist-info/METADATA", 110178,
     "0685830d13647bd6f3f05526043d32a8b2a221d86b53773053d6c52bb17a9c07"),
    (SITE_PACKAGES / "pydantic/__init__.py", 15812,
     "e62127278c07bf5384cdd2903f368a69929f3b8a524000bae4e0eb608ebf4bc6"),
    (SITE_PACKAGES / "pydantic/main.py", 85334,
     "35b842cfe92ef300e060b40c062ef93afee1cb075cf0b7b0037a1434867c2554"),
    (SITE_PACKAGES / "pydantic/config.py", 44533,
     "a353faec53162101befd17c6b4a8ac9641f0a38a579bfea37ec478d4ff3cbfbf"),
    (SITE_PACKAGES / "pydantic/version.py", 3985,
     "b8a3b18742e3899919d0a7cb9a5a4f611018fbf369217f228f138b0cd856f26f"),
    (SITE_PACKAGES / "pydantic_core-2.46.5.dist-info/METADATA", 6709,
     "a193d0a16e9372c99b84b9216e274e28521fe5e5bf7be7b8b11be1c3c50cd9ca"),
    (SITE_PACKAGES / "pydantic_core/__init__.py", 5286,
     "e644150a9eac4372c4ff826c8f614df288a561e39250e96c58e447f17806c6bf"),
    (SITE_PACKAGES / "pydantic_core/_pydantic_core.cp312-win_amd64.pyd", 5173552,
     "e0191022a0ae87171de64958da061cf69acd8ef7fa18f9197116b42f6123f36e"),
)


def require(condition, label):
    if not condition:
        raise RuntimeError(label)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(value):
    fields = (
        "st_dev", "st_ino", "st_mode", "st_nlink", "st_size",
        "st_mtime_ns", "st_ctime_ns", "st_birthtime_ns", "st_uid", "st_gid",
    )
    return {name: str(getattr(value, name)) for name in fields if hasattr(value, name)}


def read_bound(filename, expected_size, expected_digest):
    require(filename.is_absolute(), "PIN_PATH_NOT_ABSOLUTE")
    named_before = os.lstat(filename)
    path_before = identity(named_before)
    require(stat.S_ISREG(named_before.st_mode) and not stat.S_ISLNK(named_before.st_mode),
            "PIN_NOT_REGULAR")
    require(named_before.st_nlink == 1 and 0 <= named_before.st_size <= MAX_PIN_BYTES,
            "PIN_SIZE_OR_LINK_BOUND")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(filename, flags)
    try:
        descriptor_before = identity(os.fstat(fd))
        require("st_ctime_ns" in path_before and "st_ctime_ns" in descriptor_before,
                "PIN_RAW_CTIME_MISSING")
        require(path_before.keys() == descriptor_before.keys(), "PIN_API_FIELDS_DIFFER")
        # In this exact bundled Windows CPython 3.12.14 observation, lstat(path)
        # and fstat(fd) expose different raw st_ctime_ns values. Do not normalize
        # either value, substitute birth/mtime, or compare them as one API.
        # Raw mode is also retained independently: this exact runtime reports
        # pathname python.exe mode 0100777 and descriptor mode 0100666. Compare
        # only file type across APIs, not those distinct permission projections.
        # All other eight fields must agree across APIs; both COMPLETE raw
        # identities, including ctime and mode, stay exact within each API.
        cross_api_fields = [name for name in path_before
                            if name not in ("st_ctime_ns", "st_mode")]
        require(all(path_before[name] == descriptor_before[name] for name in cross_api_fields),
                "PIN_DESCRIPTOR_OBJECT_MISMATCH")
        path_file_type = stat.S_IFMT(int(path_before["st_mode"]))
        descriptor_file_type = stat.S_IFMT(int(descriptor_before["st_mode"]))
        require(path_file_type == descriptor_file_type, "PIN_DESCRIPTOR_FILETYPE_MISMATCH")
        parts = []
        remaining = named_before.st_size + 1
        while remaining:
            part = os.read(fd, min(remaining, 65536))
            if not part:
                break
            parts.append(part)
            remaining -= len(part)
        raw = b"".join(parts)
        require(len(raw) == named_before.st_size, "PIN_READ_SIZE_CHANGED")
        descriptor_after = identity(os.fstat(fd))
        path_after = identity(os.lstat(filename))
        require(descriptor_after == descriptor_before, "PIN_DESCRIPTOR_CHANGED")
        require(path_after == path_before, "PIN_PATH_CHANGED")
    finally:
        os.close(fd)
    require(len(raw) == expected_size and digest(raw) == expected_digest, "PIN_BYTES_CHANGED")
    return raw, {
        "path": str(filename), "bytes": len(raw), "sha256": digest(raw),
        "pathBefore": path_before, "pathAfter": path_after,
        "descriptorBefore": descriptor_before, "descriptorAfter": descriptor_after,
        "crossApiObjectFieldsCompared": cross_api_fields,
        "modeApiObservation": {
            "pathRawBefore": path_before["st_mode"],
            "pathRawAfter": path_after["st_mode"],
            "descriptorRawBefore": descriptor_before["st_mode"],
            "descriptorRawAfter": descriptor_after["st_mode"],
            "crossApiRawEqual": path_before["st_mode"] == descriptor_before["st_mode"],
            "pathFileType": str(path_file_type),
            "descriptorFileType": str(descriptor_file_type),
            "crossApiFileTypeEqual": path_file_type == descriptor_file_type,
            "comparison": "raw-retained; exact-same-API-before-after; cross-API-filetype-only",
            "runtimeScope": "bundled-Windows-CPython-3.12.14-only",
        },
        "ctimeApiObservation": {
            "pathRawBefore": path_before["st_ctime_ns"],
            "pathRawAfter": path_after["st_ctime_ns"],
            "descriptorRawBefore": descriptor_before["st_ctime_ns"],
            "descriptorRawAfter": descriptor_after["st_ctime_ns"],
            "crossApiEqual": path_before["st_ctime_ns"] == descriptor_before["st_ctime_ns"],
            "comparison": "raw-retained; exact-same-API-before-after-only; no-coercion",
            "runtimeScope": "bundled-Windows-CPython-3.12.14-only",
        },
    }


def extract_named_nodes(source, filename, names, namespace):
    tree = ast.parse(source, filename=str(filename))
    selected = []
    descriptions = []
    for name, expected_type in names:
        matches = [node for node in tree.body if getattr(node, "name", None) == name]
        require(len(matches) == 1 and type(matches[0]) is expected_type, "AST_SCOPE_MISMATCH")
        node = matches[0]
        require(not node.decorator_list, "AST_UNEXPECTED_DECORATOR")
        require(not any(isinstance(child, (ast.Import, ast.ImportFrom)) for child in ast.walk(node)),
                "AST_UNEXPECTED_IMPORT")
        selected.append(node)
        segment = ast.get_source_segment(source, node)
        require(isinstance(segment, str), "AST_SOURCE_SEGMENT_MISSING")
        descriptions.append({
            "name": name, "nodeType": expected_type.__name__, "line": node.lineno,
            "endLine": node.end_lineno, "sourceSegmentSha256": digest(segment.encode("utf-8")),
            "astSha256": digest(ast.dump(node, include_attributes=False).encode("utf-8")),
        })
    # No imports, assignments, constructors, launchers, or other module-level code
    # from the input modules is included. Only these exact pinned definitions.
    isolated = ast.Module(body=selected, type_ignores=[])
    exec(compile(isolated, str(filename), "exec", dont_inherit=True), namespace)
    return descriptions


def main():
    require(len(sys.argv) == 1, "NO_EXTERNAL_FIXTURE_INPUT_ACCEPTED")
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            "USE_ISOLATED_NO_SITE_NO_BYTECODE_INVOCATION")
    require(tuple(sys.version_info[:3]) == EXPECTED_PYTHON_VERSION, "PYTHON_VERSION_CHANGED")
    require(os.name == "nt" and sys.platform == "win32", "WINDOWS_STAT_SCOPE_REQUIRED")
    require(os.path.normcase(os.path.abspath(sys.executable))
            == os.path.normcase(os.path.abspath(PYTHON_ROOT / "python.exe")), "PYTHON_PATH_CHANGED")
    before = []
    source_raw = {}
    for filename, size, expected_digest in SOURCE_EXPECTATIONS + RUNTIME_EXPECTATIONS:
        raw, pin = read_bound(filename, size, expected_digest)
        before.append(pin)
        if filename in (row[0] for row in SOURCE_EXPECTATIONS):
            source_raw[filename] = raw.decode("utf-8", errors="strict")

    # -S skips all .pth/site customization. Add only the installed package
    # directory, without calling site.addsitedir or importing DRIFT.
    sys.path.append(str(SITE_PACKAGES))
    import pydantic
    import pydantic_core
    from pydantic import BaseModel, ConfigDict, StrictBool, StrictStr, ValidationError

    require(pydantic.__version__ == EXPECTED_PYDANTIC_VERSION, "PYDANTIC_VERSION_CHANGED")
    require(pydantic_core.__version__ == EXPECTED_CORE_VERSION, "PYDANTIC_CORE_VERSION_CHANGED")
    require(Path(pydantic.__file__).resolve() == (SITE_PACKAGES / "pydantic/__init__.py").resolve(),
            "PYDANTIC_PATH_CHANGED")
    require(Path(pydantic_core.__file__).resolve()
            == (SITE_PACKAGES / "pydantic_core/__init__.py").resolve(), "PYDANTIC_CORE_PATH_CHANGED")

    module = types.ModuleType("communityai_pinned_schema_fixture")
    namespace = module.__dict__
    namespace.update({
        "BaseModel": BaseModel, "ConfigDict": ConfigDict, "StrictBool": StrictBool,
        "StrictStr": StrictStr, "Literal": Literal, "List": List, "Optional": Optional,
        "Union": Union, "json": json, "hashlib": hashlib,
    })
    sys.modules[module.__name__] = module
    server_path, admission_path = (row[0] for row in SOURCE_EXPECTATIONS)
    schema_scope = extract_named_nodes(source_raw[server_path], server_path, (
        ("TextContentPart", ast.ClassDef), ("ChatMessage", ast.ClassDef),
        ("StreamOptions", ast.ClassDef),
        ("ChatCompletionRequest", ast.ClassDef),
    ), namespace)
    digest_scope = extract_named_nodes(source_raw[admission_path], admission_path, (
        ("RequestAdmissionDenied", ast.ClassDef), ("request_body_digest", ast.FunctionDef),
    ), namespace)
    schema = namespace["ChatCompletionRequest"]
    require(schema.model_config.get("extra") == "forbid", "PINNED_INGRESS_NOT_STRICT")
    require(namespace["StreamOptions"].model_config.get("extra") == "forbid",
            "PINNED_STREAM_OPTIONS_NOT_STRICT")

    # The previously committed SDK-final bytes are now validated directly.
    # This does not exercise ASGI admission, authorization, or response rendering.
    require(digest(PRECOMMITTED_SDK_UTF8)
            == "44c04671db48d10c164afcdf6558032c4ca68cb8f0a1c5e9ebdaeb7f449843b5",
            "SDK_FIXTURE_BYTES_CHANGED")
    validated = schema.model_validate_json(PRECOMMITTED_SDK_UTF8)
    normalized = validated.model_dump(exclude_none=True)
    rendered = json.dumps(normalized, ensure_ascii=False, allow_nan=False,
                          sort_keys=True, separators=(",", ":")).encode("utf-8")
    require(rendered == PRECOMMITTED_NORMALIZED_UTF8, "NORMALIZED_LITERAL_MISMATCH")
    require(type(normalized["temperature"]) is float and normalized["temperature"] == 1.0,
            "EXPECTED_PYTHON_FLOAT_NORMALIZATION")
    require(type(normalized["n"]) is int and normalized["n"] == 1, "EXPECTED_N_DEFAULT")
    require(normalized["model"] == FIXTURE_MANIFEST and normalized["stream"] is True,
            "EXPECTED_MODEL_AND_STREAM")
    require(normalized["stream_options"] == {"include_usage": True}
            and type(normalized["stream_options"]["include_usage"]) is bool,
            "EXPECTED_STREAM_OPTIONS_PRESERVED")
    actual_digest = namespace["request_body_digest"](normalized)
    require(actual_digest == digest(PRECOMMITTED_NORMALIZED_UTF8)
            == EXPECTED_NORMALIZED_SHA256, "EXTRACTED_DIGEST_MISMATCH")
    # Inner unknown options must not be silently lost before the body digest.
    unknown_option_body = PRECOMMITTED_SDK_UTF8.replace(
        b'"include_usage":true}', b'"include_usage":true,"unexpected":true}'
    )
    require(unknown_option_body != PRECOMMITTED_SDK_UTF8, "UNKNOWN_OPTION_FIXTURE_UNCHANGED")
    try:
        schema.model_validate_json(unknown_option_body)
    except ValidationError as error:
        errors = error.errors(include_url=False, include_context=False, include_input=False)
        require(len(errors) == 1 and errors[0]["type"] == "extra_forbidden"
                and tuple(errors[0]["loc"]) == ("stream_options", "unexpected"),
                "UNEXPECTED_UNKNOWN_OPTION_RESULT")
    else:
        raise RuntimeError("UNKNOWN_STREAM_OPTION_WAS_ACCEPTED")
    require(not DENIED_BOUNDARY_ATTEMPTS, "EXTERNAL_BOUNDARY_WAS_ATTEMPTED")

    after = []
    for filename, size, expected_digest in SOURCE_EXPECTATIONS + RUNTIME_EXPECTATIONS:
        _, pin = read_bound(filename, size, expected_digest)
        after.append(pin)
    require(after == before, "SOURCE_OR_SELECTED_RUNTIME_GENERATION_CHANGED")
    return {
        "format": "factory-communityai-offline-receiver-fixture", "schemaVersion": 4,
        "candidateRevision": "r4-pr35",
        "accepted": True, "scope": "pinned-admission-enabled-ingress-schema-and-digest-only",
        "sourceAndSelectedRuntimeBefore": before, "sourceAndSelectedRuntimeAfter": after,
        "pythonVersion": sys.version, "pythonExecutable": sys.executable,
        "pydanticVersion": pydantic.__version__, "pydanticCoreVersion": pydantic_core.__version__,
        "extractedSchemaDefinitions": schema_scope, "extractedDigestDefinitions": digest_scope,
        "sdkBodySha256": digest(PRECOMMITTED_SDK_UTF8),
        "receiverNormalizedBodySha256": actual_digest,
        "receiverNormalizedUtf8": PRECOMMITTED_NORMALIZED_UTF8.decode("utf-8"),
        "sdkBodyAcceptedWithoutProjection": True,
        "unknownStreamOptionRefused": {"type": "extra_forbidden", "field": "stream_options.unexpected"},
        "externalBoundaryAttempts": DENIED_BOUNDARY_ATTEMPTS,
        "limitations": [
            "Only the exact pinned PR35 admission-enabled ingress snapshot is covered.",
            "Only the six named AST definitions execute; DRIFT/server and all other top-level "
            "candidate code are neither imported nor executed.",
            "This is not a full ASGI request, live receiver rendering, original authentication/admission, "
            "real model selection, route readiness, dispatch claim, provider call, or descendant qualification.",
            "The old R3 SDK-refusal receipt remains specific to its older ingress and is not "
            "replayed, changed, or upgraded by this independent R4 probe.",
            "Python path and descriptor raw ctime and mode values are retained separately and checked "
            "exactly within each API. Cross-API mode compares file type only, not raw permissions. "
            "No claim is made that this process-local check pins every interpreter dependency or "
            "establishes an independent aggregate byte/generation qualification.",
            "Selected runtime files and versions are pinned, not the complete Python/Pydantic "
            "dependency closure or kernel/network/global confinement.",
        ],
    }


if __name__ == "__main__":
    try:
        result = main()
    except FileNotFoundError:
        print(json.dumps({"accepted": False, "failure": "PINNED_SOURCE_OR_RUNTIME_PREREQUISITE_MISSING",
                          "installationAttempted": False}, separators=(",", ":")), flush=True)
        raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"accepted": False, "failureType": type(error).__name__,
                          "failure": str(error), "externalBoundaryAttempts": DENIED_BOUNDARY_ATTEMPTS},
                         separators=(",", ":")), flush=True)
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True,
                     separators=(",", ":")), flush=True)
