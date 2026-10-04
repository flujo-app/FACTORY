"""Fresh owned SQLite + SDK doubles only: no provider, credential or model call."""

from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import communityai_modal_driver as driver


NOW = 1791118800


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="factory-modal-role-")
        self.directory = Path(self.temp.name)
        self.journal = self.directory / "modal.sqlite"
        self.spec = {"runId": "factory-distributed-test", "appName": "factory-owned-app", "appId": "ap-owned",
                     "imageRef": "registry.example/factory@sha256:" + "a" * 64, "imageId": "im-owned",
                     "volumeId": "vo-owned", "volumeEvidenceSha256": "b" * 64,
                     "manifestDigest": driver.MANIFEST_DIGEST, "modelRevision": driver.REVISION,
                     "expiresAtUnix": NOW + 300, "reservationId": "roles-budget", "ceilingCents": 1000, "gpu": "T4"}
        self.db = sqlite3.connect(self.journal)
        self.db.execute("CREATE TABLE modal_operations(key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_digest TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL)")
        self.calls, self.sandboxes, self.gates = [], {}, []
        self.tunnel_failure, self.exec_failure, self.create_failure, self.terminate_failure, self.denied = False, False, False, False, False
        fixture = self

        class Sandbox:
            def __init__(self, resource_id, role, tags):
                self.object_id, self.role, self.tags = resource_id, role, tags
                self.filesystem = SimpleNamespace(write_bytes=self.write_bytes)
                self.code = None

            def get_tags(self):
                fixture.calls.append(("get_tags", self.object_id))
                return self.tags

            def tunnels(self, timeout):
                fixture.calls.append(("tunnels", self.object_id, timeout))
                if fixture.tunnel_failure:
                    raise TimeoutError("synthetic-private-provider-diagnostic")
                index = driver.ROLES.index(self.role)
                return {31330: SimpleNamespace(tcp_socket=(f"r{index}.modal.test", 42000 + index))}

            def write_bytes(self, data, remote_path):
                fixture.calls.append(("write_bytes", self.object_id, data, remote_path))

            def exec(self, *args, **kwargs):
                fixture.calls.append(("exec", self.object_id, args, kwargs))
                if fixture.exec_failure:
                    raise TimeoutError("synthetic-lost-exec-ack")
                return SimpleNamespace(stdout="actual-double-stream", sandbox=self.object_id)

            def terminate(self, wait):
                fixture.calls.append(("terminate", self.object_id, wait))
                if fixture.terminate_failure:
                    raise TimeoutError("synthetic-lost-terminate-ack")

            def poll(self):
                fixture.calls.append(("poll", self.object_id))
                return self.code

        class SandboxApi:
            @staticmethod
            def create(*args, **kwargs):
                fixture.calls.append(("create", args, kwargs))
                if fixture.create_failure:
                    raise TimeoutError("synthetic-lost-create-response")
                resource_id = f"sb-double-{len(fixture.sandboxes)}"
                sandbox = Sandbox(resource_id, kwargs["tags"]["factory_role"], kwargs["tags"])
                fixture.sandboxes[resource_id] = sandbox
                return sandbox

            @staticmethod
            def from_id(resource_id, client):
                if client is not fixture.handles["client"]:
                    raise AssertionError("Existing explicit host client required")
                fixture.calls.append(("from_id", resource_id))
                return fixture.sandboxes[resource_id]

        self.sdk = SimpleNamespace(Sandbox=SandboxApi)
        self.volume = SimpleNamespace(object_id="vo-owned", with_mount_options=self.mount)
        self.handles = {"app": SimpleNamespace(app_id="ap-owned"), "image": SimpleNamespace(object_id="im-owned"),
                        "volume": self.volume, "client": object()}

    def mount(self, **kwargs):
        self.calls.append(("mount", kwargs))
        return self.volume

    def gate(self, request):
        self.gates.append(copy.deepcopy(request))
        return not self.denied

    def payload(self, role, operation, value=None, *, state="running"):
        request = {"operation": operation, "role": role, "spec": self.spec,
                   "runDirectory": str(self.directory), "input": value}
        key = f"{operation}-{role}"
        if operation != "observe-role":
            self.db.execute("INSERT INTO modal_operations VALUES(?,?,?,?,?,NULL,?,?)",
                            (key, f"{operation}:{role}", driver.digest(request), json.dumps(request), state, NOW, NOW))
            self.db.commit()
        else:
            key = f"create-role-{role}"
        return {"key": key, "journalPath": str(self.journal), "request": request}

    def dispatch(self, payload):
        return driver.dispatch(payload, host_admission=self.gate, handles=self.handles,
                               sdk=self.sdk, resolve_ipv4=lambda host: f"8.8.8.{int(host[1]) + 1}")

    def create(self, role):
        return self.dispatch(self.payload(role, "create-role"))

    def record(self, role):
        return json.loads((self.directory / f"{role}-resource.private.json").read_bytes())

    def formation(self):
        endpoints = {role: self.record(role)["endpoint"] for role in driver.ROLES}
        peer = f'/ip4/{endpoints["bootstrap"]["ipv4"]}/tcp/{endpoints["bootstrap"]["public_port"]}/p2p/12D3KooW' + "A" * 40
        return {"run_id": self.spec["runId"], "manifest_digest": driver.MANIFEST_DIGEST,
                "expires_at_unix": self.spec["expiresAtUnix"], "endpoints": endpoints, "bootstrap_peers": [peer]}

    def close(self):
        self.db.close()
        self.temp.cleanup()


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        # One fixture clock scope also covers controlled concurrent dispatches.
        clock = patch.object(driver.time, "time", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)

    def test_four_distinct_roles_actual_raw_tcp_ports_read_only_artifact_mounts_and_two_gpus(self):
        for role in driver.ROLES:
            result = self.f.create(role)
            self.assertEqual(result["admission"], "NO_ADMISSION")
            record = self.f.record(role)
            self.assertEqual(record["tcpSocket"][1], 42000 + driver.ROLES.index(role))
            self.assertTrue(record["endpoint"]["application_tls"])
        creates = [call for call in self.f.calls if call[0] == "create"]
        self.assertEqual(len(creates), 4)
        self.assertEqual([call[2]["gpu"] for call in creates], [None, "T4", "T4", None])
        self.assertTrue(all(call[2]["unencrypted_ports"] == [31330] and call[2]["timeout"] == 300 for call in creates))
        self.assertEqual([call for call in self.f.calls if call[0] == "mount"], [("mount", {"read_only": True})] * 4)

    def test_denied_host_and_nonrunning_intents_make_zero_sdk_calls(self):
        payload = self.f.payload("bootstrap", "create-role", state="accepted")
        self.f.denied = True
        with self.assertRaises(PermissionError):
            self.f.dispatch(payload)
        self.f.denied = False
        with self.assertRaises(PermissionError):
            self.f.dispatch(payload)
        self.assertEqual(self.f.calls, [])

    def test_changed_durable_intent_rejected_before_sdk_and_no_default_host(self):
        payload = self.f.payload("bootstrap", "create-role")
        payload["request"]["spec"] = {**self.f.spec, "volumeId": "vo-other"}
        with self.assertRaises(PermissionError):
            self.f.dispatch(payload)
        with self.assertRaises(ValueError):
            driver.dispatch(payload, host_admission=None, sdk=self.f.sdk)
        self.assertEqual(self.f.calls, [])

    def test_tunnel_failure_retains_created_id_and_same_create_never_replays(self):
        self.f.tunnel_failure = True
        payload = self.f.payload("bootstrap", "create-role")
        with self.assertRaises(TimeoutError):
            self.f.dispatch(payload)
        self.assertEqual(self.f.record("bootstrap")["resourceId"], "sb-double-0")
        self.assertIsNone(self.f.record("bootstrap")["endpoint"])
        with self.assertRaises(ValueError):
            self.f.dispatch(payload)
        self.assertEqual(sum(call[0] == "create" for call in self.f.calls), 1)

    def test_bootstrap_exec_uses_fixed_watchdog_and_exact_actual_config(self):
        result = self.f.create("bootstrap")
        result = self.f.dispatch(self.f.payload("bootstrap", "launch-role", {"resourceId": result["resourceId"]}))
        self.assertIsNotNone(result["process"])
        write = next(call for call in self.f.calls if call[0] == "write_bytes")
        config = json.loads(write[2])
        self.assertEqual(config["endpoint"], self.f.record("bootstrap")["endpoint"])
        command = next(call for call in self.f.calls if call[0] == "exec")
        self.assertEqual(command[2], ("python", "-u", "/opt/factory/communityai_runtime_watchdog.py", "--config", "/run/communityai/bootstrap.json"))

    def test_model_roles_held_before_sdk_or_claim_even_with_matching_running_intents(self):
        for role in ("worker_0", "worker_1", "text_peer"):
            payload = self.f.payload(role, "launch-role", {"resourceId": "sb-unknown", "formation": {}})
            with self.assertRaisesRegex(PermissionError, "local-only artifact_root"):
                self.f.dispatch(payload)
            self.assertFalse((self.f.directory / f"{role}-launch-role-dispatch.private.json").exists())
            self.assertFalse((self.f.directory / f"{role}-checkpoint.lock").exists())
        self.assertEqual(self.f.calls, [])

    def test_lost_exec_ack_marks_no_replay_and_owned_retirement_stays_unsettled(self):
        created = self.f.create("bootstrap")
        self.f.exec_failure = True
        payload = self.f.payload("bootstrap", "launch-role", {"resourceId": created["resourceId"]})
        with self.assertRaises(TimeoutError):
            self.f.dispatch(payload)
        self.assertEqual(self.f.record("bootstrap")["launch"], "exec_intent_running_no_replay")
        with self.assertRaises(FileExistsError):
            self.f.dispatch(payload)
        self.assertEqual(sum(call[0] == "exec" for call in self.f.calls), 1)
        self.f.denied = False
        retirement = self.f.dispatch(self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]}))
        self.assertEqual(retirement["state"], "terminate_pending")
        self.assertFalse(retirement["billingFinal"])
        self.f.sandboxes[created["resourceId"]].code = 137
        observed = self.f.dispatch(self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]}))
        self.assertEqual(observed["state"], "sandbox_terminal_observed")
        self.assertFalse(observed["billingFinal"])
        self.assertEqual(sum(call[0] == "terminate" for call in self.f.calls), 1)

    def test_lost_create_response_without_id_has_no_replay_even_with_running_row(self):
        self.f.create_failure = True
        payload = self.f.payload("bootstrap", "create-role")
        with self.assertRaises(TimeoutError):
            self.f.dispatch(payload)
        self.assertFalse((self.f.directory / "bootstrap-resource.private.json").exists())
        with self.assertRaises(FileExistsError):
            self.f.dispatch(payload)
        self.assertEqual(sum(call[0] == "create" for call in self.f.calls), 1)

    def test_pending_retirement_dispatch_marker_survives_observation_and_never_replays(self):
        created = self.f.create("bootstrap")
        payload = self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]})
        self.f.dispatch(payload)
        self.f.dispatch(self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]}))
        self.assertEqual(self.f.record("bootstrap")["retirement"], "terminate_pending")
        calls = len(self.f.calls)
        with self.assertRaises(FileExistsError):
            self.f.dispatch(payload)
        self.assertEqual(len(self.f.calls), calls)

    def test_observation_during_exec_cannot_erase_newer_launch_checkpoint(self):
        created = self.f.create("bootstrap")
        other = self.f.create("worker_0")
        launch = self.f.payload("bootstrap", "launch-role", {"resourceId": created["resourceId"]})
        observe = self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]})
        other_observe = self.f.payload("worker_0", "observe-role", {"resourceId": other["resourceId"]})
        sandbox = self.f.sandboxes[created["resourceId"]]
        original_exec = sandbox.exec
        entered, release = threading.Event(), threading.Event()

        def blocked_exec(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Controlled exec release deadline")
            return original_exec(*args, **kwargs)

        sandbox.exec = blocked_exec
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.f.dispatch, launch)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.f.record("bootstrap")["launch"], "exec_intent_running_no_replay")
                calls = len(self.f.calls)
                with self.assertRaises(driver.RoleBusyError):
                    self.f.dispatch(observe)
                self.assertEqual(len(self.f.calls), calls)
                # An independent role remains observable under its own lock.
                self.assertEqual(self.f.dispatch(other_observe)["state"], "sandbox_running_observed")
            finally:
                release.set()
            self.assertIsNotNone(future.result(timeout=5)["process"])
        observed = self.f.dispatch(observe)
        self.assertEqual(observed["state"], "sandbox_running_observed")
        self.assertEqual(self.f.record("bootstrap")["launch"], "exec_handle_returned_readiness_unverified")
        self.assertEqual(sum(call[0] == "exec" for call in self.f.calls), 1)

    def test_termination_interleaving_and_later_running_observation_fence_launch(self):
        created = self.f.create("bootstrap")
        terminate = self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]})
        launch = self.f.payload("bootstrap", "launch-role", {"resourceId": created["resourceId"]})
        observe = self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]})
        sandbox = self.f.sandboxes[created["resourceId"]]
        original_terminate = sandbox.terminate
        entered, release = threading.Event(), threading.Event()

        def blocked_terminate(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Controlled termination release deadline")
            return original_terminate(*args, **kwargs)

        sandbox.terminate = blocked_terminate
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.f.dispatch, terminate)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.f.record("bootstrap")["retirement"], "terminate_requested_unverified")
                calls = len(self.f.calls)
                with self.assertRaises(driver.RoleBusyError):
                    self.f.dispatch(launch)
                self.assertEqual(len(self.f.calls), calls)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=5)["state"], "terminate_pending")
        self.assertEqual(self.f.dispatch(observe)["state"], "sandbox_running_observed")
        self.assertEqual(self.f.record("bootstrap")["retirement"], "terminate_pending")
        calls = len(self.f.calls)
        with self.assertRaisesRegex(PermissionError, "Retired role"):
            self.f.dispatch(launch)
        self.assertEqual(len(self.f.calls), calls)
        self.assertEqual(self.f.record("bootstrap")["launch"], "not_requested")
        self.assertFalse((self.f.directory / "bootstrap-launch-role-dispatch.private.json").exists())
        self.assertFalse(any(call[0] in {"write_bytes", "exec"} for call in self.f.calls))

    def test_lost_termination_ack_and_terminal_observation_fence_launch(self):
        created = self.f.create("bootstrap")
        launch = self.f.payload("bootstrap", "launch-role", {"resourceId": created["resourceId"]})
        self.f.terminate_failure = True
        with self.assertRaises(TimeoutError):
            self.f.dispatch(self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]}))
        self.assertEqual(self.f.record("bootstrap")["retirement"], "terminate_requested_unverified")
        calls = len(self.f.calls)
        with self.assertRaises(PermissionError):
            self.f.dispatch(launch)
        self.assertEqual(len(self.f.calls), calls)

        sandbox = self.f.sandboxes[created["resourceId"]]
        sandbox.code = 137
        observe = self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]})
        self.assertEqual(self.f.dispatch(observe)["state"], "sandbox_terminal_observed")
        sandbox.code = None  # Even inconsistent later running evidence is no revival.
        self.assertEqual(self.f.dispatch(observe)["state"], "sandbox_running_observed")
        self.assertEqual(self.f.record("bootstrap")["retirement"], "sandbox_terminal_observed")
        calls = len(self.f.calls)
        with self.assertRaises(PermissionError):
            self.f.dispatch(launch)
        self.assertEqual(len(self.f.calls), calls)

    def test_already_terminal_retirement_preserves_result_without_redundant_sdk_call(self):
        created = self.f.create("bootstrap")
        sandbox = self.f.sandboxes[created["resourceId"]]
        sandbox.code = 137
        observe = self.f.payload("bootstrap", "observe-role", {"resourceId": created["resourceId"]})
        self.assertEqual(self.f.dispatch(observe)["state"], "sandbox_terminal_observed")
        sandbox.code = None  # An inconsistent later poll cannot erase the fact.
        self.assertEqual(self.f.dispatch(observe)["state"], "sandbox_running_observed")
        retained = self.f.record("bootstrap")
        self.assertEqual(retained["returncode"], 137)
        payload = self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]})
        calls = len(self.f.calls)
        self.f.denied = True
        with self.assertRaises(PermissionError):
            self.f.dispatch(payload)
        self.assertEqual(len(self.f.calls), calls)
        self.f.denied = False
        self.f.terminate_failure = True  # No redundant call can lose its ACK.
        result = self.f.dispatch(payload)
        self.assertEqual(result["state"], "sandbox_terminal_observed")
        self.assertEqual(result["returncode"], 137)
        self.assertFalse(result["billingFinal"])
        self.assertEqual(result["admission"], "NO_ADMISSION")
        self.assertEqual(self.f.record("bootstrap"), retained)
        self.assertEqual(len(self.f.calls), calls)
        with self.assertRaises(FileExistsError):
            self.f.dispatch(payload)
        self.assertEqual(len(self.f.calls), calls)

    def test_changed_provider_role_tags_refuses_retirement(self):
        created = self.f.create("bootstrap")
        self.f.sandboxes[created["resourceId"]].tags["factory_role"] = "worker_1"
        with self.assertRaises(ValueError):
            self.f.dispatch(self.f.payload("bootstrap", "terminate-role", {"resourceId": created["resourceId"]}))
        self.assertFalse(any(call[0] == "terminate" for call in self.f.calls))

    def test_missing_explicit_host_client_refuses_before_sdk(self):
        payload = self.f.payload("bootstrap", "create-role")
        self.f.handles["client"] = None
        with self.assertRaises(ValueError):
            self.f.dispatch(payload)
        self.assertEqual(self.f.calls, [])

    def test_coordinator_has_no_default_inference_or_credential_adapter(self):
        for role in driver.ROLES:
            self.f.create(role)
        with self.assertRaises(PermissionError):
            driver.create_owned_coordinator(self.f.formation(), host_admission=lambda _: False,
                                            factory_admission=None, api_key_identifier=None)


if __name__ == "__main__":
    unittest.main()
