"""One-operation Modal SDK bridge. Mutations require a running SQLite intent.

The Node coordinator protects storage with native ACLs before starting this
process. SDK/CLI diagnostics and resource checkpoints stay in that private tree.
"""

import argparse
import contextlib
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import tomllib
import uuid


MUTATIONS = {"create-volume", "deploy", "prefetch", "create-proxy-token", "stop-app", "delete-volume", "delete-proxy-token"}
CONFIG = json.loads(Path(__file__).with_name("config.json").read_text(encoding="utf-8"))


def write_json(filename, value):
    target = Path(filename)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def active_profile():
    config = Path.home() / ".modal.toml"
    data = tomllib.loads(config.read_text(encoding="utf-8")) if config.is_file() else {}
    candidates = [name for name, value in data.items() if isinstance(value, dict) and value.get("active") is True]
    if len(candidates) != 1:
        raise ValueError("Exactly one active Modal profile is required.")
    value = data[candidates[0]]
    if not value.get("token_id") or not value.get("token_secret"):
        raise ValueError("The active Modal profile must have credentials.")
    return candidates[0]


def verify_input(payload):
    operation = payload.get("operation")
    if operation not in MUTATIONS | {"prepare", "inspect", "meter", "reconcile-stop-app"}:
        raise ValueError("Unknown operation.")
    if payload.get("environment") != "main":
        raise ValueError("Only the selected main Environment is admitted.")
    for key in ("appName", "volumeName"):
        if not re.fullmatch(r"factory-[a-z0-9][a-z0-9-]{2,55}", payload.get(key, "")):
            raise ValueError("Explicit run-owned resource names are required.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", payload.get("runId", "")):
        raise ValueError("Stable run identity is required.")
    if operation != "prepare":
        root = Path(payload["runDirectory"])
        if not root.is_absolute() or not root.is_dir() or root.is_symlink():
            raise ValueError("Protected private run storage is required.")
    return operation


def require_admission(payload):
    if payload["operation"] not in MUTATIONS:
        return
    request = payload["request"]
    for key in ("operation", "runId", "appName", "volumeName", "environment", "profile", "workspaceName", "runDirectory", "volumeFsVersion"):
        if request.get(key) != payload.get(key):
            raise ValueError("Bridge arguments differ from the durable intent.")
    if Path(payload["journalPath"]).resolve() != Path(payload["runDirectory"], "modal.sqlite").resolve() or not re.fullmatch(r"[a-z0-9_-]{1,80}", payload.get("effectKey", "")):
        raise ValueError("The original operation journal and stable key are required.")
    encoded = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    connection = sqlite3.connect(f"file:{Path(payload['journalPath']).as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT operation,request_digest,state FROM modal_operations WHERE key=?", (payload["effectKey"],)).fetchone()
        if row != (payload["operation"], digest, "running"):
            raise ValueError("A matching durable running intent is required.")
    finally:
        connection.close()


def checkpoint(payload, changes=None):
    filename = Path(payload["runDirectory"]) / "resources.private.json"
    value = json.loads(filename.read_text(encoding="utf-8")) if filename.is_file() else {
        "runId": payload["runId"], "appName": payload["appName"], "volumeName": payload["volumeName"],
        "environment": payload["environment"], "profile": payload["profile"], "workspaceName": payload["workspaceName"],
    }
    if any(value.get(key) != payload.get(key) for key in ("runId", "appName", "volumeName", "environment", "profile", "workspaceName")):
        raise ValueError("Resource ownership checkpoint differs from the admitted run.")
    if changes:
        value.update(changes)
        write_json(filename, value)
    return value


def required_weights_version(payload, resources=None):
    version = payload.get("volumeFsVersion")
    if type(version) is not int or version != 2 or CONFIG.get("volumeFsVersion") != 2:
        raise ValueError("New model weights require the explicitly admitted VolumeFS v2.")
    if resources is not None and resources.get("volumeFsVersion") != version:
        raise ValueError("Owned model weights version differs from the admitted run.")
    return version


def owned_weights(modal, payload, resources):
    version = required_weights_version(payload, resources)
    if not resources.get("volumeCreated") or not resources.get("volumeId"):
        raise ValueError("The recorded owned model weights Volume is required.")
    volume = modal.Volume.from_name(payload["volumeName"], environment_name="main",
                                   create_if_missing=False, version=version).hydrate()
    if volume.object_id != resources["volumeId"]:
        raise ValueError("Model weights Volume identity differs from recorded ownership.")
    return volume


def owned_billing_observation(rows, resources, start, end):
    owned = {resources.get(key) for key in ("appId", "serveFunctionId", "prefetchFunctionId", "volumeId")} - {None}
    selected = [row for row in rows if row.object_id in owned and row.environment_name == "main"]
    base = {"state": "billing-unavailable", "observedAt": int(time.time() * 1000),
            "knownMeteredCents": 0, "resourceRows": len(selected), "ownedObjectCount": len(owned),
            "reportStart": start.isoformat(), "reportEnd": end.isoformat(),
            "final": False, "buildCostAttribution": "unverified",
            "meterScope": "recorded-owned-objects-completed-hours-only"}
    seen, positive_apps, positive_functions = set(), set(), set()
    function_ids = {resources.get(key) for key in ("serveFunctionId", "prefetchFunctionId")} - {None}
    observed_cost = Decimal(0)
    for row in selected:
        interval = row.interval_start
        if (not isinstance(interval, datetime) or interval.tzinfo is None or interval.utcoffset().total_seconds() != 0
                or interval.minute or interval.second or interval.microsecond or not start <= interval < end
                or not isinstance(row.cost, Decimal) or not row.cost.is_finite() or row.cost < 0):
            return {**base, "observationReason": "invalid-owned-row"}
        key = (row.object_id, row.environment_name, interval)
        if key in seen:
            return {**base, "observationReason": "duplicate-owned-interval"}
        seen.add(key)
        if row.cost > 0:
            if row.object_id == resources.get("appId"):
                positive_apps.add(interval)
            if row.object_id in function_ids:
                positive_functions.add(interval)
        # The SDK describes cost_by_resource as a breakdown of this total,
        # not additional charges. No tags, descriptions or account rows escape.
        observed_cost += row.cost
    if positive_apps & positive_functions:
        # The report has no hierarchy/additive-independence field. Do not
        # double count a possible App total and child Function compute.
        return {**base, "observationReason": "ambiguous-app-function-interval"}
    if selected:
        return {**base, "state": "billing-observed",
                "matchedRowCostUsdSum": str(observed_cost),
                "knownMeteredCents": int((observed_cost * 100).to_integral_value(rounding=ROUND_CEILING))}
    return base


def cli(payload, arguments, *, timeout_seconds=120):
    child_environment = os.environ.copy()
    child_environment["PYTHONUTF8"] = "1"
    child_environment["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run([sys.executable, "-m", "modal", *arguments, "--env", payload["environment"], "--profile", payload["profile"]],
                            env=child_environment, capture_output=True, text=True, encoding="utf-8", timeout=timeout_seconds, check=False)
    # Output can contain other account resources; it stays in private artifacts.
    stem = Path(payload["runDirectory"]) / f"cli-{payload['operation']}-{uuid.uuid4().hex}"
    stem.with_suffix(".stdout.private.txt").write_text(result.stdout, encoding="utf-8")
    stem.with_suffix(".stderr.private.txt").write_text(result.stderr, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError("Modal CLI outcome needs reconciliation.")
    return result.stdout


def app_inventory(payload, *, timeout_seconds=120):
    rows = json.loads(cli(payload, ["app", "list", "--json"], timeout_seconds=timeout_seconds))
    resources = checkpoint(payload)
    matched = [item for item in rows if item.get("app_id") == resources.get("appId")
               or item.get("App ID") == resources.get("appId")]
    if not matched:
        return {"state": "not-observed", "appId": resources.get("appId")}
    if len(matched) != 1:
        raise ValueError("Recorded App inventory is ambiguous.")
    row = matched[0]

    def field(canonical, legacy):
        if canonical in row and legacy in row:
            if type(row[canonical]) is not type(row[legacy]) or row[canonical] != row[legacy]:
                raise ValueError("Recorded App inventory has conflicting fields.")
        if canonical in row:
            return row[canonical]
        if legacy in row:
            return row[legacy]
        raise ValueError("Recorded App inventory lacks terminal-state evidence.")

    app_id = field("app_id", "App ID")
    description = field("description", "Description")
    state = field("state", "State")
    tasks = field("tasks", "Tasks")
    if app_id != resources.get("appId") or description != payload["appName"]:
        raise ValueError("Recorded App does not match its ownership name.")
    if not isinstance(state, str) or not state or type(tasks) not in (int, str):
        raise ValueError("Recorded App inventory has invalid lifecycle fields.")
    if isinstance(tasks, str) and not re.fullmatch(r"[0-9]+", tasks):
        raise ValueError("Recorded App inventory has invalid container evidence.")
    count = int(tasks)
    if count < 0:
        raise ValueError("Recorded App inventory has invalid container evidence.")
    return {"appId": app_id, "state": state, "runningContainers": count,
            "observedAt": int(time.time() * 1000)}


def wait_for_stopped_app(payload, *, timeout_seconds=45, poll_seconds=1):
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Recorded App terminal state is not confirmed.")
        observed = app_inventory(payload, timeout_seconds=remaining)
        if observed.get("state") == "stopped" and observed.get("runningContainers") == 0:
            return observed
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("Recorded App terminal state is not confirmed.")
        time.sleep(min(poll_seconds, remaining))


def require_stop_reconciliation(payload, resources):
    if payload.get("originalKey") != "stop-app" or not re.fullmatch(r"[a-f0-9]{64}", payload.get("originalRequestDigest", "")):
        raise ValueError("Only the original owned stop intent can be inspected for reconciliation.")
    filename = Path(payload["runDirectory"]) / "modal.sqlite"
    connection = sqlite3.connect(f"file:{filename.as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute("SELECT operation,request_digest,request_json,state,result_json FROM modal_operations WHERE key=?", (payload["originalKey"],)).fetchone()
    finally:
        connection.close()
    if not row or row[0] != "stop-app" or row[1] != payload["originalRequestDigest"]:
        raise ValueError("Original stop intent identity differs from reconciliation.")
    original = json.loads(row[2])
    encoded = json.dumps(original, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if hashlib.sha256(encoded).hexdigest() != row[1] or original.get("operation") != "stop-app":
        raise ValueError("Original stop request digest is not confirmed.")
    for key in ("runId", "appName", "volumeName", "environment", "profile", "workspaceName", "runDirectory"):
        if original.get(key) != payload.get(key):
            raise ValueError("Original stop ownership differs from reconciliation.")
    previous = json.loads(row[4]) if row[4] else {}
    if row[3] != "unknown" and not (row[3] == "succeeded" and previous.get("reconciled") is True and previous.get("appId") == resources.get("appId")):
        raise ValueError("Only an unknown original stop or its confirmed checkpoint repair is admitted.")
    if not resources.get("appDeployed") or not resources.get("appId") or payload.get("recordedAppId") != resources["appId"] or payload.get("recordedVolumeId") != resources.get("volumeId"):
        raise ValueError("Recorded resource identity differs from reconciliation.")


def operate(payload):
    operation = verify_input(payload)
    profile = payload.get("profile") or active_profile()
    for variable in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_SERVER_URL"):
        os.environ.pop(variable, None)
    # The profile is explicit per process. Global active-profile state is unchanged.
    os.environ["MODAL_PROFILE"] = profile
    payload["profile"] = profile
    os.environ["FACTORY_MODAL_APP_NAME"] = payload["appName"]
    os.environ["FACTORY_MODAL_VOLUME_NAME"] = payload["volumeName"]
    import modal
    from modal.exception import NotFoundError

    workspace = modal.Workspace.from_context()
    settings = workspace.settings.list()
    if operation == "prepare":
        if settings.default_environment != "main":
            raise ValueError("Selected profile does not default to the approved main Environment.")
        def absent(lookup):
            try:
                lookup()
                return False
            except NotFoundError:
                return True
        return {"state": "prepared", "profile": profile, "workspaceName": workspace.name,
                "environment": "main", "credentialsAccepted": True,
                "appAbsent": absent(lambda: modal.App.lookup(payload["appName"], environment_name="main")),
                "volumeAbsent": absent(lambda: modal.Volume.from_name(payload["volumeName"], environment_name="main", create_if_missing=False).hydrate())}

    if workspace.name != payload.get("workspaceName"):
        raise ValueError("Actual Workspace identity differs from the admitted profile.")
    require_admission(payload)
    if operation == "create-volume":
        version = required_weights_version(payload)
        modal.Volume.objects.create(payload["volumeName"], environment_name="main", version=version, allow_existing=False)
        volume = modal.Volume.from_name(payload["volumeName"], environment_name="main", create_if_missing=False, version=version).hydrate()
        checkpoint(payload, {"volumeId": volume.object_id, "volumeCreated": True, "volumeFsVersion": version})
        return {"state": "volume-created", "volumeId": volume.object_id, "volumeFsVersion": version}
    if operation == "deploy":
        resources = checkpoint(payload)
        volume = owned_weights(modal, payload, resources)
        try:
            modal.App.lookup(payload["appName"], environment_name="main")
        except NotFoundError:
            pass
        else:
            raise ValueError("App identity already exists; do not overwrite it.")
        os.environ["FACTORY_MODAL_VOLUME_ID"] = volume.object_id
        inference = importlib.import_module("inference")
        inference.app.deploy(environment_name="main", strategy="recreate", tag=payload["runId"])
        checkpoint(payload, {"appId": inference.app.app_id, "appDeployed": True})
        serve = modal.Function.from_name(payload["appName"], "serve", environment_name="main").hydrate()
        prefetch = modal.Function.from_name(payload["appName"], "prefetch", environment_name="main").hydrate()
        result = {"appId": inference.app.app_id, "serveFunctionId": serve.object_id,
                  "prefetchFunctionId": prefetch.object_id, "endpoint": serve.get_web_url()}
        checkpoint(payload, result)
        return {"state": "deployed", **result}
    resources = checkpoint(payload)
    if operation == "prefetch":
        volume = owned_weights(modal, payload, resources)
        function = modal.Function.from_name(payload["appName"], "prefetch", environment_name="main").hydrate()
        if function.object_id != resources.get("prefetchFunctionId"):
            raise ValueError("Prefetch Function identity changed.")
        result = function.remote()
        if (result.get("state") != "weights-cached" or result.get("volumeId") != volume.object_id
                or result.get("volumeFsVersion") != resources["volumeFsVersion"]):
            raise ValueError("Pinned weights were not confirmed.")
        checkpoint(payload, {"weightsCached": True})
        return result
    if operation == "create-proxy-token":
        if not resources.get("appDeployed") or not resources.get("serveFunctionId") or not resources.get("weightsCached"):
            raise ValueError("Proxy-token creation requires the recorded ready inference deployment.")
        token_path = Path(payload["runDirectory"]) / "proxy-token.private.json"
        if token_path.exists():
            raise ValueError("Private token checkpoint already exists.")
        token = modal.Workspace.from_context().proxy_tokens.create()
        write_json(token_path, {"runId": payload["runId"], "profile": profile, "environment": "main",
                               "tokenId": token.token_id, "tokenSecret": token.token_secret,
                               "bearer": token.token_id + "." + token.token_secret})
        checkpoint(payload, {"proxyTokenCreated": True, "proxyTokenId": token.token_id})
        return {"state": "proxy-token-created", "tokenStoredPrivately": True}
    if operation == "inspect":
        return app_inventory(payload)
    if operation == "reconcile-stop-app":
        require_stop_reconciliation(payload, resources)
        observed = app_inventory(payload, timeout_seconds=30)
        if observed.get("appId") != resources["appId"] or observed.get("state") != "stopped" or observed.get("runningContainers") != 0:
            raise ValueError("A fresh exact owned App terminal observation is required.")
        return {**observed, "originalKey": payload["originalKey"], "originalRequestDigest": payload["originalRequestDigest"],
                **{key: payload[key] for key in ("runId", "appName", "volumeName", "environment", "profile", "workspaceName")},
                "volumeId": resources.get("volumeId")}
    if operation == "stop-app":
        if not resources.get("appDeployed") or not resources.get("appId"):
            raise ValueError("No recorded owned App is available for retirement.")
        try:
            current = modal.App.lookup(payload["appName"], environment_name="main")
            if current.app_id != resources["appId"]:
                raise ValueError("Active App identity differs from recorded ownership.")
        except NotFoundError:
            observed = app_inventory(payload)
            if observed["state"] != "stopped" or observed.get("appId") != resources["appId"] or observed.get("runningContainers") != 0:
                raise ValueError("Recorded App terminal state is not confirmed.")
            checkpoint(payload, {"appStopped": True})
            return {"state": "stopped", "appId": resources["appId"], "alreadyStopped": True}
        cli(payload, ["app", "stop", resources["appId"], "--yes"])
        observed = wait_for_stopped_app(payload)
        if observed["state"] != "stopped" or observed.get("appId") != resources["appId"] or observed.get("runningContainers") != 0:
            raise ValueError("Recorded App terminal state is not confirmed.")
        checkpoint(payload, {"appStopped": True})
        return {"state": "stopped", **observed}
    if operation == "delete-volume":
        if not resources.get("volumeCreated") or not resources.get("appStopped", not resources.get("appDeployed")):
            raise ValueError("Owned Volume requires confirmed App retirement first.")
        # Original v1 runs have no v2 intent/metadata. Cleanup remains version-agnostic
        # and checks the exact recorded ID; it must never implicitly create a Volume.
        volume = modal.Volume.from_name(payload["volumeName"], environment_name="main", create_if_missing=False).hydrate()
        if volume.object_id != resources.get("volumeId"):
            raise ValueError("Volume identity differs from recorded ownership.")
        modal.Volume.objects.delete(payload["volumeName"], environment_name="main", allow_missing=False)
        try:
            modal.Volume.from_name(payload["volumeName"], environment_name="main", create_if_missing=False).hydrate()
        except NotFoundError:
            checkpoint(payload, {"volumeDeleted": True})
            return {"state": "volume-deleted", "volumeId": resources["volumeId"]}
        raise ValueError("Owned Volume deletion was not confirmed.")
    if operation == "delete-proxy-token":
        token_path = Path(payload["runDirectory"]) / "proxy-token.private.json"
        token = json.loads(token_path.read_text(encoding="utf-8"))
        if not resources.get("proxyTokenCreated") or token.get("runId") != payload["runId"] or token.get("profile") != profile or token.get("environment") != "main" or token.get("tokenId") != resources.get("proxyTokenId"):
            raise ValueError("New proxy-token ownership is not confirmed.")
        workspace = modal.Workspace.from_context()
        if not any(item.token_id == token["tokenId"] for item in workspace.proxy_tokens.list()):
            raise ValueError("Owned proxy-token outcome needs reconciliation.")
        workspace.proxy_tokens.delete(token["tokenId"])
        if any(item.token_id == token["tokenId"] for item in workspace.proxy_tokens.list()):
            raise ValueError("Owned proxy-token deletion was not confirmed.")
        checkpoint(payload, {"proxyTokenDeleted": True})
        return {"state": "proxy-token-deleted"}
    if operation == "meter":
        started = datetime.fromtimestamp(payload["startedAt"] / 1000, timezone.utc).replace(minute=0, second=0, microsecond=0)
        # SDK reports complete intervals and excludes a partial final hour.
        end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        if started >= end:
            return owned_billing_observation([], resources, started, end)
        rows = modal.Workspace.from_context().billing.report(start=started, end=end, resolution="h")
        return owned_billing_observation(rows, resources, started, end)
    raise ValueError("Unknown operation.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    operation = verify_input(payload)
    if operation in MUTATIONS and not args.execute:
        raise ValueError("Mutations require explicit execution.")
    started = time.monotonic()
    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            result = operate(payload)
        except Exception as error:
            result = {"state": "unknown", "errorType": type(error).__name__}
            code = 1
    if payload.get("runDirectory") and operation != "prepare":
        root = Path(payload["runDirectory"])
        stem = f"sdk-{operation}-{payload.get('effectKey', uuid.uuid4().hex)}"
        (root / f"{stem}.stdout.private.txt").write_text(stdout.getvalue(), encoding="utf-8")
        (root / f"{stem}.stderr.private.txt").write_text(stderr.getvalue(), encoding="utf-8")
        write_json(root / f"{stem}.result.private.json", result)
    result.update({"operation": operation, "elapsedMs": round((time.monotonic() - started) * 1000)})
    print(json.dumps(result))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"state": "unknown", "errorType": "BridgeAdmissionError"}))
        sys.exit(1)
