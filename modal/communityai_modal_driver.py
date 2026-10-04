"""Explicit host-only Modal Sandbox driver for the fixed CommunityAI topology.

Import does not import Modal, read credentials, contact an account or start peers.
The owning host supplies both current lifecycle admission and existing hydrated
App/Image/Volume handles. There is no command-line admission or default callback.
The existing ModalJournal running intent is checked before every SDK mutation.
Resource checkpoints preserve IDs even when later tunnel observation fails.
These observations do not authorize inference or release a spending reservation.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import inspect
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid

from communityai_bootstrap import (
    MANIFEST_DIGEST, REVISION, ROLES, build_launch_plan, create_coordinator_app,
)
from communityai_runtime import validate_bootstrap_config


OPERATIONS = {"create-role", "launch-role", "terminate-role", "observe-role"}
OFFLINE_ENV = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
               "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
SPEC_FIELDS = {"runId", "appName", "appId", "imageRef", "imageId", "volumeId",
               "volumeEvidenceSha256", "manifestDigest", "modelRevision",
               "expiresAtUnix", "reservationId", "ceilingCents", "gpu"}
MAX_JSON_BYTES = 65536
RETIRED_STATES = {"terminate_requested_unverified", "terminate_pending", "sandbox_terminal_observed"}
MODEL_RUNTIME_HOLD = "Reviewed local-only artifact_root runtime and image required before model exec"


class RoleBusyError(RuntimeError):
    """Another live invocation owns this role; observe it, never replay it."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def validate_spec(spec, *, now=None, allow_expired=False):
    if type(spec) is not dict or set(spec) != SPEC_FIELDS:
        raise ValueError("Exact distributed host resource binding required")
    for field, expression in (
        ("runId", r"factory-[a-z0-9][a-z0-9-]{2,55}"),
        ("appName", r"factory-[a-z0-9][a-z0-9-]{2,55}"),
        ("appId", r"ap-[A-Za-z0-9_-]{1,128}"),
        ("imageId", r"im-[A-Za-z0-9_-]{1,128}"),
        ("volumeId", r"vo-[A-Za-z0-9_-]{1,128}"),
        ("imageRef", r"[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}"),
        ("volumeEvidenceSha256", r"[0-9a-f]{64}"),
        ("reservationId", r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"),
    ):
        if type(spec[field]) is not str or re.fullmatch(expression, spec[field]) is None:
            raise ValueError("Invalid host resource binding")
    if spec["manifestDigest"] != MANIFEST_DIGEST or spec["modelRevision"] != REVISION:
        raise ValueError("Pinned CommunityAI cache/manifest identity required")
    if spec["gpu"] not in {"T4", "L4"}:
        raise ValueError("Explicit supported worker GPU required")
    if type(spec["ceilingCents"]) is not int or not 0 < spec["ceilingCents"] <= 10000:
        raise ValueError("Existing explicit paid reservation ceiling required")
    now = time.time() if now is None else now
    expires = spec["expiresAtUnix"]
    if type(expires) is not int or (not allow_expired and not now < expires <= now + 21600):
        raise ValueError("Fresh bounded absolute role expiry required")
    return json.loads(canonical(spec))


def _gate(callback, request):
    if (not callable(callback) or inspect.iscoroutinefunction(callback)
            or inspect.iscoroutinefunction(getattr(callback, "__call__", None))):
        raise ValueError("Trusted synchronous current host lifecycle admission required")
    if callback(json.loads(canonical(request))) is not True:
        raise PermissionError("Host lifecycle admission denied")


def _private_json(path):
    path = Path(path)
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_nlink != 1 or info.st_size > MAX_JSON_BYTES:
        raise ValueError("Protected bounded private resource record required")
    def generation(item):
        return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
                item.st_ctime_ns, item.st_nlink, item.st_mode)
    def identity(item):
        # Python 3.13 Windows path-stat and fd-stat expose different ctime
        # semantics after rename. Compare each full generation to itself and
        # bind the descriptor to the path using the common identity fields.
        return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
                item.st_nlink, item.st_mode)
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if identity(opened) != identity(info):
            raise ValueError("Private record changed before read")
        raw = handle.read(MAX_JSON_BYTES + 1)
        if (len(raw) != info.st_size or generation(os.fstat(handle.fileno())) != generation(opened)
                or generation(path.lstat()) != generation(info)):
            raise ValueError("Private record changed during read")
    return json.loads(raw)


def _checkpoint_path(request):
    root = Path(request["runDirectory"])
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError("Existing host-protected private run directory required")
    return root / f'{request["role"]}-resource.private.json'


@contextmanager
def _role_checkpoint_lock(request):
    """Fence the entire role dispatch across threads and host processes.

    The protected lock file persists, but the OS releases its lock on process
    exit. Durable operation dispatch claims are independent and never reset.
    Contention refuses immediately; it does not wait, retry or call the SDK.
    """
    path = _checkpoint_path(request).with_name(f'{request["role"]}-checkpoint.lock')
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    acquired = False
    try:
        def bound_file():
            opened, linked = os.fstat(descriptor), path.lstat()
            if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(linked.st_mode)
                    or path.is_symlink() or opened.st_nlink != 1 or linked.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (linked.st_dev, linked.st_ino)
                    or opened.st_size not in {0, 1}):
                raise ValueError("Protected original role lock required")
        bound_file()
        if os.name == "nt":
            import msvcrt
            try:
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RoleBusyError("Live role invocation requires observation") from error
        else:
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RoleBusyError("Live role invocation requires observation") from error
        acquired = True
        bound_file()
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        yield
    finally:
        try:
            if acquired:
                if os.name == "nt":
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _write_checkpoint(request, value):
    # The host protects the directory (native ACLs on Windows). This does not
    # create or relax directory permissions and never writes to Original SQL.
    path = _checkpoint_path(request)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            os.chmod(temporary, 0o600)
            handle.write(canonical(value) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _claim_dispatch(payload, request):
    """Burn one durable attempt before any SDK access, including lost responses.

    A still-running journal row after a crashed bridge is not permission to
    repeat its physical operation. The exclusive marker is never reset here.
    """
    path = _checkpoint_path(request).parent / f'{request["role"]}-{request["operation"]}-dispatch.private.json'
    value = {"key": payload["key"], "operation": request["operation"],
             "requestSha256": digest(request), "status": "dispatch_claimed_no_replay"}
    with path.open("xb") as handle:
        os.chmod(path, 0o600)
        handle.write(canonical(value) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())


def _intent(payload, host_admission, *, observation=False):
    if type(payload) is not dict or set(payload) != {"key", "journalPath", "request"}:
        raise ValueError("Exact existing journal dispatch required")
    request = payload["request"]
    if type(request) is not dict or set(request) != {"operation", "role", "spec", "runDirectory", "input"}:
        raise ValueError("Exact role operation required")
    if request["operation"] not in OPERATIONS or request["role"] not in ROLES:
        raise ValueError("Fixed role operation required")
    if observation != (request["operation"] == "observe-role"):
        raise ValueError("Operation admission mismatch")
    validate_spec(request["spec"], allow_expired=request["operation"] in {"observe-role", "terminate-role"})
    _gate(host_admission, request)  # Deny before journal/SDK/account work.
    journal = Path(payload["journalPath"])
    if (journal.resolve() != (_checkpoint_path(request).parent / "modal.sqlite").resolve()
            or not journal.is_file() or journal.is_symlink()
            or type(payload["key"]) is not str
            or re.fullmatch(r"[a-z0-9_-]{1,80}", payload["key"]) is None):
        raise ValueError("Exact original role operation journal required")
    connection = sqlite3.connect(f"{journal.as_uri()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT operation,request_digest,request_json,state FROM modal_operations WHERE key=?",
            (payload["key"],),
        ).fetchone()
    finally:
        connection.close()
    wanted = request if not observation else {**request, "operation": "create-role", "input": None}
    states = {"running"} if not observation else {"running", "unknown", "succeeded"}
    if (row is None or row[0] != f'{wanted["operation"]}:{request["role"]}'
            or row[1] != digest(wanted) or json.loads(row[2]) != wanted or row[3] not in states):
        raise PermissionError("Matching existing durable role intent required")
    return request


def _owned(request):
    value = _private_json(_checkpoint_path(request))
    spec = request["spec"]
    if (value.get("role") != request["role"] or value.get("spec") != spec
            or value.get("createRequestSha256") != digest({**request, "operation": "create-role", "input": None})
            or type(value.get("resourceId")) is not str
            or re.fullmatch(r"sb-[A-Za-z0-9_-]{1,128}", value["resourceId"]) is None):
        raise ValueError("Exact recorded owned Sandbox required")
    return value


def _sdk_call(payload, host_admission, action):
    _intent(payload, host_admission, observation=payload["request"]["operation"] == "observe-role")
    return action()


def _endpoint(sandbox, request, resolve_ipv4):
    if not callable(resolve_ipv4) or inspect.iscoroutinefunction(resolve_ipv4):
        raise ValueError("Explicit bounded host tunnel DNS observer required")
    tunnel = sandbox.tunnels(timeout=20)[31330]
    host, port = tunnel.tcp_socket  # Never substitute tls_socket or 443.
    if type(host) is not str or not host or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Actual Modal raw TCP socket required")
    ip = str(ipaddress.IPv4Address(resolve_ipv4(host)))
    if not ipaddress.IPv4Address(ip).is_global:
        raise ValueError("Observed global IPv4 tunnel address required")
    return {"resource_id": sandbox.object_id, "ipv4": ip, "public_port": port,
            "listen_port": 31330, "transport": "modal-raw-tcp", "application_tls": True}, [host, port]


def dispatch(payload, *, host_admission, handles=None, sdk=None, resolve_ipv4=None):
    """Perform one explicitly admitted operation, without retry or inference.

    `host_admission` must revalidate exact host controller/resource ownership and
    paid reservation at each call; a callable alone is not authenticated proof.
    Handles must already be hydrated and owner-verified, including registry-to-
    Modal image mapping and the pinned cache contents. This driver never creates
    Apps, imports registry images, creates/deletes Volumes or downloads models.
    The caller must supervise this whole host invocation and retain its handle.
    """
    payload = json.loads(canonical(payload))
    request = _intent(payload, host_admission, observation=payload["request"]["operation"] == "observe-role")
    # The currently reviewed image lacks the explicit local-only artifact_root
    # seam. Offline environment variables do not disable upstream custom Hub
    # downloads, and read-only artifacts cannot own writable blocks.lock.
    # No caller-supplied boolean or image digest can lift this Source hold.
    if request["operation"] == "launch-role" and request["role"] != "bootstrap":
        raise PermissionError(MODEL_RUNTIME_HOLD)
    with _role_checkpoint_lock(request):
        return _dispatch_locked(payload, request, host_admission=host_admission,
                                handles=handles, sdk=sdk, resolve_ipv4=resolve_ipv4)


def _dispatch_locked(payload, request, *, host_admission, handles, sdk, resolve_ipv4):
    # Every checkpoint read/modify/replace, including SDK observations, is
    # protected by the same OS role lock until this invocation finishes.
    _intent(payload, host_admission, observation=request["operation"] == "observe-role")
    spec, role = request["spec"], request["role"]
    if (type(handles) is not dict or set(handles) != {"app", "image", "volume", "client"}
            or handles["client"] is None or handles["app"].app_id != spec["appId"]
            or handles["image"].object_id != spec["imageId"]
            or handles["volume"].object_id != spec["volumeId"]):
        raise ValueError("Existing exact owner-verified hydrated handles and explicit client required")
    if sdk is None:
        import modal as sdk  # Only after current host gate and matching intent.
    if request["operation"] == "create-role":
        if request["input"] is not None or _checkpoint_path(request).exists():
            raise ValueError("Fresh role creation requires no existing checkpoint")
        _claim_dispatch(payload, request)
        lifetime = math.ceil(spec["expiresAtUnix"] - time.time())
        if not 0 < lifetime <= 21600:
            raise ValueError("Role expired before create")
        volume = handles["volume"].with_mount_options(read_only=True)
        sandbox = _sdk_call(payload, host_admission, lambda: sdk.Sandbox.create(
            "python", "-u", "-c", "import time; time.sleep(21600)",
            app=handles["app"], client=handles["client"], image=handles["image"],
            name=f'{spec["runId"]}-{role.replace("_", "-")}',
            tags={"factory_run": spec["runId"], "factory_role": role, "factory_spec": digest(spec)},
            env=OFFLINE_ENV, volumes={"/models": volume}, timeout=lifetime,
            gpu=spec["gpu"] if role in {"worker_0", "worker_1"} else None,
            cpu=2, memory=8192, unencrypted_ports=[31330],
        ))
        if type(sandbox.object_id) is not str or re.fullmatch(r"sb-[A-Za-z0-9_-]{1,128}", sandbox.object_id) is None:
            raise ValueError("SDK returned an invalid Sandbox identity")
        record = {"role": role, "spec": spec, "resourceId": sandbox.object_id,
                  "createRequestSha256": digest(request), "endpoint": None, "tcpSocket": None,
                  "launch": "not_requested", "retirement": "unverified", "admission": "NO_ADMISSION"}
        _write_checkpoint(request, record)  # Before tunnel/DNS observations can fail.
        endpoint, socket = _sdk_call(payload, host_admission, lambda: _endpoint(sandbox, request, resolve_ipv4))
        record.update(endpoint=endpoint, tcpSocket=socket)
        _write_checkpoint(request, record)
        return {"state": "sandbox_created_tunnel_observed", "resourceId": sandbox.object_id, "admission": "NO_ADMISSION"}

    record = _owned(request)
    if type(request["input"]) is not dict or request["input"].get("resourceId") != record["resourceId"]:
        raise ValueError("Exact operation target required")
    if request["operation"] == "launch-role" and record["retirement"] in RETIRED_STATES:
        raise PermissionError("Retired role cannot launch")
    if request["operation"] == "terminate-role" and record["retirement"] == "sandbox_terminal_observed":
        if set(request["input"]) != {"resourceId"} or type(record.get("returncode")) is not int:
            raise ValueError("Retained actual terminal result required")
        # Current host admission, matching running intent and exact owned ID
        # were checked under the role lock. Preserve the observed terminal fact
        # without another provider call or a lower retirement checkpoint.
        _claim_dispatch(payload, request)
        return {"state": "sandbox_terminal_observed", "resourceId": record["resourceId"],
                "returncode": record["returncode"], "billingFinal": False, "admission": "NO_ADMISSION"}
    if request["operation"] != "observe-role":
        _claim_dispatch(payload, request)
    sandbox = _sdk_call(payload, host_admission, lambda: sdk.Sandbox.from_id(record["resourceId"], client=handles["client"]))
    if sandbox.object_id != record["resourceId"]:
        raise ValueError("SDK target identity changed")
    tags = _sdk_call(payload, host_admission, sandbox.get_tags)
    if tags != {"factory_run": spec["runId"], "factory_role": role, "factory_spec": digest(spec)}:
        raise ValueError("Observed Sandbox role binding changed")
    if request["operation"] == "observe-role":
        if set(request["input"]) != {"resourceId"}:
            raise ValueError("Closed resource observation required")
        code = _sdk_call(payload, host_admission, sandbox.poll)
        if code is not None and type(code) is not int:
            raise ValueError("Invalid actual Sandbox poll result")
        observed_state = "sandbox_terminal_observed" if code is not None else "sandbox_running_observed"
        # A running poll never clears a prior termination/terminal launch fence.
        retirement = observed_state if code is not None or record["retirement"] not in RETIRED_STATES else record["retirement"]
        retained_code = record.get("returncode") if code is None and retirement == "sandbox_terminal_observed" else code
        record.update(returncode=retained_code, retirement=retirement)
        _write_checkpoint(request, record)
        return {"state": observed_state, "resourceId": sandbox.object_id,
                "returncode": code, "billingFinal": False, "admission": "NO_ADMISSION"}
    if request["operation"] == "terminate-role":
        if set(request["input"]) != {"resourceId"}:
            raise ValueError("Closed resource retirement required")
        record.update(retirement="terminate_requested_unverified")
        _write_checkpoint(request, record)
        _sdk_call(payload, host_admission, lambda: sandbox.terminate(wait=False))
        code = _sdk_call(payload, host_admission, sandbox.poll)
        if code is not None and type(code) is not int:
            raise ValueError("Invalid actual Sandbox poll result")
        record.update(returncode=code, retirement="sandbox_terminal_observed" if code is not None else "terminate_pending")
        _write_checkpoint(request, record)
        return {"state": record["retirement"], "resourceId": sandbox.object_id,
                "returncode": code, "billingFinal": False, "admission": "NO_ADMISSION"}

    # Launch cannot be replayed: SDK exec has no public durable reattach API.
    if record["launch"] != "not_requested" or record["endpoint"] is None:
        raise ValueError("Role launch requires the original observed fresh target")
    if role == "bootstrap":
        if set(request["input"]) != {"resourceId"}:
            raise ValueError("Closed bootstrap launch required")
        config = validate_bootstrap_config({"run_id": spec["runId"], "expires_at_unix": spec["expiresAtUnix"], "endpoint": record["endpoint"]})
        _sdk_call(payload, host_admission, lambda: sandbox.filesystem.write_bytes(canonical(config), "/run/communityai/bootstrap.json"))
        argv = ["python", "-u", "/opt/factory/communityai_runtime_watchdog.py", "--config", "/run/communityai/bootstrap.json"]
    else:
        if set(request["input"]) != {"resourceId", "formation"}:
            raise ValueError("Closed observed formation launch required")
        formation = request["input"]["formation"]
        plan = build_launch_plan(formation)
        if (formation["run_id"] != spec["runId"] or formation["expires_at_unix"] != spec["expiresAtUnix"]
                or formation["endpoints"][role] != record["endpoint"]):
            raise ValueError("Formation differs from the original resource binding")
        for target in ROLES:
            target_request = {**request, "role": target}
            if formation["endpoints"][target] != _owned(target_request)["endpoint"]:
                raise ValueError("Formation contains a different owned role endpoint")
        argv = (plan["text_peer"]["argv"] if role == "text_peer" else
                next(worker["argv"] for worker in plan["workers"] if worker["role"] == role))
    remaining = math.ceil(spec["expiresAtUnix"] - time.time())
    if remaining <= 0:
        raise ValueError("Role expired before exec")
    record.update(launch="exec_intent_running_no_replay")
    _write_checkpoint(request, record)
    process = _sdk_call(payload, host_admission, lambda: sandbox.exec(*argv, timeout=remaining, env=OFFLINE_ENV, text=True, bufsize=1))
    record.update(launch="exec_handle_returned_readiness_unverified")
    _write_checkpoint(request, record)
    # The actual live process handle stays with this trusted host invocation.
    # It is never encoded as a made-up public reattach identifier.
    return {"state": record["launch"], "resourceId": sandbox.object_id,
            "process": process, "admission": "NO_ADMISSION"}


def create_owned_coordinator(formation, *, host_admission, factory_admission, api_key_identifier):
    """Compose only in the trusted owner host; deployment/carrier remains external."""
    _gate(host_admission, {"operation": "compose-coordinator", "formation": formation})
    return create_coordinator_app(formation, factory_admission=factory_admission,
                                  api_key_identifier=api_key_identifier)
