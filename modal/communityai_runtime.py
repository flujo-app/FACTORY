"""Runtime recipe and an owned TLS DHT bootstrap for the fixed CommunityAI mesh.

No deployment/build/resource/admission operation occurs at import. The trusted
provider supervisor owns every start, identity file, model cache and retirement.
The bootstrap observes only its own DHT startup; it cannot prove peer reachability,
distributed inference, Original admission or provider retirement.
Observer publication is bounded, but a timed-out daemon callback may act later.
Run this CLI under communityai_runtime_watchdog.py for the outer process deadline;
even that process exit is not descendant or provider retirement evidence.

Image inputs use CommunityAI source commit 2d08f31aa58c2c7b49304d0367ab51ae9aaccb11,
its repaired API lock, and digest-pinned Python/uv images. cpufeature has no
Linux CPython 3.12 wheel. The owner-exported coherent source context and immutable
Python 3.12.13 compiler/build-tools image are required before building. No dependency re-resolution or build is attempted here.
The copied model manifest is distinct from catalog approval. Signed catalog
freshness and strict Original receiver compatibility remain owner prerequisites.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import tomllib

SOURCE_COMMIT = "2d08f31aa58c2c7b49304d0367ab51ae9aaccb11"
RETAINED_LOCK_SHA256 = "5348107dfc88034c60197d03379dac789cafd2b97e12cce1577c6c2ea14d5fb5"
PYTHON_IMAGE = "python:3.12.13-slim-bookworm@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af"
UV_IMAGE = "ghcr.io/astral-sh/uv:0.11.21@sha256:6f1fa8fc4040ad7197d7e652057219871e5f6640abfe2b790f1419fdb2319e6b"
IDENTITY_PATH = "/run/communityai/bootstrap.key"
DOCKERFILE_PATH = Path(__file__).with_name("Dockerfile.communityai-runtime")
ENDPOINT_FIELDS = {"resource_id", "ipv4", "public_port", "listen_port", "transport", "application_tls"}
OBSERVER_TIMEOUT_SECONDS = 1


class BootstrapError(RuntimeError):
    def __init__(self, record):
        super().__init__("CommunityAI TLS bootstrap failed; inspect the retained lifecycle record")
        self.record = record


def inspect_dependency_inputs(source_root):
    """Expose the current concrete prerequisites; this never installs/resolves."""
    root = Path(source_root)
    raw_lock = (root / "uv.lock").read_bytes()
    raw_project = (root / "pyproject.toml").read_bytes()
    lock, project = tomllib.loads(raw_lock.decode()), tomllib.loads(raw_project.decode())
    package = next(item for item in lock["package"] if item["name"] == "drift")
    api_names = {re.match(r"[A-Za-z0-9_-]+", value)[0].lower().replace("_", "-")
                 for value in project["project"]["optional-dependencies"]["api"]}
    locked_api = {item["name"] for item in package["optional-dependencies"]["api"]}
    cpufeature = next(item for item in lock["package"] if item["name"] == "cpufeature")
    has_cp312_wheel = any("cp312" in item["url"] and "linux" in item["url"] and "x86_64" in item["url"]
                         for item in cpufeature.get("wheels", []))
    return {"source_commit_prerequisite": SOURCE_COMMIT,
            "source_provenance": "must_be_exported_by_owner_from_pinned_commit",
            "lock_sha256": hashlib.sha256(raw_lock).hexdigest(),
            "project_sha256": hashlib.sha256(raw_project).hexdigest(),
            "api_dependencies_missing_from_lock": sorted(api_names - locked_api),
            "cpufeature_version": cpufeature["version"], "cpufeature_linux_cp312_wheel": has_cp312_wheel,
            "python_image": PYTHON_IMAGE, "uv_image": UV_IMAGE,
            "build_runtime_prerequisite": "digest-pinned linux/amd64 Python 3.12.13 + compiler + exact setuptools/wheel build tools",
            "image_built": False, "image_qualified": False}


def image_build_argv(context_directory, *, build_runtime_image, image_tag):
    """An unexecuted owner command; arguments/labels are not deployment proof."""
    if (not isinstance(build_runtime_image, str)
            or re.fullmatch(r"[a-z0-9./:_-]+@sha256:[0-9a-f]{64}", build_runtime_image) is None):
        raise ValueError("An immutable compiler/build-tools image reference is required")
    if not isinstance(image_tag, str) or re.fullmatch(r"[a-z0-9./_-]+:[A-Za-z0-9_.-]{1,128}", image_tag) is None:
        raise ValueError("An explicit credential-free image tag is required")
    return ["docker", "buildx", "build", "--platform", "linux/amd64", "--load",
            "--file", str(DOCKERFILE_PATH), "--build-arg", f"BUILD_RUNTIME_IMAGE={build_runtime_image}",
            "--label", f"org.opencontainers.image.revision={SOURCE_COMMIT}", "--tag", image_tag,
            str(Path(context_directory))]


def validate_bootstrap_config(config, *, now=None):
    if type(config) is not dict or set(config) != {"run_id", "expires_at_unix", "endpoint"}:
        raise ValueError("Exact owned bootstrap configuration required")
    if (not isinstance(config["run_id"], str)
            or re.fullmatch(r"factory-[a-z0-9][a-z0-9-]{2,55}", config["run_id"]) is None):
        raise ValueError("Explicit run-owned factory- name required")
    now = time.time() if now is None else now
    expires = config["expires_at_unix"]
    if (type(now) not in (int, float) or type(expires) not in (int, float)
            or not math.isfinite(now) or not math.isfinite(expires) or not now < expires <= now + 21600):
        raise ValueError("Fresh bounded bootstrap expiry required")
    item = config["endpoint"]
    if type(item) is not dict or set(item) != ENDPOINT_FIELDS:
        raise ValueError("Actual raw TCP endpoint observation required")
    if (item["transport"] != "modal-raw-tcp" or item["application_tls"] is not True
            or not isinstance(item["resource_id"], str)
            or re.fullmatch(r"sb-[A-Za-z0-9_-]{1,128}", item["resource_id"]) is None):
        raise ValueError("Raw Modal TCP carrying application TLS required")
    try:
        ip = ipaddress.IPv4Address(item["ipv4"])
    except (ValueError, TypeError) as exc:
        raise ValueError("Actual global IPv4 tunnel address required") from exc
    if not ip.is_global or str(ip) != item["ipv4"]:
        raise ValueError("Actual global IPv4 tunnel address required")
    for name in ("public_port", "listen_port"):
        if type(item[name]) is not int or not 1 <= item[name] <= 65535:
            raise ValueError("Actual public and listen ports required")
    return {**config, "endpoint": dict(item)}


async def _observe_bootstrap(_dht, node):
    """One child-side observation; parent consumes its future with a deadline."""
    return str(node.peer_id), [str(address) for address in await node.get_visible_maddrs(latest=True)]


def _publish_bounded(observer, record, timeout):
    """Bound a trusted callback, not its possible later side effects.

    Python cannot interrupt a blocked callback. The daemon thread is deliberately
    abandoned on timeout so the caller can close its DHT; a process supervisor
    must still enforce a hard lifetime for this dedicated runtime process.
    """
    outcome, finished = {}, threading.Event()
    snapshot = json.loads(json.dumps(record))

    def invoke():
        try:
            if observer(snapshot) is not None:
                raise TypeError("Lifecycle observer must return None synchronously")
        except BaseException as exc:
            outcome["error"] = exc
        finally:
            finished.set()

    threading.Thread(target=invoke, name="communityai-lifecycle-observer", daemon=True).start()
    if not finished.wait(timeout):
        return "stalled", TimeoutError("Lifecycle observer did not return within its publication bound")
    if "error" in outcome:
        return "failed", outcome["error"]
    return "completed", None


def _emit_cli_record(record, *, fd=None):
    """One small raw write; the CLI makes its Linux stdout nonblocking first."""
    payload = (json.dumps(record, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(payload) > 4096:
        raise ValueError("Lifecycle observation is oversized")
    target = sys.stdout.fileno() if fd is None else fd
    if os.write(target, payload) != len(payload):
        raise OSError("Incomplete lifecycle observation")


def run_tls_bootstrap(config, *, stop_event=None, observer=None):
    """Run one real TLS bootstrap after the supervisor's resource admission.

    The observer receives public lifecycle facts only; credentials stay private.
    No retry/restart is performed. Publication failure aborts and closes the DHT.
    Config is caller-supplied, not authenticated provider or Original evidence.
    """
    config = validate_bootstrap_config(config)
    if observer is not None and (not callable(observer) or inspect.iscoroutinefunction(observer)
                                 or inspect.iscoroutinefunction(getattr(observer, "__call__", None))):
        raise ValueError("A synchronous lifecycle observer is required")
    stop_event = threading.Event() if stop_event is None else stop_event
    if not callable(getattr(stop_event, "is_set", None)) or not callable(getattr(stop_event, "wait", None)):
        raise ValueError("A supervisor-owned stop event is required")
    endpoint = config["endpoint"]
    record = {"run_id": config["run_id"], "resource_id": endpoint["resource_id"],
              "scope": "tls_bootstrap_only", "configuration_provenance": "not_authenticated",
              "phase": "not_started", "failure_type": None, "peer_id": None, "bootstrap_peers": [],
              "cleanup": "not_requested", "cleanup_errors": [], "provider_retirement": "unverified",
              "descendant_retirement": "unverified", "startup_publication": "not_attempted",
              "final_publication": "not_attempted", "observer_late_side_effects": "none"}
    dht = None
    failure = None
    try:
        if stop_event.is_set():
            record["phase"] = "stopped_before_start"
        else:
            from drift.protocol_identity import NodeIdentity
            from drift.utils.process_lifetime import tie_child_processes_to_this_process
            from hivemind import DHT

            if tie_child_processes_to_this_process() is not True:
                raise RuntimeError("Required child process lifetime guard is unavailable")
            identity = NodeIdentity.ensure(IDENTITY_PATH)
            if stop_event.is_set() or time.time() >= config["expires_at_unix"]:
                record["phase"] = "stopped_before_transport"
                return record
            record["phase"] = "starting"
            dht = DHT(initial_peers=[], start=False, identity_path=IDENTITY_PATH,
                      host_maddrs=[f'/ip4/0.0.0.0/tcp/{endpoint["listen_port"]}'],
                      announce_maddrs=[f'/ip4/{endpoint["ipv4"]}/tcp/{endpoint["public_port"]}'],
                      client_mode=False, tls=True, use_relay=False, use_auto_relay=False,
                      startup_timeout=15, shutdown_timeout=5)
            remaining = min(15, config["expires_at_unix"] - time.time())
            if remaining <= 0 or stop_event.is_set():
                record["phase"] = "stopped_before_transport"
                return record
            startup_deadline = time.monotonic() + remaining
            dht.run_in_background(timeout=remaining)
            remaining = min(startup_deadline - time.monotonic(), config["expires_at_unix"] - time.time())
            if remaining <= 0:
                raise TimeoutError("Bootstrap startup observation deadline expired")
            if stop_event.is_set():
                record["phase"] = "supervisor_stop"
                return record
            observation = dht.run_coroutine(_observe_bootstrap, return_future=True)
            peer_id, visible = observation.result(timeout=remaining)
            if not dht.is_alive() or peer_id != str(identity.peer_id):
                raise RuntimeError("Bootstrap transport identity/startup mismatch")
            expected = f'/ip4/{endpoint["ipv4"]}/tcp/{endpoint["public_port"]}/p2p/{peer_id}'
            if expected not in visible:
                raise RuntimeError("Visible bootstrap address differs from the actual tunnel")
            if stop_event.is_set() or time.time() >= config["expires_at_unix"]:
                record["phase"] = "supervisor_stop" if stop_event.is_set() else "expiry_stop"
                return record
            record.update(phase="started_reachability_unverified", peer_id=peer_id, bootstrap_peers=[expected])
            if observer is not None:
                record["startup_publication"] = "in_progress"
                try:
                    outcome, error = _publish_bounded(observer, record, min(
                        OBSERVER_TIMEOUT_SECONDS, max(0, config["expires_at_unix"] - time.time())))
                except BaseException as exc:
                    outcome, error = "failed", exc
                record["startup_publication"] = outcome
                if outcome == "stalled":
                    record["observer_late_side_effects"] = "possible_stalled_daemon"
                if error is not None:
                    raise error
            while not stop_event.is_set():
                if time.time() >= config["expires_at_unix"]:
                    record["phase"] = "expiry_stop"
                    break
                if not dht.is_alive():
                    raise RuntimeError("Bootstrap DHT exited unexpectedly")
                stop_event.wait(min(1, max(0, config["expires_at_unix"] - time.time())))
            if record["phase"] == "started_reachability_unverified":
                record["phase"] = "supervisor_stop"
    except BaseException as exc:
        failure = exc
        record.update(phase="failed", failure_type=type(exc).__name__)
    finally:
        record["cleanup"] = "close_requested"
        if dht is not None:
            try:
                dht.shutdown()
                record["cleanup"] = "dht_process_closed" if not dht.is_alive() else "dht_process_still_alive"
            except BaseException as exc:
                record["cleanup_errors"].append(type(exc).__name__)
                record["cleanup"] = "close_failed"
        else:
            record["cleanup"] = "no_dht_created"
        if observer is not None:
            if record["startup_publication"] == "stalled":
                # The first callback may still run. Never start a concurrent final callback.
                record["final_publication"] = "skipped_startup_stalled"
            else:
                record["final_publication"] = "in_progress"
                try:
                    outcome, error = _publish_bounded(observer, record, OBSERVER_TIMEOUT_SECONDS)
                except BaseException as exc:
                    outcome, error = "failed", exc
                record["final_publication"] = outcome
                if outcome == "stalled":
                    record["observer_late_side_effects"] = "possible_stalled_daemon"
                if error is not None:
                    record["cleanup_errors"].append(f"observer:{type(error).__name__}")
        if failure is not None or record["cleanup_errors"] or record["cleanup"] == "dht_process_still_alive":
            raise BootstrapError(record) from failure
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("role", choices=["bootstrap"])
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    raw = args.config.read_bytes()
    if len(raw) > 16384:
        raise ValueError("Bootstrap configuration is oversized")
    config = json.loads(raw)
    # This entry point runs as its own process. A full log pipe must not hold a
    # buffered TextIO lock while cleanup tries to complete in another thread.
    if sys.platform.startswith("linux"):
        os.set_blocking(sys.stdout.fileno(), False)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    run_tls_bootstrap(config, stop_event=stopped, observer=_emit_cli_record)


if __name__ == "__main__":
    main()
