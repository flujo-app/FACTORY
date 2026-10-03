"""Capture the real serve command offline; these checks do not boot vLLM.

Tagged upstream parser qualification is a separate source-bound probe. This
suite has no vLLM installation, model download, Modal RPC, or child process.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


def load_definition():
    """Import the actual definition against an entirely local fake Modal SDK."""
    calls, functions, environments, packages = [], {}, [], []
    fake = ModuleType("modal")

    class App:
        def __init__(self, name): self.name = name
        def function(self, **kwargs):
            def decorate(function):
                functions[function.__name__] = kwargs
                return function
            return decorate

    class Image:
        @classmethod
        def from_registry(cls, *args, **kwargs): return cls()
        @classmethod
        def debian_slim(cls, *args, **kwargs): return cls()
        def entrypoint(self, *args): return self
        def uv_pip_install(self, *args): packages.extend(args); return self
        def add_local_file(self, *args): return self
        def env(self, values): environments.append(values); return self

    class Volume:
        @staticmethod
        def from_name(name, **kwargs):
            calls.append({"name": name, **kwargs})
            def hydrate():
                calls.append("hydrate")
                return SimpleNamespace(object_id="vo-offline")
            return SimpleNamespace(hydrate=hydrate)

    fake.App, fake.Image, fake.Volume = App, Image, Volume
    fake.concurrent = fake.web_server = lambda *args, **kwargs: lambda function: function
    spec = importlib.util.spec_from_file_location(
        "offline_inference_cli_definition", Path(__file__).with_name("inference.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict("sys.modules", {"modal": fake}), patch.dict(os.environ, {
        "FACTORY_MODAL_APP_NAME": "factory-offline-model",
        "FACTORY_MODAL_VOLUME_NAME": "factory-offline-weights",
        "FACTORY_MODAL_VOLUME_ID": "vo-offline",
    }), patch.object(socket.socket, "connect", side_effect=AssertionError("Unexpected network access")):
        spec.loader.exec_module(module)
    return module, calls, functions, environments, packages


def capture_serve(module):
    """Capture real argv with a mocked artifact gate; no model verification or boot."""
    captured = []
    with tempfile.TemporaryDirectory(prefix="factory-inference-cli-") as directory:
        order = []
        def artifacts(model_path, config):
            if model_path != directory or config is not module.CONFIG:
                raise AssertionError("The artifact gate must check the actual configured model path")
            order.append("artifact-gate")
            return {"mocked": True}
        def capture(command, **kwargs):
            if order != ["artifact-gate"]:
                raise AssertionError("The artifact gate must finish before child construction")
            order.append("child")
            captured.append((list(command), dict(kwargs)))
            return SimpleNamespace(pid=0)
        with patch.object(module, "MODEL_PATH", directory), patch.object(module, "validate_model_artifacts", artifacts), \
                patch.object(module.subprocess, "Popen", capture), \
                patch.object(socket.socket, "connect", side_effect=AssertionError("Unexpected network access")):
            module.serve()
    if len(captured) != 1:
        raise AssertionError("The actual serve body must construct exactly one child command")
    return captured[0]


class InferenceCliTests(unittest.TestCase):
    def test_actual_command_explicitly_disables_request_logging_and_discards_child_output(self):
        module, calls, _, environments, _ = load_definition()
        with patch.dict(os.environ, {"HF_TOKEN": "offline-private-token", "MODAL_TOKEN_SECRET": "offline-private-secret"}):
            command, kwargs = capture_serve(module)
        self.assertEqual(calls[-1], "hydrate")
        self.assertEqual(command.count("--no-enable-log-requests"), 1)
        self.assertNotIn("--disable-log-requests", command)
        self.assertNotIn("--enable-log-requests", command)
        self.assertIn("--disable-log-stats", command)
        self.assertIn("--disable-uvicorn-access-log", command)
        self.assertEqual(command[command.index("--uvicorn-log-level") + 1], "warning")
        self.assertEqual(kwargs, {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL})
        self.assertNotIn("offline-private-token", str(command))
        self.assertNotIn("offline-private-secret", str(command))
        self.assertEqual(environments[0]["VLLM_DEBUG_LOG_API_SERVER_RESPONSE"], "0")
        self.assertEqual(environments[0]["VLLM_LOGGING_LEVEL"], "WARNING")

    def test_actual_command_preserves_pinned_entrypoint_and_bounded_model_configuration(self):
        module, _, functions, _, packages = load_definition()
        command, _ = capture_serve(module)
        self.assertEqual(command[:3], [module.sys.executable, "-m", "vllm.entrypoints.openai.api_server"])
        self.assertEqual(module.CONFIG["vllmVersion"], "0.21.0")
        self.assertIn("vllm==0.21.0", packages)
        def value(flag): return command[command.index(flag) + 1]
        self.assertEqual(value("--served-model-name"), module.CONFIG["servedModel"])
        self.assertEqual(value("--dtype"), "bfloat16")
        self.assertEqual(value("--max-model-len"), str(module.CONFIG["maxModelLength"]))
        self.assertEqual(value("--max-num-seqs"), str(module.CONFIG["concurrentInputs"]))
        self.assertEqual(value("--gpu-memory-utilization"), str(module.CONFIG["gpuMemoryUtilization"]))
        self.assertEqual(value("--generation-config"), "vllm")
        self.assertEqual(json.loads(value("--override-generation-config")), {"max_new_tokens": module.CONFIG["maxOutputTokens"]})
        self.assertEqual(value("--middleware"), "factory_policy.FactoryPolicyMiddleware")
        self.assertEqual(value("--host"), "0.0.0.0")
        self.assertEqual(value("--port"), "8000")
        self.assertIn("--enforce-eager", command)
        serve = functions["serve"]
        self.assertEqual(serve["gpu"], module.CONFIG["gpu"])
        self.assertEqual(serve["cpu"], (module.CONFIG["cpuCores"],) * 2)
        self.assertEqual(serve["memory"], (module.CONFIG["memoryMiB"],) * 2)
        self.assertEqual(serve["max_containers"], 1)
        self.assertEqual(serve["min_containers"], 0)
        self.assertEqual(serve["buffer_containers"], 0)
        self.assertEqual(serve["timeout"], module.CONFIG["requestTimeoutSeconds"])
        self.assertEqual(serve["startup_timeout"], module.CONFIG["startupTimeoutSeconds"])

    def test_wrong_recorded_volume_refuses_before_constructing_child(self):
        module, calls, _, _, _ = load_definition()
        module.VOLUME_ID = "vo-other"
        with patch.object(module.subprocess, "Popen") as spawn:
            with self.assertRaises(RuntimeError): module.serve()
        spawn.assert_not_called()
        self.assertEqual(calls[-1], "hydrate")

    def test_missing_pinned_artifacts_refuse_before_constructing_child(self):
        module, calls, _, _, _ = load_definition()
        with tempfile.TemporaryDirectory(prefix="factory-inference-cli-") as directory, \
                patch.object(module, "MODEL_PATH", directory), patch.object(module.subprocess, "Popen") as spawn:
            with self.assertRaises(RuntimeError): module.serve()
        spawn.assert_not_called()
        self.assertEqual(calls[-1], "hydrate")


if __name__ == "__main__": unittest.main()
