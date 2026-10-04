"""Offline TLS bootstrap lifecycle and recipe checks; no real transport imports."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
from types import ModuleType
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("communityai_runtime", Path(__file__).with_name("communityai_runtime.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
WATCHDOG_SPEC = importlib.util.spec_from_file_location("communityai_runtime_watchdog", Path(__file__).with_name("communityai_runtime_watchdog.py"))
watchdog = importlib.util.module_from_spec(WATCHDOG_SPEC)
WATCHDOG_SPEC.loader.exec_module(watchdog)


def config():
    return {"run_id": "factory-tls-bootstrap-test", "expires_at_unix": time.time() + 1800,
            "endpoint": {"resource_id": "sb-owned-test", "ipv4": "8.8.8.1", "listen_port": 31330,
                         "public_port": 41234, "transport": "modal-raw-tcp", "application_tls": True}}


class StopEvent:
    def __init__(self, stopped=False):
        self.stopped = stopped

    def is_set(self):
        return self.stopped

    def wait(self, duration):
        self.stopped = True


class TransportDouble:
    """Records exact constructor calls, with no native/socket/model operations."""
    def __init__(self, *, guard=True, start_error=False, mismatched_peer=False,
                 wrong_port=False, close_alive=False, stop_during_identity=None, observation_timeout=False):
        outer = self
        self.events, self.constructor_calls = [], []
        peer_id = "12D3KooW" + "A" * 40

        class Identity:
            @staticmethod
            def ensure(path):
                outer.events.append(("identity", path))
                if stop_during_identity is not None:
                    stop_during_identity.stopped = True
                return type("OwnedIdentity", (), {"peer_id": peer_id})()

        def lifetime_guard():
            outer.events.append("guard")
            return guard

        class DHT:
            def __init__(self, **kwargs):
                outer.constructor_calls.append(kwargs)
                self.alive = False
                self.observed_peer_id = "foreign" if mismatched_peer else peer_id

            @property
            def peer_id(self):
                raise AssertionError("Unbounded synchronous peer_id read must not occur")

            def run_in_background(self, *, timeout):
                outer.events.append(("start", timeout))
                self.alive = True
                if start_error:
                    raise TimeoutError("unit startup failure")

            def is_alive(self):
                return self.alive

            def get_visible_maddrs(self):
                raise AssertionError("Unbounded synchronous visible-address read must not occur")

            def run_coroutine(self, coroutine, *, return_future):
                outer.events.append(("observe", coroutine, return_future))
                observed_id = self.observed_peer_id
                class Future:
                    def result(self, *, timeout):
                        outer.events.append(("observation_timeout", timeout))
                        if observation_timeout:
                            raise TimeoutError("unit unresponsive DHT")
                        port = 31330 if wrong_port else 41234
                        return observed_id, [f"/ip4/8.8.8.1/tcp/{port}/p2p/{observed_id}"]
                return Future()

            def shutdown(self):
                outer.events.append("shutdown")
                self.alive = close_alive

        self.modules = {}
        for name, members in {"drift.protocol_identity": {"NodeIdentity": Identity},
                              "drift.utils.process_lifetime": {"tie_child_processes_to_this_process": lifetime_guard},
                              "hivemind": {"DHT": DHT}}.items():
            module = ModuleType(name)
            module.__dict__.update(members)
            self.modules[name] = module

    def run(self, **kwargs):
        with patch.dict("sys.modules", self.modules):
            return runtime.run_tls_bootstrap(config(), stop_event=kwargs.pop("stop_event", StopEvent()), **kwargs)


class BootstrapTests(unittest.TestCase):
    def test_child_observation_awaits_actual_node_api_with_fresh_addresses(self):
        class Node:
            peer_id = "observed-peer"
            async def get_visible_maddrs(self, *, latest):
                self.latest = latest
                return ["observed-address"]
        node = Node()
        self.assertEqual(asyncio.run(runtime._observe_bootstrap(None, node)),
                         ("observed-peer", ["observed-address"]))
        self.assertTrue(node.latest)

    def test_real_constructor_shape_preserves_application_tls_and_actual_public_port(self):
        transport, observations = TransportDouble(), []
        result = transport.run(observer=observations.append)
        options = transport.constructor_calls[0]
        self.assertTrue(options["tls"])
        self.assertFalse(options["start"])
        self.assertFalse(options["client_mode"])
        self.assertFalse(options["use_auto_relay"])
        self.assertEqual(options["initial_peers"], [])
        self.assertEqual(options["host_maddrs"], ["/ip4/0.0.0.0/tcp/31330"])
        self.assertEqual(options["announce_maddrs"], ["/ip4/8.8.8.1/tcp/41234"])
        self.assertEqual(options["identity_path"], runtime.IDENTITY_PATH)
        self.assertEqual(result["phase"], "supervisor_stop")
        self.assertEqual(result["cleanup"], "dht_process_closed")
        self.assertEqual(result["provider_retirement"], "unverified")
        self.assertEqual(result["configuration_provenance"], "not_authenticated")
        self.assertEqual(result["startup_publication"], "completed")
        self.assertEqual(result["final_publication"], "completed")
        self.assertEqual(result["descendant_retirement"], "unverified")
        self.assertEqual(observations[0]["phase"], "started_reachability_unverified")
        self.assertEqual(observations[0]["startup_publication"], "in_progress")
        self.assertEqual(observations[1]["phase"], "supervisor_stop")
        self.assertEqual(observations[1]["final_publication"], "in_progress")
        self.assertIn("/tcp/41234/p2p/", result["bootstrap_peers"][0])
        self.assertEqual(len(transport.constructor_calls), 1)

    def test_already_stopped_never_constructs_transport_or_identity(self):
        transport = TransportDouble()
        result = transport.run(stop_event=StopEvent(True))
        self.assertEqual(transport.events, [])
        self.assertEqual(result["cleanup"], "no_dht_created")

    def test_stop_during_identity_refuses_transport_entry(self):
        stop = StopEvent()
        transport = TransportDouble(stop_during_identity=stop)
        result = transport.run(stop_event=stop)
        self.assertEqual(result["phase"], "stopped_before_transport")
        self.assertEqual(transport.constructor_calls, [])

    def test_unavailable_guard_refuses_identity_and_transport(self):
        transport = TransportDouble(guard=False)
        with self.assertRaises(runtime.BootstrapError) as failed:
            transport.run()
        self.assertEqual(transport.events, ["guard"])
        self.assertEqual(failed.exception.record["cleanup"], "no_dht_created")

    def test_startup_failure_closes_the_same_transport_once_without_retry(self):
        transport = TransportDouble(start_error=True)
        with self.assertRaises(runtime.BootstrapError) as failed:
            transport.run()
        self.assertEqual(failed.exception.record["failure_type"], "TimeoutError")
        self.assertEqual(failed.exception.record["cleanup"], "dht_process_closed")
        self.assertEqual(len(transport.constructor_calls), 1)
        self.assertEqual(transport.events.count("shutdown"), 1)

    def test_unresponsive_identity_address_observation_is_bounded_and_closes_without_retry(self):
        transport, observations = TransportDouble(observation_timeout=True), []
        with self.assertRaises(runtime.BootstrapError) as failed:
            transport.run(observer=observations.append)
        timeout = next(item[1] for item in transport.events if isinstance(item, tuple) and item[0] == "observation_timeout")
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 15)
        self.assertEqual(failed.exception.record["failure_type"], "TimeoutError")
        self.assertEqual(failed.exception.record["cleanup"], "dht_process_closed")
        self.assertEqual(len(transport.constructor_calls), 1)
        self.assertEqual(transport.events.count("shutdown"), 1)
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]["phase"], "failed")
        self.assertEqual(observations[0]["bootstrap_peers"], [])

    def test_foreign_peer_or_guessed_public_port_never_publishes_started(self):
        for options in ({"mismatched_peer": True}, {"wrong_port": True}):
            observations = []
            transport = TransportDouble(**options)
            with self.subTest(options=options), self.assertRaises(runtime.BootstrapError):
                transport.run(observer=observations.append)
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0]["phase"], "failed")
            self.assertEqual(observations[0]["bootstrap_peers"], [])

    def test_publication_failure_closes_transport_and_is_retained(self):
        transport = TransportDouble()
        def observer(_):
            raise OSError("unit observer failure")
        with self.assertRaises(runtime.BootstrapError) as failed:
            transport.run(observer=observer)
        self.assertEqual(failed.exception.record["failure_type"], "OSError")
        self.assertEqual(failed.exception.record["cleanup"], "dht_process_closed")
        self.assertEqual(failed.exception.record["cleanup_errors"], ["observer:OSError"])

    def test_blocked_startup_publication_closes_the_same_dht_without_hanging(self):
        transport, entered, release = TransportDouble(), threading.Event(), threading.Event()
        calls = []

        def observer(record):
            calls.append(record["phase"])
            entered.set()
            release.wait(5)

        try:
            with patch.object(runtime, "OBSERVER_TIMEOUT_SECONDS", 0.05):
                began = time.monotonic()
                with self.assertRaises(runtime.BootstrapError) as failed:
                    transport.run(observer=observer)
                self.assertLess(time.monotonic() - began, 1)
            self.assertTrue(entered.is_set())
            self.assertEqual(calls, ["started_reachability_unverified"])
            self.assertEqual(len(transport.constructor_calls), 1)
            self.assertEqual(transport.events.count("shutdown"), 1)
            record = failed.exception.record
            self.assertEqual(record["phase"], "failed")
            self.assertEqual(record["failure_type"], "TimeoutError")
            self.assertEqual(record["cleanup"], "dht_process_closed")
            self.assertEqual(record["startup_publication"], "stalled")
            self.assertEqual(record["final_publication"], "skipped_startup_stalled")
            self.assertEqual(record["observer_late_side_effects"], "possible_stalled_daemon")
            self.assertEqual(record["descendant_retirement"], "unverified")
        finally:
            release.set()

    def test_blocked_final_publication_returns_after_the_same_dht_closed(self):
        transport, release = TransportDouble(), threading.Event()
        calls = []

        def observer(record):
            calls.append(record["phase"])
            if len(calls) == 2:
                release.wait(5)

        try:
            with patch.object(runtime, "OBSERVER_TIMEOUT_SECONDS", 0.05):
                began = time.monotonic()
                with self.assertRaises(runtime.BootstrapError) as failed:
                    transport.run(observer=observer)
                self.assertLess(time.monotonic() - began, 1)
            self.assertEqual(calls, ["started_reachability_unverified", "supervisor_stop"])
            self.assertEqual(transport.events.count("shutdown"), 1)
            record = failed.exception.record
            self.assertEqual(record["cleanup"], "dht_process_closed")
            self.assertEqual(record["startup_publication"], "completed")
            self.assertEqual(record["final_publication"], "stalled")
            self.assertEqual(record["cleanup_errors"], ["observer:TimeoutError"])
            self.assertEqual(record["observer_late_side_effects"], "possible_stalled_daemon")
        finally:
            release.set()

    def test_incomplete_cleanup_cannot_be_reported_as_closed(self):
        transport = TransportDouble(close_alive=True)
        with self.assertRaises(runtime.BootstrapError) as failed:
            transport.run()
        self.assertEqual(failed.exception.record["cleanup"], "dht_process_still_alive")

    def test_expiry_and_tls_termination_configs_fail_before_runtime_import(self):
        for mutate in (lambda c: c.update(expires_at_unix=0),
                       lambda c: c["endpoint"].update(transport="modal-tls-socket"),
                       lambda c: c["endpoint"].update(application_tls=False),
                       lambda c: c["endpoint"].pop("public_port")):
            value = config()
            mutate(value)
            with self.assertRaises(ValueError):
                runtime.run_tls_bootstrap(value, stop_event=StopEvent())


class RecipeTests(unittest.TestCase):
    def test_cli_raw_stdout_backpressure_is_a_publication_failure(self):
        with patch.object(runtime.os, "write", side_effect=BlockingIOError(11, "full pipe")) as write:
            with self.assertRaises(BlockingIOError):
                runtime._emit_cli_record({"phase": "started_reachability_unverified"}, fd=42)
        self.assertEqual(write.call_count, 1)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux raw stdout pipe contract")
    def test_full_nonblocking_cli_pipe_never_waits_for_a_reader(self):
        read_fd, write_fd = os.pipe()
        try:
            os.set_blocking(write_fd, False)
            with self.assertRaises(BlockingIOError):
                while True:
                    os.write(write_fd, b"x" * 4096)
            began = time.monotonic()
            with self.assertRaises(BlockingIOError):
                runtime._emit_cli_record({"phase": "started_reachability_unverified"}, fd=write_fd)
            self.assertLess(time.monotonic() - began, 1)
        finally:
            os.close(write_fd)
            os.close(read_fd)

    def test_process_watchdog_bounds_a_stalled_child_at_expiry(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            path = Path(folder) / "bootstrap.json"
            value = config()
            value["expires_at_unix"] = time.time() + 0.5
            path.write_text(json.dumps(value))
            began = time.monotonic()
            result = watchdog.supervise_bootstrap(path, grace_seconds=0.1,
                                                  child_argv=[sys.executable, "-c", "import time; time.sleep(30)"])
        self.assertLess(time.monotonic() - began, 3)
        self.assertEqual(result["reason"], "expiry_stop")
        self.assertIsNotNone(result["child_returncode"])
        self.assertEqual(result["descendant_retirement"], "unverified")
        self.assertEqual(result["provider_retirement"], "unverified")

    def test_process_watchdog_does_not_spawn_after_stop(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            path = Path(folder) / "bootstrap.json"
            path.write_text(json.dumps(config()))
            stopped = threading.Event()
            stopped.set()
            def forbidden(*_args, **_kwargs):
                raise AssertionError("Stopped supervisor must not launch a child")
            result = watchdog.supervise_bootstrap(path, stop_event=stopped,
                                                  child_argv=[sys.executable, "-c", "pass"], popen=forbidden)
        self.assertEqual(result["reason"], "stopped_before_child")
        self.assertEqual(result["descendant_retirement"], "no_child_created")

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux process-group hard kill contract")
    def test_process_watchdog_force_kills_a_child_ignoring_stop(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            path = Path(folder) / "bootstrap.json"
            value = config()
            value["expires_at_unix"] = time.time() + 0.5
            path.write_text(json.dumps(value))
            command = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)"
            began = time.monotonic()
            result = watchdog.supervise_bootstrap(path, grace_seconds=0.1,
                                                  child_argv=[sys.executable, "-c", command])
        self.assertLess(time.monotonic() - began, 3)
        self.assertTrue(result["forced_kill"])
        self.assertEqual(result["child_returncode"], -signal.SIGKILL)

    def test_build_command_requires_immutable_build_tools_image(self):
        with self.assertRaises(ValueError):
            runtime.image_build_argv("context", build_runtime_image="compiler:latest", image_tag="factory:test")
        command = runtime.image_build_argv("context", build_runtime_image="example/compiler@sha256:" + "1" * 64,
                                          image_tag="factory:test")
        self.assertEqual(command[:3], ["docker", "buildx", "build"])
        self.assertIn("linux/amd64", command)
        self.assertNotIn("--push", command)

    def test_recipe_pins_known_images_and_uses_coherent_lock_without_resolution(self):
        recipe = runtime.DOCKERFILE_PATH.read_text()
        self.assertIn(runtime.PYTHON_IMAGE, recipe)
        self.assertIn(runtime.UV_IMAGE, recipe)
        self.assertIn("uv sync --locked", recipe)
        self.assertIn("--no-install-project", recipe)
        self.assertIn("--no-build-isolation", recipe)
        self.assertIn("uv venv --system-site-packages", recipe)
        self.assertIn("--reinstall", recipe)
        self.assertIn("include-system-site-packages = false", recipe)
        self.assertIn("HF_HUB_OFFLINE=1", recipe)
        self.assertIn("ENTRYPOINT []", recipe)
        self.assertNotIn("apt-get", recipe)

    def test_stale_api_lock_and_native_build_gap_remain_explicit(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root = Path(folder)
            (root / "pyproject.toml").write_text('[project.optional-dependencies]\napi=["fastapi>=0.115","httpx>=0.27,<1"]\n')
            (root / "uv.lock").write_text('[[package]]\nname="drift"\n[package.optional-dependencies]\napi=[{name="fastapi"}]\n[[package]]\nname="cpufeature"\nversion="0.2.1"\nwheels=[]\n')
            result = runtime.inspect_dependency_inputs(root)
        self.assertEqual(result["api_dependencies_missing_from_lock"], ["httpx"])
        self.assertFalse(result["cpufeature_linux_cp312_wheel"])
        self.assertFalse(result["image_built"])
        self.assertFalse(result["image_qualified"])


if __name__ == "__main__":
    unittest.main()
