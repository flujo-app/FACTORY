"""Fake-SDK ownership/auth/durability tests; no Modal RPCs or GPU execution."""

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import run_pilot as pilot


class NotFoundError(Exception):
    pass


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="factory-modal-sdk-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.calls = []
        self.app_id = "ap-owned"
        self.volume_id = "vo-owned"
        self.workspace_name = "factory-account"
        self.app_absent = False
        self.function_failure = False

        test = self
        workspace = SimpleNamespace(name=self.workspace_name,
                                    settings=SimpleNamespace(list=lambda: SimpleNamespace(default_environment="main")),
                                    proxy_tokens=SimpleNamespace(create=lambda: self.calls.append("token-create")))
        class Workspace:
            @staticmethod
            def from_context():
                workspace.name = test.workspace_name
                return workspace

        class Volume:
            objects = SimpleNamespace(create=lambda *args, **kwargs: test.calls.append("volume-create"),
                                      delete=lambda *args, **kwargs: test.calls.append("volume-delete"))
            @staticmethod
            def from_name(*args, **kwargs):
                return SimpleNamespace(hydrate=lambda: SimpleNamespace(object_id=test.volume_id))

        class App:
            @staticmethod
            def lookup(*args, **kwargs):
                if test.app_absent:
                    raise NotFoundError()
                return SimpleNamespace(app_id=test.app_id)

        class Function:
            @staticmethod
            def from_name(*args, **kwargs):
                if test.function_failure:
                    raise ValueError("private SDK diagnostic")
                return SimpleNamespace(hydrate=lambda: SimpleNamespace(object_id="fu-owned", get_web_url=lambda: "https://factory--serve.modal.run"))

        self.fake = ModuleType("modal")
        self.fake.Workspace, self.fake.Volume, self.fake.App, self.fake.Function = Workspace, Volume, App, Function
        exception = ModuleType("modal.exception")
        exception.NotFoundError = NotFoundError
        self.patcher = patch.dict("sys.modules", {"modal": self.fake, "modal.exception": exception})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def payload(self, operation, state="running"):
        request = {"operation": operation, "runId": "offline-run", "appName": "factory-offline-model",
                   "volumeName": "factory-offline-weights", "profile": "fake-profile", "environment": "main",
                   "workspaceName": "factory-account", "runDirectory": str(self.root)}
        payload = {**request, "request": request, "effectKey": operation, "journalPath": str(self.root / "modal.sqlite")}
        encoded = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        connection = sqlite3.connect(payload["journalPath"])
        connection.execute("CREATE TABLE IF NOT EXISTS modal_operations(key TEXT PRIMARY KEY, operation TEXT, request_digest TEXT, state TEXT)")
        connection.execute("INSERT OR REPLACE INTO modal_operations VALUES(?,?,?,?)", (operation, operation, hashlib.sha256(encoded).hexdigest(), state))
        connection.commit()
        connection.close()
        return payload

    def resource(self, payload, **changes):
        value = {key: payload[key] for key in ("runId", "appName", "volumeName", "environment", "profile", "workspaceName")}
        value.update(changes)
        pilot.write_json(self.root / "resources.private.json", value)

    def test_named_profile_discards_inherited_environment_credentials(self):
        self.app_absent = True
        request = self.payload("prepare")
        with patch.dict(os.environ, {"MODAL_TOKEN_ID": "private-id", "MODAL_TOKEN_SECRET": "private-secret", "MODAL_SERVER_URL": "https://unexpected"}):
            result = pilot.operate(request)
            self.assertNotIn("MODAL_TOKEN_ID", os.environ)
            self.assertNotIn("MODAL_TOKEN_SECRET", os.environ)
            self.assertNotIn("MODAL_SERVER_URL", os.environ)
        self.assertEqual(result["workspaceName"], "factory-account")
        self.assertEqual(self.calls, [])

    def test_cli_unicode_capture_pins_child_utf8_without_changing_parent(self):
        request = self.payload("inspect")
        output = SimpleNamespace(returncode=0, stdout="stopped \u2192 0 containers", stderr="")
        with patch.dict(os.environ, {"PYTHONUTF8": "0", "PYTHONIOENCODING": "cp1252"}), patch.object(pilot.subprocess, "run", return_value=output) as process:
            self.assertEqual(pilot.cli(request, ["app", "list", "--json"]), output.stdout)
            self.assertEqual(os.environ["PYTHONUTF8"], "0")
            self.assertEqual(os.environ["PYTHONIOENCODING"], "cp1252")
        arguments, options = process.call_args
        self.assertEqual(arguments[0][-4:], ["--env", "main", "--profile", "fake-profile"])
        self.assertEqual(options["env"]["PYTHONUTF8"], "1")
        self.assertEqual(options["env"]["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(options["encoding"], "utf-8")
        self.assertTrue(options["capture_output"])
        self.assertEqual(len(list(self.root.glob("cli-inspect-*.stdout.private.txt"))), 1)
        self.assertEqual(next(self.root.glob("cli-inspect-*.stdout.private.txt")).read_text(encoding="utf-8"), output.stdout)

    def test_unknown_or_unbound_intent_cannot_dispatch(self):
        request = self.payload("create-volume", state="unknown")
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_argument_change_cannot_reuse_an_admitted_digest(self):
        request = self.payload("create-volume")
        request["volumeName"] = "factory-another-weights"
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_actual_workspace_change_blocks_mutation(self):
        request = self.payload("create-volume")
        self.workspace_name = "another-account"
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_created_volume_identity_is_checkpointed(self):
        request = self.payload("create-volume")
        result = pilot.operate(request)
        record = json.loads((self.root / "resources.private.json").read_text())
        self.assertEqual(result["volumeId"], "vo-owned")
        self.assertTrue(record["volumeCreated"])
        self.assertEqual(self.calls, ["volume-create"])

    def test_changed_volume_identity_is_never_deleted(self):
        request = self.payload("delete-volume")
        self.resource(request, volumeCreated=True, volumeId="vo-original", appDeployed=True, appStopped=True)
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_changed_app_identity_is_never_stopped(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-original")
        with patch.object(pilot, "cli") as cli, self.assertRaises(ValueError):
            pilot.operate(request)
        cli.assert_not_called()

    def test_stopped_label_with_live_container_is_not_terminal_proof(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        def fake_cli(payload, arguments):
            if arguments[:2] == ["app", "stop"]:
                self.calls.append("app-stop")
                return ""
            return json.dumps([{"App ID": "ap-owned", "Description": request["appName"], "State": "stopped", "Tasks": "1"}])
        with patch.object(pilot, "cli", fake_cli), self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, ["app-stop"])
        self.assertNotIn("appStopped", json.loads((self.root / "resources.private.json").read_text()))

    def test_actual_sdk_snake_case_inventory_proves_stopped_zero_containers(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        def fake_cli(payload, arguments):
            if arguments[:2] == ["app", "stop"]:
                self.calls.append("app-stop")
                return ""
            return json.dumps([{"app_id": "ap-owned", "description": request["appName"], "state": "stopped", "tasks": "0"}])
        with patch.object(pilot, "cli", fake_cli):
            result = pilot.operate(request)
        self.assertEqual(result["appId"], "ap-owned")
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["runningContainers"], 0)
        self.assertTrue(json.loads((self.root / "resources.private.json").read_text())["appStopped"])

    def test_conflicting_inventory_representations_are_not_terminal_proof(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        base = {"app_id": "ap-owned", "description": request["appName"], "state": "stopped", "tasks": "0"}
        for changes in ({"App ID": "ap-other"}, {"Description": "another-app"}, {"State": "deployed"}, {"Tasks": "1"}):
            with self.subTest(changes=changes), patch.object(pilot, "cli", return_value=json.dumps([{**base, **changes}])), self.assertRaises(ValueError):
                pilot.app_inventory(request)
        self.assertNotIn("appStopped", json.loads((self.root / "resources.private.json").read_text()))

    def test_missing_or_duplicate_container_evidence_is_unknown(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        base = {"app_id": "ap-owned", "description": request["appName"], "state": "stopped"}
        for rows in ([base], [{**base, "tasks": "0"}, {**base, "tasks": "0"}]):
            with self.subTest(rows=rows), patch.object(pilot, "cli", return_value=json.dumps(rows)), self.assertRaises(ValueError):
                pilot.app_inventory(request)

    def test_deployment_checkpoints_app_before_function_lookup_failure(self):
        request = self.payload("deploy")
        self.resource(request, volumeCreated=True, volumeId="vo-owned")
        self.app_absent = True
        self.function_failure = True
        fake_app = SimpleNamespace(app_id="ap-owned", deploy=lambda **kwargs: self.calls.append("app-deploy"))
        with patch.object(pilot.importlib, "import_module", return_value=SimpleNamespace(app=fake_app)), self.assertRaises(ValueError):
            pilot.operate(request)
        record = json.loads((self.root / "resources.private.json").read_text())
        self.assertEqual(record["appId"], "ap-owned")
        self.assertTrue(record["appDeployed"])
        self.assertEqual(self.calls, ["app-deploy"])

    def test_existing_private_token_blocks_creation_before_sdk_dispatch(self):
        request = self.payload("create-proxy-token")
        self.resource(request, appDeployed=True, serveFunctionId="fu-owned", weightsCached=True)
        pilot.write_json(self.root / "proxy-token.private.json", {"bearer": "private-existing"})
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
