"""A self-hosted model on Modal, served by vLLM itself.

vLLM answers /v1/responses (Codex), /v1/messages (Claude Code) and /v1/chat/completions
directly; there is no translation layer. Access is the bearer key in the `<app>-auth` Modal
secret, enforced by vLLM's --api-key. Each replica is its own web function with at most one
GPU container, so the GPU count cannot run away; idle containers stop after the profile's
scale-down time and cost nothing while stopped.
"""
import os

import modal

from settings import from_env

S = from_env()
MINUTES = 60
HF_CACHE = '/root/.cache/huggingface'

if S.image:
    # A ready-made vLLM release image pinned by digest. Modal looks for `python`; the vLLM
    # images only have `python3`.
    base = (modal.Image.from_registry(S.image)
            .dockerfile_commands(['RUN ln -sf "$(command -v python3)" /usr/local/bin/python && python --version'])
            .entrypoint([]))
else:
    base = (modal.Image.from_registry('nvidia/cuda:12.9.0-devel-ubuntu22.04', add_python='3.12')
            .entrypoint([])
            .uv_pip_install(f'vllm=={S.vllm_version}'))
image = (
    base
    .env({'HF_XET_HIGH_PERFORMANCE': '1', 'VLLM_ALLOW_LONG_MAX_MODEL_LEN': '1',
          # Triton kernels compiled at start-up are kept in the vLLM cache volume.
          'TRITON_CACHE_DIR': '/root/.cache/vllm/triton',
          # Frozen settings: the container serves what was deployed.
          'FACTORY_SELFHOST_SETTINGS_B64': S.to_b64()})
    .add_local_python_source('settings', 'discovery')
    .add_local_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prices.json'), '/root/prices.json')
)

app = modal.App(S.app_name)
hf_cache = modal.Volume.from_name(S.app_name + '-hf-cache', create_if_missing=True)
vllm_cache = modal.Volume.from_name(S.app_name + '-vllm-cache', create_if_missing=True)
auth = modal.Secret.from_name(S.app_name + '-auth', required_keys=['VLLM_API_KEY'])
VOLUMES = {HF_CACHE: hf_cache, '/root/.cache/vllm': vllm_cache}

# CPU helpers exist only in the short-lived app that the deploy script starts for a weight
# prefetch or a flag check (FACTORY_SELFHOST_HELPERS=1); the deployed app leaves them out, so
# nothing idle can fail or alert.
HELPERS = os.environ.get('FACTORY_SELFHOST_HELPERS') == '1'


def _helper(**kwargs):
    return app.function(**kwargs) if HELPERS else (lambda f: f)


@_helper(image=image, cpu=4, memory=8192, volumes=VOLUMES, timeout=60 * MINUTES)
def download():
    """Fill the weights volume on a cheap CPU container (no GPU billed while downloading)."""
    import time
    from huggingface_hub import snapshot_download
    began = time.monotonic()
    snapshot_download(S.model, revision=S.revision)
    hf_cache.commit()
    return {'seconds': round(time.monotonic() - began)}


@_helper(image=image, cpu=2, memory=4096, timeout=10 * MINUTES)
def vllm_flags(words: list):
    """Which of these flags does this vLLM know? Reads vLLM's source (its CLI needs a GPU)."""
    import pathlib
    import vllm
    source = ' '.join(p.read_text(errors='ignore') for p in pathlib.Path(vllm.__file__).parent.rglob('*.py'))
    return {word: word.lstrip('-').replace('-', '_') in source for word in words}


def _start_vllm():
    import subprocess
    if len(os.environ['VLLM_API_KEY']) < 32:
        raise RuntimeError('INFERENCE_AUTH_NOT_CONFIGURED')
    # /root holds settings.py and discovery.py; vLLM imports the middleware by name. The
    # profile's environment wins over what Modal sets (Modal sets OMP_NUM_THREADS to the CPUs).
    subprocess.Popen(S.vllm_command(), env={**os.environ, **S.env, 'PYTHONPATH': '/root',
                                            'FACTORY_SELFHOST_INPUT_MODALITIES': ','.join(S.input_modalities)})


# The short-lived helper app has no serving functions: they need the key's secret, which only
# the deployment creates, after the weights are in place.
if not HELPERS:
    GPU_FUNCTION = dict(image=image, gpu=S.gpu_spec, cpu=S.cpu, memory=S.memory_mib, secrets=[auth],
                        volumes=VOLUMES, scaledown_window=S.scaledown_minutes * MINUTES,
                        min_containers=0, max_containers=1, timeout=S.request_timeout_minutes * MINUTES)
    # A web_server endpoint holds requests while a cold container starts. Modal's own auth stays
    # off; vLLM checks the bearer key (VLLM_API_KEY).
    WEB = dict(port=S.port, startup_timeout=S.startup_timeout_minutes * MINUTES)
    CONCURRENT = dict(max_inputs=min(1000, S.max_num_seqs * 4))  # Modal's limit is 1000


    @app.function(**GPU_FUNCTION)
    @modal.concurrent(**CONCURRENT)
    @modal.web_server(**WEB)
    def serve():
        _start_vllm()


    if S.replicas >= 2:
        @app.function(**GPU_FUNCTION)
        @modal.concurrent(**CONCURRENT)
        @modal.web_server(**WEB)
        def serve_b():
            _start_vllm()

    if S.replicas >= 3:
        @app.function(**GPU_FUNCTION)
        @modal.concurrent(**CONCURRENT)
        @modal.web_server(**WEB)
        def serve_c():
            _start_vllm()

    if S.replicas >= 4:
        @app.function(**GPU_FUNCTION)
        @modal.concurrent(**CONCURRENT)
        @modal.web_server(**WEB)
        def serve_d():
            _start_vllm()
