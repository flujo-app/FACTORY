"""Fake-SDK ownership/auth/durability tests; no Modal RPCs or GPU execution."""

import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
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
        self.volume_version = 2
        self.volume_exists = False
        self.volume_lookups = []
        self.volume_creates = []
        self.prefetch_result = None
        self.workspace_name = "factory-account"
        self.app_absent = False
        self.function_failure = False
        self.billing_rows = []
        self.billing_calls = []

        test = self
        workspace = SimpleNamespace(name=self.workspace_name,
                                    settings=SimpleNamespace(list=lambda: SimpleNamespace(default_environment="main")),
                                    billing=SimpleNamespace(report=lambda **kwargs: self.billing_calls.append(kwargs) or list(self.billing_rows)),
                                    proxy_tokens=SimpleNamespace(create=lambda: self.calls.append("token-create")))
        class Workspace:
            @staticmethod
            def from_context():
                workspace.name = test.workspace_name
                return workspace

        class Volume:
            @staticmethod
            def create(name, **kwargs):
                test.volume_creates.append({"name": name, **kwargs})
                if test.volume_exists:
                    raise ValueError("Volume name already exists")
                if kwargs.get("version") != 2 or kwargs.get("allow_existing") is not False:
                    raise ValueError("Creation must explicitly require new v2")
                test.volume_exists = True
                test.volume_version = kwargs["version"]
                test.calls.append("volume-create")

            @staticmethod
            def delete(name, **kwargs):
                test.volume_exists = False
                test.calls.append("volume-delete")

            @staticmethod
            def from_name(name, **kwargs):
                test.volume_lookups.append({"name": name, **kwargs})
                if kwargs.get("create_if_missing") is not False:
                    raise ValueError("Implicit Volume creation forbidden")
                def hydrate():
                    if not test.volume_exists:
                        raise NotFoundError()
                    if kwargs.get("version") is not None and kwargs["version"] != test.volume_version:
                        raise ValueError("Actual VolumeFS version mismatch")
                    return SimpleNamespace(object_id=test.volume_id)
                return SimpleNamespace(hydrate=hydrate)

        Volume.objects = SimpleNamespace(create=Volume.create, delete=Volume.delete)

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
                def remote():
                    test.calls.append("prefetch-call")
                    return test.prefetch_result or {"state": "weights-cached", "volumeId": test.volume_id, "volumeFsVersion": test.volume_version,
                        "model": pilot.CONFIG["model"], "revision": pilot.CONFIG["revision"],
                        "download": {**pilot.CONFIG["prefetchDownload"], "hfXetVersion": "1.6.0", "xetDisabled": True, "hfTransferDisabled": True}}
                return SimpleNamespace(hydrate=lambda: SimpleNamespace(object_id="fu-owned", get_web_url=lambda: "https://factory--serve.modal.run", remote=remote))

        self.fake = ModuleType("modal")
        self.fake.Workspace, self.fake.Volume, self.fake.App, self.fake.Function = Workspace, Volume, App, Function
        exception = ModuleType("modal.exception")
        exception.NotFoundError = NotFoundError
        self.patcher = patch.dict("sys.modules", {"modal": self.fake, "modal.exception": exception})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def payload(self, operation, state="running", *, legacy_download=False):
        request = {"operation": operation, "runId": "offline-run", "appName": "factory-offline-model",
                   "volumeName": "factory-offline-weights", "profile": "fake-profile", "environment": "main",
                   "workspaceName": "factory-account", "runDirectory": str(self.root)}
        if operation in {"prepare", "create-volume", "deploy", "prefetch", "create-proxy-token"}:
            request["volumeFsVersion"] = 2
        if operation in {"deploy", "prefetch"} and not legacy_download:
            request["prefetchDownload"] = dict(pilot.CONFIG["prefetchDownload"])
        payload = {**request, "request": request, "effectKey": operation, "journalPath": str(self.root / "modal.sqlite")}
        encoded = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        connection = sqlite3.connect(payload["journalPath"])
        connection.execute("CREATE TABLE IF NOT EXISTS modal_operations(key TEXT PRIMARY KEY, operation TEXT, request_digest TEXT, state TEXT, request_json TEXT, result_json TEXT)")
        connection.execute("INSERT OR REPLACE INTO modal_operations VALUES(?,?,?,?,?,NULL)", (operation, operation, hashlib.sha256(encoded).hexdigest(), state, json.dumps(request)))
        connection.commit()
        connection.close()
        return payload

    def resource(self, payload, **changes):
        value = {key: payload[key] for key in ("runId", "appName", "volumeName", "environment", "profile", "workspaceName")}
        value.update(changes)
        if changes.get("volumeCreated"):
            self.volume_exists = True
            if payload["operation"] in {"deploy", "prefetch"}:
                value.setdefault("volumeFsVersion", 2)
                if "prefetchDownload" in payload:
                    value.setdefault("prefetchDownload", payload["prefetchDownload"])
        pilot.write_json(self.root / "resources.private.json", value)

    def meter_payload(self):
        request = self.payload("meter")
        self.billing_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
        request["startedAt"] = int((self.billing_hour + timedelta(minutes=17)).timestamp() * 1000)
        self.resource(request, appId="ap-owned", serveFunctionId="fu-serve", prefetchFunctionId="fu-prefetch", volumeId="vo-owned")
        return request

    def billing_row(self, object_id, cost="0.01", **changes):
        value = {"object_id": object_id, "environment_name": "main", "interval_start": self.billing_hour,
                 "cost": Decimal(cost), "cost_by_resource": {}, "description": "private-description", "tags": {"private": "value"}}
        value.update(changes)
        return SimpleNamespace(**value)

    def test_meter_empty_unrelated_or_wrong_environment_is_unavailable(self):
        request = self.meter_payload()
        for rows in ([], [self.billing_row("ap-unrelated")], [self.billing_row("ap-owned", environment_name="other-env")]):
            with self.subTest(rows=len(rows)):
                self.billing_rows = rows
                result = pilot.operate(request)
                self.assertEqual(result["state"], "billing-unavailable")
                self.assertEqual(result["knownMeteredCents"], 0)
                self.assertFalse(result["final"])
                self.assertEqual(result["reportStart"], self.billing_hour.isoformat())
                self.assertEqual(result["reportEnd"], self.billing_calls[-1]["end"].isoformat())
                self.assertNotIn("matchedRowCostUsdSum", result)
        self.assertEqual(self.calls, [])

    def test_meter_recorded_app_counts_total_once_without_resource_breakdown_or_private_fields(self):
        request = self.meter_payload()
        self.billing_rows = [self.billing_row("ap-owned", "0.03503811", cost_by_resource={
            "CPU": Decimal("0.01"), "Memory": Decimal("0.02503811")})]
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-observed")
        self.assertEqual(result["knownMeteredCents"], 4)
        self.assertEqual(result["resourceRows"], 1)
        self.assertEqual(result["ownedObjectCount"], 4)
        self.assertFalse(result["final"])
        self.assertEqual(result["buildCostAttribution"], "unverified")
        self.assertEqual(result["meterScope"], "recorded-owned-objects-completed-hours-only")
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("ap-owned", json.dumps(result))
        query = self.billing_calls[-1]
        self.assertEqual(query["start"], self.billing_hour)
        self.assertEqual(result["reportStart"], query["start"].isoformat())
        self.assertEqual(result["reportEnd"], query["end"].isoformat())
        self.assertEqual(result["matchedRowCostUsdSum"], "0.03503811")
        self.assertEqual(query["resolution"], "h")
        self.assertEqual(query["end"].minute, 0)
        self.assertEqual(query["end"].second, 0)
        self.assertEqual(query["end"].microsecond, 0)
        self.assertEqual(self.calls, [])

    def test_meter_functions_and_volume_can_sum_distinct_owned_object_costs(self):
        request = self.meter_payload()
        self.billing_rows = [self.billing_row("fu-serve", "0.07"), self.billing_row("fu-prefetch", "0.02"),
                             self.billing_row("vo-owned", "0.01", cost_by_resource={"Storage": Decimal("0.01")})]
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-observed")
        self.assertEqual(result["knownMeteredCents"], 10)
        self.assertEqual(result["resourceRows"], 3)
        self.assertFalse(result["final"])

    def test_meter_app_compute_and_volume_storage_can_coexist(self):
        request = self.meter_payload()
        self.billing_rows = [self.billing_row("ap-owned", "0.03", cost_by_resource={"CPU": Decimal("0.03")}),
                             self.billing_row("vo-owned", "0.01", cost_by_resource={"Storage": Decimal("0.01")})]
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-observed")
        self.assertEqual(result["knownMeteredCents"], 4)

    def test_meter_positive_app_and_function_same_interval_is_ambiguous(self):
        request = self.meter_payload()
        self.billing_rows = [self.billing_row("ap-owned", "0.03"), self.billing_row("fu-serve", "0.04")]
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-unavailable")
        self.assertEqual(result["observationReason"], "ambiguous-app-function-interval")
        self.assertEqual(result["knownMeteredCents"], 0)
        self.assertNotIn("matchedRowCostUsdSum", result)
        self.billing_rows[1].interval_start += timedelta(hours=1)
        separated = pilot.operate(request)
        self.assertEqual(separated["state"], "billing-observed")
        self.assertEqual(separated["knownMeteredCents"], 7)
        self.billing_rows[1] = self.billing_row("fu-serve", "0")
        self.assertEqual(pilot.operate(request)["knownMeteredCents"], 3)

    def test_meter_duplicate_or_conflicting_owned_interval_cannot_double_count(self):
        request = self.meter_payload()
        for other_cost in ("0.03", "0.04"):
            with self.subTest(other_cost=other_cost):
                self.billing_rows = [self.billing_row("ap-owned", "0.03"), self.billing_row("ap-owned", other_cost)]
                result = pilot.operate(request)
                self.assertEqual(result["state"], "billing-unavailable")
                self.assertEqual(result["observationReason"], "duplicate-owned-interval")
        self.billing_rows[1].interval_start += timedelta(hours=1)
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-observed")
        self.assertEqual(result["knownMeteredCents"], 7)

    def test_meter_invalid_cost_or_interval_is_unavailable_without_billing_claim(self):
        request = self.meter_payload()
        invalid = [{"cost": Decimal("NaN")}, {"cost": Decimal("Infinity")}, {"cost": Decimal("-0.01")}, {"cost": 0.01},
                   {"interval_start": self.billing_hour.replace(tzinfo=None)},
                   {"interval_start": self.billing_hour + timedelta(minutes=1)},
                   {"interval_start": self.billing_hour + timedelta(hours=2)},
                   {"interval_start": self.billing_hour - timedelta(hours=1)}]
        for changes in invalid:
            with self.subTest(changes=list(changes)):
                row = self.billing_row("ap-owned")
                for key, value in changes.items():
                    setattr(row, key, value)
                self.billing_rows = [row]
                result = pilot.operate(request)
                self.assertEqual(result["state"], "billing-unavailable")
                self.assertEqual(result["knownMeteredCents"], 0)
                self.assertFalse(result["final"])

    def test_meter_with_no_completed_hour_is_unavailable_without_provider_report(self):
        request = self.meter_payload()
        request["startedAt"] = int(datetime.now(timezone.utc).timestamp() * 1000)
        result = pilot.operate(request)
        self.assertEqual(result["state"], "billing-unavailable")
        self.assertEqual(self.billing_calls, [])

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
        self.assertEqual(record["volumeFsVersion"], 2)
        self.assertEqual(self.volume_creates[0]["version"], 2)
        self.assertFalse(self.volume_creates[0]["allow_existing"])
        self.assertEqual(self.volume_lookups[0]["version"], 2)
        self.assertFalse(self.volume_lookups[0]["create_if_missing"])
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
        def fake_cli(payload, arguments, **kwargs):
            if arguments[:2] == ["app", "stop"]:
                self.calls.append("app-stop")
                return ""
            return json.dumps([{"App ID": "ap-owned", "Description": request["appName"], "State": "stopped", "Tasks": "1"}])
        with patch.object(pilot, "cli", fake_cli), patch.object(pilot.time, "monotonic", side_effect=[0, 0, 46]), self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, ["app-stop"])
        self.assertNotIn("appStopped", json.loads((self.root / "resources.private.json").read_text()))

    def test_actual_sdk_snake_case_inventory_proves_stopped_zero_containers(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        def fake_cli(payload, arguments, **kwargs):
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

    def test_stop_waits_for_transition_without_reissuing_stop(self):
        request = self.payload("stop-app")
        self.resource(request, appDeployed=True, appId="ap-owned")
        states = iter([("stopping...", "1"), ("stopped", "0")])
        def fake_cli(payload, arguments, **kwargs):
            if arguments[:2] == ["app", "stop"]:
                self.calls.append("app-stop")
                return ""
            self.assertGreater(kwargs["timeout_seconds"], 0)
            self.assertLessEqual(kwargs["timeout_seconds"], 45)
            state, tasks = next(states)
            return json.dumps([{"app_id": "ap-owned", "description": request["appName"], "state": state, "tasks": tasks}])
        with patch.object(pilot, "cli", fake_cli), patch.object(pilot.time, "sleep") as sleep:
            result = pilot.operate(request)
        self.assertEqual(self.calls, ["app-stop"])
        self.assertEqual(result["state"], "stopped")
        sleep.assert_called_once()

    def reconciliation(self):
        original = self.payload("stop-app", state="unknown")
        self.resource(original, appDeployed=True, appId="ap-owned", volumeId="vo-owned", volumeCreated=True)
        encoded = json.dumps(original["request"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        return {**original, "operation": "reconcile-stop-app", "originalKey": "stop-app",
                "originalRequestDigest": hashlib.sha256(encoded).hexdigest(), "recordedAppId": "ap-owned", "recordedVolumeId": "vo-owned"}

    def test_owned_stop_reconciliation_only_reads_live_terminal_inventory(self):
        request = self.reconciliation()
        row = {"app_id": "ap-owned", "description": request["appName"], "state": "stopped", "tasks": "0"}
        with patch.object(pilot, "cli", return_value=json.dumps([row])) as cli:
            result = pilot.operate(request)
        self.assertEqual(result["originalKey"], "stop-app")
        self.assertEqual(result["originalRequestDigest"], request["originalRequestDigest"])
        self.assertEqual(result["runningContainers"], 0)
        self.assertEqual(cli.call_args.args[1], ["app", "list", "--json"])
        self.assertEqual(self.calls, [])
        self.assertNotIn("appStopped", json.loads((self.root / "resources.private.json").read_text()))

    def test_fabricated_stop_identity_or_digest_blocks_reconciliation_before_inventory(self):
        request = self.reconciliation()
        for changes in ({"recordedAppId": "ap-other"}, {"originalRequestDigest": "a" * 64}, {"originalKey": "prefetch"}):
            with self.subTest(changes=changes), patch.object(pilot, "cli") as cli, self.assertRaises(ValueError):
                pilot.operate({**request, **changes})
            cli.assert_not_called()

    def test_stop_reconciliation_rejects_live_or_absent_terminal_guess(self):
        request = self.reconciliation()
        base = {"app_id": "ap-owned", "description": request["appName"], "state": "stopped", "tasks": "0"}
        for rows in ([{**base, "state": "stopping...", "tasks": "1"}], [{**base, "tasks": "1"}], [{**base, "tasks": False}], [{key: value for key, value in base.items() if key != "tasks"}], []):
            with self.subTest(rows=rows), patch.object(pilot, "cli", return_value=json.dumps(rows)), self.assertRaises(ValueError):
                pilot.operate(request)
        self.assertNotIn("appStopped", json.loads((self.root / "resources.private.json").read_text()))

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

    def test_existing_volume_conflict_never_adopts_or_deploys(self):
        request = self.payload("create-volume")
        self.volume_exists, self.volume_version = True, 1
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.volume_lookups, [])
        self.assertFalse((self.root / "resources.private.json").exists())

    def test_version_changes_cannot_reuse_durable_intent(self):
        request = self.payload("create-volume")
        request["volumeFsVersion"] = 1
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.volume_creates, [])

    def test_wrong_volume_version_or_id_blocks_deployment(self):
        for actual_version, recorded_id in [(1, "vo-owned"), (2, "vo-original")]:
            with self.subTest(actual_version=actual_version, recorded_id=recorded_id):
                request = self.payload("deploy")
                self.resource(request, volumeCreated=True, volumeId=recorded_id)
                self.volume_version = actual_version
                with patch.object(pilot.importlib, "import_module") as imported, self.assertRaises(ValueError):
                    pilot.operate(request)
                imported.assert_not_called()
                self.assertEqual(self.calls, [])

    def test_missing_version_metadata_cannot_adopt_old_volume_for_new_deployment(self):
        request = self.payload("deploy")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", volumeFsVersion=None)
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertEqual(self.volume_lookups, [])
        self.assertEqual(self.calls, [])

    def test_prefetch_rechecks_version_and_id_before_remote_execution(self):
        for actual_version, recorded_id in [(1, "vo-owned"), (2, "vo-original")]:
            request = self.payload("prefetch")
            self.resource(request, volumeCreated=True, volumeId=recorded_id, prefetchFunctionId="fu-owned")
            self.volume_version = actual_version
            with self.assertRaises(ValueError):
                pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_prefetch_success_is_bound_to_owned_v2_volume(self):
        request = self.payload("prefetch")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned")
        self.assertEqual(pilot.operate(request)["volumeFsVersion"], 2)
        self.assertEqual(self.calls, ["prefetch-call"])

    def test_original_legacy_intents_cannot_be_adopted_as_http_deploy_or_prefetch(self):
        for operation in ("deploy", "prefetch"):
            with self.subTest(operation=operation):
                request = self.payload(operation, legacy_download=True)
                self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned")
                with self.assertRaises(ValueError): pilot.operate(request)
                self.assertEqual(self.calls, [])
                self.assertEqual(self.volume_lookups, [])

    def test_payload_download_profile_cannot_differ_from_its_durable_intent(self):
        request = self.payload("prefetch")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned")
        request["prefetchDownload"] = {**request["prefetchDownload"], "maxWorkers": 8}
        with self.assertRaises(ValueError): pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_prefetch_profile_must_match_the_recorded_deployment_before_invocation(self):
        request = self.payload("prefetch")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned", prefetchDownload={"transport": "xet"})
        with self.assertRaises(ValueError): pilot.operate(request)
        self.assertEqual(self.calls, [])

    def test_result_download_mode_revision_and_dependency_metadata_must_be_exact(self):
        request = self.payload("prefetch")
        valid = {"state": "weights-cached", "volumeId": "vo-owned", "volumeFsVersion": 2,
                 "model": pilot.CONFIG["model"], "revision": pilot.CONFIG["revision"],
                 "download": {**pilot.CONFIG["prefetchDownload"], "hfXetVersion": None, "xetDisabled": True, "hfTransferDisabled": True}}
        cases = [{"revision": "a" * 40}, {"model": "other/model"},
                 *[{"download": {**valid["download"], **change}} for change in ({"transport": "xet"}, {"maxWorkers": True},
                   {"hubVersion": "1.29.0"}, {"xetDisabled": False}, {"hfTransferDisabled": False},
                   {"hfXetVersion": 42}, {"hfXetVersion": "raw private /path"}, {"unexpected": "private"})]]
        for change in cases:
            with self.subTest(change=change):
                self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned")
                self.prefetch_result = {**valid, **change}
                with self.assertRaises(ValueError): pilot.operate(request)
                self.assertNotIn("weightsCached", json.loads((self.root / "resources.private.json").read_text()))
        self.prefetch_result = {**valid, "rawDiagnostic": "private-server-path"}
        result = pilot.operate(request)
        self.assertEqual(result, valid)

    def test_wrong_prefetch_result_cannot_checkpoint_cached_weights(self):
        request = self.payload("prefetch")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", prefetchFunctionId="fu-owned")
        self.prefetch_result = {"state": "weights-cached", "volumeId": "vo-other", "volumeFsVersion": 2}
        with self.assertRaises(ValueError):
            pilot.operate(request)
        self.assertNotIn("weightsCached", json.loads((self.root / "resources.private.json").read_text()))

    def test_legacy_v1_cleanup_is_version_agnostic_and_exact_id_bound(self):
        request = self.payload("delete-volume")
        self.resource(request, volumeCreated=True, volumeId="vo-owned", volumeFsVersion=1, appDeployed=True, appStopped=True)
        self.volume_version = 1
        self.assertNotIn("volumeFsVersion", request)
        result = pilot.operate(request)
        self.assertEqual(result["volumeId"], "vo-owned")
        self.assertEqual(self.calls, ["volume-delete"])
        self.assertTrue(all("version" not in item and item["create_if_missing"] is False for item in self.volume_lookups))
        record = json.loads((self.root / "resources.private.json").read_text())
        self.assertTrue(record["volumeDeleted"])
        self.assertEqual(record["volumeFsVersion"], 1)


if __name__ == "__main__":
    unittest.main()
