"""Offline configuration/lifecycle checks. No CommunityAI/provider imports."""

import asyncio
from contextlib import asynccontextmanager
import copy
import importlib.util
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("communityai_bootstrap", Path(__file__).with_name("communityai_bootstrap.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


def formation(now=1000):
    endpoints = {}
    for index, role in enumerate(bootstrap.ROLES):
        endpoints[role] = {"resource_id": f"sb-test-{index}", "ipv4": f"8.8.8.{index + 1}",
                           "public_port": 41000 + index, "listen_port": 31330,
                           "transport": "modal-raw-tcp", "application_tls": True}
    return {"run_id": "factory-distributed-test", "manifest_digest": bootstrap.MANIFEST_DIGEST,
            "expires_at_unix": now + 1800, "endpoints": endpoints,
            "bootstrap_peers": ["/ip4/8.8.8.1/tcp/41000/p2p/12D3KooW" + "A" * 40]}


class ConfigurationTests(unittest.TestCase):
    def test_exact_manifest_and_complete_two_worker_topology(self):
        manifest = bootstrap.load_pinned_manifest()
        plan = bootstrap.build_launch_plan(formation(), now=1000)
        self.assertEqual(manifest["model"]["num_blocks"], 28)
        self.assertEqual([w["block_indices"] for w in plan["workers"]], ["0:14", "14:28"])
        self.assertEqual(plan["status"], "not_started")
        self.assertEqual(plan["admission"], "NO_ADMISSION")
        self.assertEqual(plan["formation_provenance"], "not_authenticated")
        self.assertNotEqual(plan["manifest_raw_sha256"], plan["manifest_digest"].removeprefix("sha256:"))
        for index, worker in enumerate(plan["workers"]):
            args = worker["argv"]
            self.assertEqual(args[:5], ["python", "-m", "drift.cli", "server", bootstrap.MODEL])
            self.assertIn(f"/ip4/8.8.8.{index+2}/tcp/{41001+index}", args)
            self.assertNotIn("--public_ip", args)
            self.assertNotIn("--num_blocks", args)
            self.assertIn("--model_manifest", args)
        self.assertEqual(plan["text_peer"]["argv"][:4], ["python", "-m", "drift.cli", "text-peer"])
        self.assertTrue(plan["bootstrap"]["tls"])
        self.assertEqual(plan["environment"]["HF_HUB_OFFLINE"], "1")

    def test_stale_foreign_and_missing_tunnel_inputs_fail_closed(self):
        mutations = [lambda f: f.update(expires_at_unix=1000),
                     lambda f: f.update(manifest_digest=bootstrap.MANIFEST_RAW_SHA256),
                     lambda f: f["endpoints"]["worker_0"].pop("public_port"),
                     lambda f: f["endpoints"]["worker_1"].update(public_port=0),
                     lambda f: f["endpoints"]["text_peer"].update(ipv4="127.0.0.1"),
                     lambda f: f["endpoints"]["text_peer"].update(transport="modal-tls-socket"),
                     lambda f: f["endpoints"]["text_peer"].update(application_tls=False),
                     lambda f: f.update(bootstrap_peers=[f["bootstrap_peers"][0].replace("41000", "31330")])]
        for mutation in mutations:
            value = formation()
            mutation(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                bootstrap.build_launch_plan(value, now=1000)

    def test_raw_pin_is_checked_before_using_model_identity(self):
        original = bootstrap.MANIFEST_PATH.read_bytes()
        with patch.object(Path, "read_bytes", return_value=original + b" "):
            with self.assertRaisesRegex(ValueError, "file changed"):
                bootstrap.load_pinned_manifest()

    def test_two_workers_cannot_be_one_resource_and_cohosting_needs_distinct_sockets(self):
        value = formation()
        value["endpoints"]["worker_1"]["resource_id"] = value["endpoints"]["worker_0"]["resource_id"]
        with self.assertRaisesRegex(ValueError, "local sockets"):
            bootstrap.build_launch_plan(value, now=1000)
        value["endpoints"]["worker_1"]["listen_port"] += 1
        with self.assertRaisesRegex(ValueError, "separate Modal"):
            bootstrap.build_launch_plan(value, now=1000)
        value = formation()
        value["endpoints"]["text_peer"]["resource_id"] = value["endpoints"]["bootstrap"]["resource_id"]
        with self.assertRaisesRegex(ValueError, "local sockets"):
            bootstrap.build_launch_plan(value, now=1000)
        value["endpoints"]["text_peer"]["listen_port"] = 31337
        self.assertEqual(bootstrap.build_launch_plan(value, now=1000)["text_peer"]["resource_id"], "sb-test-0")

    def test_caller_mutation_cannot_retarget_the_built_plan(self):
        value = formation()
        plan = bootstrap.build_launch_plan(value, now=1000)
        value["bootstrap_peers"][0] = "changed"
        value["endpoints"]["worker_0"]["public_port"] = 31330
        self.assertIn("41000", plan["coordinator"]["initial_peers"][0])
        self.assertIn("/ip4/8.8.8.2/tcp/41001", plan["workers"][0]["argv"])

    def test_host_adapters_are_required_and_async_adapters_are_refused_before_runtime_import(self):
        async def asynchronous(_):
            raise AssertionError("must not execute")

        class AsyncCallable:
            async def __call__(self, _):
                raise AssertionError("must not execute")

        for adapter in (None, asynchronous, AsyncCallable()):
            with self.assertRaisesRegex(ValueError, "synchronous"):
                bootstrap.create_coordinator_app(formation(), factory_admission=adapter,
                                                 api_key_identifier=lambda _: None)


class RuntimeDouble:
    """Only records wiring/cleanup. It cannot load a model or enter transport."""
    def __init__(self, *, start_error=False, construct_error=False, shutdown_error=False):
        self.events, self.loads = [], []
        self.start_error, self.construct_error, self.shutdown_error = start_error, construct_error, shutdown_error
        outer = self

        class Manifest:
            digest_id = bootstrap.MANIFEST_DIGEST
            name = "Qwen3 1.7B"

            @staticmethod
            def load(path):
                outer.events.append(("manifest", path))
                return Manifest()

            def validate_runtime(self, version):
                outer.events.append(("version", version))

        class CoverageTarget:
            def __init__(self, manifest, peers):
                self.manifest, self.peers = manifest, peers

        class Discovery:
            def __init__(self, targets, **kwargs):
                outer.discovery_options = kwargs
                outer.targets = targets

            def observer(self, digest):
                self.digest = digest
                return lambda: {"status": "unknown", "chat_ready": False}

            def start(self):
                outer.events.append("discovery_start")
                if outer.start_error:
                    raise OSError("unit startup error")

            def close(self):
                outer.events.append("discovery_close")

        class Descriptor:
            def __init__(self, model_id, **kwargs):
                outer.descriptor = (model_id, kwargs)

        class Manager:
            def add_shutdown_callback(self, callback):
                self.callback = callback

            def register(self, descriptor, loader, **kwargs):
                outer.registration = (descriptor, loader, kwargs)

            def shutdown(self):
                outer.events.append("manager_shutdown")
                if outer.shutdown_error:
                    raise OSError("unit shutdown error")
                self.callback()

        def loader(manifest, **kwargs):
            outer.loader_options = kwargs
            def forbidden_load():
                outer.loads.append(True)
                raise AssertionError("unit test cannot load runtime")
            return forbidden_load

        @asynccontextmanager
        async def original_lifespan(app):
            outer.events.append("original_start")
            try:
                yield
            finally:
                outer.events.append("original_close")

        def create_factory_app(**kwargs):
            outer.factory_options = kwargs
            if outer.construct_error:
                raise LookupError("unit constructor error")
            return SimpleNamespace(state=SimpleNamespace(), router=SimpleNamespace(lifespan_context=original_lifespan))

        modules = {"drift": {"__version__": "2.3.0.dev0"},
                   "drift.api.server": {"create_factory_app": create_factory_app},
                   "drift.model_manifest": {"ModelManifest": Manifest},
                   "drift.node.discovery": {"CoverageTarget": CoverageTarget, "ModelCoverageDiscovery": Discovery},
                   "drift.node.loading": {"make_text_peer_loader": loader},
                   "drift.node.model_manager": {"ModelDescriptor": Descriptor, "ModelManager": Manager}}
        self.modules = {}
        for name, members in modules.items():
            module = ModuleType(name)
            module.__dict__.update(members)
            self.modules[name] = module

    def app(self):
        with patch.dict("sys.modules", self.modules):
            return bootstrap.create_coordinator_app(formation(time.time()), factory_admission=lambda _: None,
                                                    api_key_identifier=lambda _: None)


class CompositionTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_api_names_wire_exact_text_runtime_without_loading_or_success_claim(self):
        runtime = RuntimeDouble()
        app = runtime.app()
        self.assertEqual(runtime.descriptor[0], bootstrap.MANIFEST_DIGEST)
        self.assertEqual(runtime.descriptor[1]["execution"], "distributed")
        self.assertNotIn("aliases", runtime.descriptor[1])
        self.assertEqual(runtime.factory_options["max_concurrent"], 1)
        self.assertEqual(runtime.factory_options["request_timeout"], 180)
        self.assertEqual(runtime.loader_options["request_timeout"], 180)
        self.assertTrue(runtime.discovery_options["discover_text"])
        async with app.router.lifespan_context(app):
            self.assertEqual(app.state.factory_communityai_lifecycle["startup"], "discovery_started_readiness_unverified")
            self.assertEqual(runtime.loads, [])
        self.assertIn("manager_shutdown", runtime.events)
        self.assertIn("discovery_close", runtime.events)
        self.assertEqual(app.state.factory_communityai_lifecycle["shutdown"], "close_returned_retirement_unverified")

    async def test_partial_start_error_is_retained_and_both_components_close(self):
        runtime = RuntimeDouble(start_error=True)
        app = runtime.app()
        with self.assertRaises(OSError):
            async with app.router.lifespan_context(app):
                self.fail("failed startup must not admit serving")
        self.assertEqual(app.state.factory_communityai_lifecycle["startup_error"], "OSError")
        self.assertIn("manager_shutdown", runtime.events)
        self.assertIn("discovery_close", runtime.events)
        self.assertEqual(runtime.loads, [])

    async def test_expiry_is_rechecked_at_start_and_cleanup_still_runs(self):
        runtime = RuntimeDouble()
        app = runtime.app()
        with patch.object(bootstrap.time, "time", return_value=time.time() + 3600):
            with self.assertRaises(ValueError):
                async with app.router.lifespan_context(app):
                    self.fail("expired formation must not start")
        self.assertNotIn("discovery_start", runtime.events)
        self.assertIn("manager_shutdown", runtime.events)
        self.assertIn("discovery_close", runtime.events)

    async def test_constructor_error_closes_both_owned_components(self):
        runtime = RuntimeDouble(construct_error=True)
        with self.assertRaises(LookupError):
            runtime.app()
        self.assertIn("manager_shutdown", runtime.events)
        self.assertIn("discovery_close", runtime.events)

    async def test_cleanup_failure_is_not_reported_as_success_and_other_close_still_runs(self):
        runtime = RuntimeDouble(shutdown_error=True)
        app = runtime.app()
        with self.assertRaises(RuntimeError):
            async with app.router.lifespan_context(app):
                pass
        self.assertIn("discovery_close", runtime.events)
        self.assertEqual(app.state.factory_communityai_lifecycle["shutdown"], "close_failed")
        self.assertEqual(app.state.factory_communityai_lifecycle["shutdown_errors"], ["OSError"])


if __name__ == "__main__":
    unittest.main()
