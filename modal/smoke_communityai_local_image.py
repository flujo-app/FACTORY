"""Import/CLI smoke for an owned network-none container; never starts a role."""

import hashlib
import importlib.metadata
import inspect
import json
from pathlib import Path
import subprocess
import sys

import cpufeature
import hivemind
import torch

from drift.api.server import create_factory_app
from drift.model_manifest import ModelManifest
from drift.node.discovery import ModelCoverageDiscovery
from drift.node.loading import make_text_peer_loader
from drift.protocol_identity import NodeIdentity
from drift.server.text_peer import TextPeerService
import communityai_bootstrap
import communityai_runtime
import communityai_runtime_watchdog


manifest_path = Path("/opt/factory/communityai-model-manifest.json")
manifest = ModelManifest.load(manifest_path)
manifest_raw_sha256 = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
assert manifest.digest_id == communityai_bootstrap.MANIFEST_DIGEST
assert manifest_raw_sha256 == communityai_bootstrap.MANIFEST_RAW_SHA256


commands = [
    [sys.executable, "/opt/factory/communityai_runtime.py", "--help"],
    [sys.executable, "/opt/factory/communityai_runtime_watchdog.py", "--help"],
    [sys.executable, "-m", "drift.cli", "server", "--help"],
    [sys.executable, "-m", "drift.cli", "text-peer", "--help"],
]
results = []
for command in commands:
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45)
    results.append({"argv": command, "exit_code": result.returncode,
                    "stdout": result.stdout, "stderr": result.stderr})
    if result.returncode != 0:
        print(json.dumps({"phase": "help_failed", "results": results}), flush=True)
        raise SystemExit(result.returncode)
source = Path(inspect.getsourcefile(hivemind.DHT))
print(json.dumps({"scope": "imports_and_help_only", "results": results,
                  "versions": {name: importlib.metadata.version(name)
                               for name in ("torch", "hivemind", "cpufeature", "transformers", "fastapi", "httpx", "uvicorn")},
                  "factory_source_label": communityai_runtime.SOURCE_COMMIT,
                  "factory_source_pins": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                          for path in Path("/opt/factory").glob("*.py")},
                  "manifest_protocol_digest": manifest.digest_id,
                  "manifest_raw_sha256": manifest_raw_sha256,
                  "factory_api_callable": callable(create_factory_app),
                  "text_peer_class": TextPeerService.__name__,
                  "hivemind_dht_source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                  "hivemind_constructor": str(inspect.signature(hivemind.DHT)),
                  "hivemind_run_coroutine": str(inspect.signature(hivemind.DHT.run_coroutine)),
                  "hivemind_run_in_background": str(inspect.signature(hivemind.DHT.run_in_background)),
                  "hivemind_shutdown": str(inspect.signature(hivemind.DHT.shutdown)),
                  "peers_started": False, "model_loaded": False, "inference_verified": False,
                  "provider_or_original_admission_verified": False}), flush=True)
