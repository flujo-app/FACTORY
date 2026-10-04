"""Process lifetime fence for the dedicated CommunityAI TLS bootstrap.

The child emits its own provisional startup and final lifecycle observations.
This wrapper never treats a child exit or a process-group signal as provider
retirement proof. It starts no provider resource and performs no network call.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from communityai_runtime import validate_bootstrap_config


RUNTIME_PATH = Path(__file__).with_name("communityai_runtime.py")
GRACE_SECONDS = 7


def _read_config(path):
    raw = Path(path).read_bytes()
    if len(raw) > 16384:
        raise ValueError("Bootstrap configuration is oversized")
    return validate_bootstrap_config(json.loads(raw))


def _signal_child_group(child, *, hard):
    try:
        if sys.platform.startswith("linux"):
            os.killpg(child.pid, signal.SIGKILL if hard else signal.SIGTERM)
        elif hard:
            child.kill()
        else:
            child.terminate()
    except ProcessLookupError:
        pass


def supervise_bootstrap(config_path, *, stop_event=None, grace_seconds=GRACE_SECONDS,
                        child_argv=None, popen=subprocess.Popen):
    """Bound a child process, with Linux process-group termination on expiry/stop.

    `child_argv` and `popen` are test seams. Production always uses the fixed
    runtime command and must run on Linux, the target image platform.
    """
    if not 0 < grace_seconds <= GRACE_SECONDS:
        raise ValueError("A bounded cleanup grace is required")
    if child_argv is None and not sys.platform.startswith("linux"):
        raise RuntimeError("Production bootstrap supervision requires Linux")
    config = _read_config(config_path)
    stop_event = threading.Event() if stop_event is None else stop_event
    if not callable(getattr(stop_event, "is_set", None)):
        raise ValueError("A supervisor stop event is required")
    deadline = time.monotonic() + max(0, config["expires_at_unix"] - time.time())
    argv = [sys.executable, "-u", str(RUNTIME_PATH), "bootstrap", "--config", str(config_path)] if child_argv is None else list(child_argv)
    if not argv or not all(isinstance(value, str) and value for value in argv):
        raise ValueError("A test child command is required")
    if stop_event.is_set() or time.monotonic() >= deadline:
        return {"reason": "stopped_before_child" if stop_event.is_set() else "expired_before_child",
                "child_returncode": None, "forced_kill": False,
                "descendant_retirement": "no_child_created", "provider_retirement": "unverified"}
    child = popen(argv, stdin=subprocess.DEVNULL, start_new_session=sys.platform.startswith("linux"))
    reason = "child_exit"
    forced = False
    try:
        while child.poll() is None:
            if stop_event.is_set():
                reason = "supervisor_stop"
                break
            if time.monotonic() >= deadline:
                reason = "expiry_stop"
                break
            try:
                child.wait(timeout=min(0.2, max(0.001, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
        if child.poll() is None:
            _signal_child_group(child, hard=False)
            try:
                child.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                forced = True
                _signal_child_group(child, hard=True)
                child.wait(timeout=2)
        # A DHT descendant can outlive the Python child even after it exits.
        # Provider-owned sandbox retirement and descendant checks remain required.
        return {"reason": reason, "child_returncode": child.returncode,
                "forced_kill": forced, "descendant_retirement": "unverified",
                "provider_retirement": "unverified"}
    finally:
        if child.poll() is None:
            _signal_child_group(child, hard=True)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    result = supervise_bootstrap(args.config, stop_event=stopped)
    # Child observations remain the only lifecycle records. An absent final
    # record or any forced kill is unverified cleanup, never success evidence.
    return 0 if result["child_returncode"] == 0 and not result["forced_kill"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
