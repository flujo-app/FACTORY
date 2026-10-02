"""Deploy with explicit run-owned App/Volume names; importing does not deploy."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

import modal

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
if not CONFIG_PATH.is_file():
    CONFIG_PATH = Path("/opt/factory/config.json")
CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
POLICY_PATH = HERE / "factory_policy.py"
if not POLICY_PATH.is_file():
    POLICY_PATH = Path("/opt/factory/factory_policy.py")


def resource_name(variable):
    value = os.environ.get(variable, "")
    if not re.fullmatch(r"factory-[a-z0-9][a-z0-9-]{2,55}", value):
        raise ValueError(f"{variable} must be an explicit run-owned factory- name")
    return value


APP_NAME = resource_name("FACTORY_MODAL_APP_NAME")
VOLUME_NAME = resource_name("FACTORY_MODAL_VOLUME_NAME")
MODEL_PATH = f'/models/{CONFIG["revision"]}'
app = modal.App(APP_NAME)
# Create and journal this exact Volume separately before deployment. App import
# and deployment must not silently create an unrecorded persistent resource.
weights = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)
image = (
    modal.Image.from_registry(CONFIG["cudaImage"], add_python=CONFIG["pythonVersion"])
    .entrypoint([])
    .uv_pip_install(f'vllm=={CONFIG["vllmVersion"]}')
    .env({"PYTHONPATH": "/opt/factory", "FACTORY_MODAL_APP_NAME": APP_NAME,
          "FACTORY_MODAL_VOLUME_NAME": VOLUME_NAME, "HF_HUB_DISABLE_TELEMETRY": "1",
          "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
          "VLLM_DEBUG_LOG_API_SERVER_RESPONSE": "0", "VLLM_LOGGING_LEVEL": "WARNING"})
    .add_local_file(POLICY_PATH, "/opt/factory/factory_policy.py")
    .add_local_file(CONFIG_PATH, "/opt/factory/config.json")
)
download_image = modal.Image.debian_slim(python_version=CONFIG["pythonVersion"]).uv_pip_install(
    "huggingface_hub==0.36.0"
).env({"FACTORY_MODAL_APP_NAME": APP_NAME, "FACTORY_MODAL_VOLUME_NAME": VOLUME_NAME,
       "HF_HUB_DISABLE_TELEMETRY": "1", "HF_XET_HIGH_PERFORMANCE": "1"}).add_local_file(
    CONFIG_PATH, "/opt/factory/config.json"
)


@app.function(image=download_image, volumes={"/models": weights}, cpu=(2, 2),
              memory=(2048, 2048), timeout=CONFIG["prefetchTimeoutSeconds"],
              min_containers=0, max_containers=1, buffer_containers=0,
              scaledown_window=2, retries=0)
def prefetch():
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=CONFIG["model"], revision=CONFIG["revision"],
                      local_dir=MODEL_PATH,
                      allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "LICENSE*", "README.md"])
    weights.commit()
    return {"state": "weights-cached", "model": CONFIG["model"], "revision": CONFIG["revision"]}


@app.function(image=image, gpu=CONFIG["gpu"], volumes={"/models": weights},
              cpu=(CONFIG["cpuCores"], CONFIG["cpuCores"]),
              memory=(CONFIG["memoryMiB"], CONFIG["memoryMiB"]),
              min_containers=CONFIG["minContainers"], max_containers=CONFIG["maxContainers"],
              buffer_containers=CONFIG["bufferContainers"],
              scaledown_window=CONFIG["scaledownWindowSeconds"],
              timeout=CONFIG["requestTimeoutSeconds"], startup_timeout=CONFIG["startupTimeoutSeconds"])
@modal.concurrent(max_inputs=CONFIG["concurrentInputs"])
@modal.web_server(8000, startup_timeout=CONFIG["startupTimeoutSeconds"], requires_proxy_auth=True)
def serve():
    if not Path(MODEL_PATH, "config.json").is_file():
        raise RuntimeError("Factory model weights have not been prefetched.")
    command = [sys.executable, "-m", "vllm.entrypoints.openai.api_server",
               "--model", MODEL_PATH, "--served-model-name", CONFIG["servedModel"],
               "--host", "0.0.0.0", "--port", "8000", "--dtype", "bfloat16",
               "--max-model-len", str(CONFIG["maxModelLength"]),
               "--max-num-seqs", str(CONFIG["concurrentInputs"]),
               "--gpu-memory-utilization", str(CONFIG["gpuMemoryUtilization"]),
               "--generation-config", "vllm", "--override-generation-config",
               json.dumps({"max_new_tokens": CONFIG["maxOutputTokens"]}),
               "--enforce-eager", "--disable-log-requests", "--disable-log-stats",
               "--disable-uvicorn-access-log", "--uvicorn-log-level", "warning",
               "--middleware", "factory_policy.FactoryPolicyMiddleware"]
    # Engine/bootstrap diagnostics can include local paths and requests. Only
    # sanitized lifecycle/API evidence is published by the outer coordinator.
    subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
