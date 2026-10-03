"""Definition-only import and Volume identity checks with no SDK RPCs."""
import importlib.util
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class InferenceVolumeTests(unittest.TestCase):
    def definition(self):
        calls, functions, environments = [], {}, []
        fake = ModuleType("modal")
        class App:
            def __init__(self, name): self.name = name
            def function(self, **kwargs):
                def decorate(function): functions[function.__name__] = kwargs; return function
                return decorate
        class Image:
            @classmethod
            def from_registry(cls, *args, **kwargs): return cls()
            @classmethod
            def debian_slim(cls, *args, **kwargs): return cls()
            def entrypoint(self, *args): return self
            def uv_pip_install(self, *args): return self
            def add_local_file(self, *args): return self
            def env(self, values): environments.append(values); return self
        class Volume:
            @staticmethod
            def from_name(name, **kwargs):
                calls.append({"name": name, **kwargs})
                def hydrate(): calls.append("hydrate"); return SimpleNamespace(object_id="vo-owned")
                return SimpleNamespace(hydrate=hydrate)
        fake.App, fake.Image, fake.Volume = App, Image, Volume
        fake.concurrent = fake.web_server = lambda *args, **kwargs: lambda function: function
        spec = importlib.util.spec_from_file_location("offline_inference_definition", Path(__file__).with_name("inference.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"modal": fake}), patch.dict(os.environ, {
            "FACTORY_MODAL_APP_NAME": "factory-offline-model", "FACTORY_MODAL_VOLUME_NAME": "factory-offline-weights", "FACTORY_MODAL_VOLUME_ID": "vo-owned",
        }): spec.loader.exec_module(module)
        return module, calls, functions, environments

    def test_import_is_lazy_v2_without_hydration_or_implicit_creation(self):
        module, calls, functions, environments = self.definition()
        self.assertEqual(calls, [{"name": "factory-offline-weights", "create_if_missing": False, "version": 2}])
        self.assertEqual(functions["prefetch"]["cpu"], (2, 2))
        self.assertEqual(functions["prefetch"]["memory"], (2048, 2048))
        self.assertEqual(functions["prefetch"]["timeout"], 3600)
        self.assertTrue(all(environment["FACTORY_MODAL_VOLUME_ID"] == "vo-owned" for environment in environments))
        self.assertEqual(module.CONFIG["revision"], "c03e6d358207e414f1eca0bb1891e29f1db0e242")

    def test_runtime_identity_check_refuses_replaced_volume(self):
        module, calls, _, _ = self.definition()
        module.VOLUME_ID = "vo-other"
        with self.assertRaises(RuntimeError): module.checked_weights()
        self.assertEqual(calls[-1], "hydrate")


if __name__ == "__main__": unittest.main()
