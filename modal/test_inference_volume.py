"""Definition-only import and Volume identity checks with no SDK RPCs."""
import importlib.util
from importlib.metadata import PackageNotFoundError
import os
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from http_resume import guard_identity, require_identity


class InferenceVolumeTests(unittest.TestCase):
    def definition(self):
        calls, functions, environments, packages, local_files = [], {}, [], [], []
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
            def uv_pip_install(self, *args): packages.extend(args); return self
            def add_local_file(self, *args): local_files.append(args); return self
            def env(self, values): environments.append(values); return self
        class Volume:
            @staticmethod
            def from_name(name, **kwargs):
                calls.append({"name": name, **kwargs})
                def hydrate(): calls.append("hydrate"); return SimpleNamespace(object_id="vo-owned")
                return SimpleNamespace(hydrate=hydrate, commit=lambda: calls.append("commit"))
        fake.App, fake.Image, fake.Volume = App, Image, Volume
        fake.concurrent = fake.web_server = lambda *args, **kwargs: lambda function: function
        spec = importlib.util.spec_from_file_location("offline_inference_definition", Path(__file__).with_name("inference.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"modal": fake}), patch.dict(os.environ, {
            "FACTORY_MODAL_APP_NAME": "factory-offline-model", "FACTORY_MODAL_VOLUME_NAME": "factory-offline-weights", "FACTORY_MODAL_VOLUME_ID": "vo-owned",
        }): spec.loader.exec_module(module)
        module.offline_local_files = local_files
        return module, calls, functions, environments, packages

    def test_import_is_lazy_v2_without_hydration_or_implicit_creation(self):
        module, calls, functions, environments, packages = self.definition()
        self.assertEqual(calls, [{"name": "factory-offline-weights", "create_if_missing": False, "version": 2}])
        self.assertEqual(functions["prefetch"]["cpu"], (2, 2))
        self.assertEqual(functions["prefetch"]["memory"], (2048, 2048))
        self.assertEqual(functions["prefetch"]["timeout"], 3600)
        self.assertTrue(all(environment["FACTORY_MODAL_VOLUME_ID"] == "vo-owned" for environment in environments))
        self.assertEqual(module.CONFIG["revision"], "c03e6d358207e414f1eca0bb1891e29f1db0e242")
        self.assertIn("huggingface_hub==0.36.0", packages)
        self.assertEqual(sum(target == "/opt/factory/http_resume.py" for _, target in module.offline_local_files), 2)
        download_environment = environments[-1]
        self.assertEqual(download_environment["HF_HUB_DISABLE_XET"], "1")
        self.assertEqual(download_environment["HF_XET_HIGH_PERFORMANCE"], "0")
        self.assertEqual(download_environment["HF_HUB_ENABLE_HF_TRANSFER"], "0")

    def test_runtime_identity_check_refuses_replaced_volume(self):
        module, calls, _, _, _ = self.definition()
        module.VOLUME_ID = "vo-other"
        with self.assertRaises(RuntimeError): module.checked_weights()
        self.assertEqual(calls[-1], "hydrate")

    def download(self, *, environment=None, hub_version="0.36.0", xet_version="1.6.0", stale_constants=False, failure=None, artifact_failure=None, resume_validation=None):
        module, calls, functions, environments, _ = self.definition()
        captured = []
        fake_hub = ModuleType("huggingface_hub")
        def snapshot_download(**kwargs):
            captured.append(kwargs)
            self.assertEqual(calls[-1], "hydrate")
            if failure: raise failure
            return kwargs["local_dir"]
        fake_hub.snapshot_download = snapshot_download
        fake_hub.constants = SimpleNamespace(HF_HUB_DISABLE_XET=not stale_constants, HF_HUB_ENABLE_HF_TRANSFER=False)
        def metadata(name):
            if name == "huggingface-hub": return hub_version
            if name == "hf-xet" and xet_version is not None: return xet_version
            raise PackageNotFoundError(name)
        env = {**environments[-1], **(environment or {})}
        def artifacts(model_path, config):
            self.assertEqual(model_path, module.MODEL_PATH)
            self.assertIs(config, module.CONFIG)
            calls.append("validate-artifacts")
            if artifact_failure: raise artifact_failure
            return {"mocked": True}
        def install(expected):
            require_identity(expected)
            calls.append("guard-installed")
            return SimpleNamespace(close=lambda: calls.append("guard-closed"),
                                   receipt=lambda: {**guard_identity(), "validatedResponses": 0})
        with patch.dict("sys.modules", {"huggingface_hub": fake_hub}), patch.dict(os.environ, env), \
                patch.object(module, "version", metadata), patch.object(module, "validate_model_artifacts", artifacts), \
                patch.object(module, "install_http_resume_guard", install):
            try: result = module.prefetch(guard_identity() if resume_validation is None else resume_validation)
            except Exception as error: return error, calls, captured, functions
        return result, calls, captured, functions

    def test_anonymous_single_thread_http_download_binds_revision_patterns_and_private_metadata(self):
        result, calls, captured, functions = self.download(environment={"HF_TOKEN": "private-inherited-token"})
        self.assertEqual(calls[-4:], ["hydrate", "guard-closed", "validate-artifacts", "commit"])
        self.assertEqual(result["artifactProof"], {"mocked": True})
        self.assertEqual(captured, [{"repo_id": "Qwen/Qwen2.5-Coder-7B-Instruct",
            "revision": "c03e6d358207e414f1eca0bb1891e29f1db0e242", "local_dir": "/models/c03e6d358207e414f1eca0bb1891e29f1db0e242",
            "allow_patterns": ["*.json", "*.safetensors", "*.txt", "*.model", "LICENSE*", "README.md"], "max_workers": 1, "token": False}])
        self.assertEqual(result["download"], {"transport": "http", "maxWorkers": 1, "hubVersion": "0.36.0", "hfXetVersion": "1.6.0", "xetDisabled": True, "hfTransferDisabled": True,
                                           "resumeValidation": {**guard_identity(), "validatedResponses": 0}})
        self.assertNotIn("private-inherited-token", str(result))
        self.assertEqual(functions["prefetch"]["max_containers"], 1)
        self.assertEqual(functions["prefetch"]["retries"], 0)

    def test_unsafe_environment_stale_import_or_dependency_mismatch_refuses_before_download_or_hydration(self):
        cases = [{"environment": {"HF_HUB_DISABLE_XET": "0"}}, {"environment": {"HF_XET_HIGH_PERFORMANCE": "1"}},
                 {"environment": {"HF_HUB_ENABLE_HF_TRANSFER": "1"}}, {"stale_constants": True}, {"hub_version": "1.29.0"},
                 {"xet_version": "private diagnostic /path"}]
        for case in cases:
            with self.subTest(case=case):
                result, calls, captured, _ = self.download(**case)
                self.assertIsInstance(result, RuntimeError)
                self.assertNotIn("hydrate", calls)
                self.assertNotIn("commit", calls)
                self.assertEqual(captured, [])

    def test_native_package_absence_is_reported_without_selecting_xet(self):
        result, calls, captured, _ = self.download(xet_version=None)
        self.assertIsNone(result["download"]["hfXetVersion"])
        self.assertEqual(captured[0]["max_workers"], 1)
        self.assertEqual(calls[-1], "commit")

    def test_download_failure_does_not_commit_or_claim_cached_weights(self):
        failure = RuntimeError("offline simulated transport failure")
        result, calls, captured, _ = self.download(failure=failure)
        self.assertIs(result, failure)
        self.assertEqual(len(captured), 1)
        self.assertNotIn("commit", calls)
        self.assertEqual(calls[-1], "guard-closed")

    def test_unadmitted_http_resume_guard_refuses_before_hydration_or_download(self):
        for validation in [{}, {**guard_identity(), "guardSha256": "0" * 64},
                           {**guard_identity(), "schemaVersion": True}, {**guard_identity(), "extra": True}]:
            with self.subTest(validation=validation):
                result, calls, captured, _ = self.download(resume_validation=validation)
                self.assertIsInstance(result, RuntimeError)
                self.assertNotIn("hydrate", calls)
                self.assertNotIn("commit", calls)
                self.assertEqual(captured, [])

    def test_artifact_failure_does_not_commit_or_claim_cached_weights(self):
        failure = RuntimeError("offline simulated incomplete model")
        result, calls, captured, _ = self.download(artifact_failure=failure)
        self.assertIs(result, failure)
        self.assertEqual(len(captured), 1)
        self.assertEqual(calls[-1], "validate-artifacts")
        self.assertNotIn("commit", calls)


if __name__ == "__main__": unittest.main()
