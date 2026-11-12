"""Settings for a self-hosted model served by vLLM on Modal. No Modal import: unit-testable.

A deployment is a profile from `profiles/<name>.json` plus explicit overrides, bound to one
owned Modal app name. At deploy time the resolved settings travel as base64 JSON in
FACTORY_SELFHOST_SETTINGS_B64 and are frozen into the image, so the container serves exactly
what was deployed.
"""
import base64
import json
import os
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILES_DIR = HERE / 'profiles'
PRICES = json.loads((HERE / 'prices.json').read_text(encoding='utf-8'))
GPU_MEMORY_GIB = {'L40S': 48, 'A100-80GB': 80, 'RTX-PRO-6000': 96, 'H100': 80, 'H200': 141, 'B200': 180, 'B300': 288}
KV_DTYPES = ('auto', 'bf16', 'fp8')
# Each replica is its own web function (and URL) with at most one GPU container.
MAX_REPLICAS = 4
REPLICA_FUNCTIONS = ('serve', 'serve_b', 'serve_c', 'serve_d')
# <prefix>-<profile>-<12 hex>; Modal names stay below 64 characters with the volume suffixes.
APP_NAME = re.compile(r'[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[a-f0-9]{12}')
PROFILE_NAME = re.compile(r'[a-z][a-z0-9]{1,15}')
# Modal volume names: letters, digits, dashes, dots and underscores, below 64 characters.
VOLUME_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,62}')
SETTINGS_ENV = 'FACTORY_SELFHOST_SETTINGS_B64'
# Profile keys that describe the model for clients, not the server.
CLIENT_KEYS = ('comment', 'compact_tokens', 'efforts')


@dataclass(frozen=True)
class Settings:
    app_name: str = 'factory-unconfigured-000000000000'
    profile: str = 'qwen'
    label: str = 'Qwen3.8-27B FP8 on H100'
    model: str = 'Qwen/Qwen3.8-27B-FP8'
    revision: str = '017b9c7af6b5689d5dd426a76e0bc077eb5ca20a'
    served_name: str = 'qwen3.8-27b'
    weights_gib: float = 30.9
    gpu: str = 'H100'
    gpu_count: int = 1
    cpu: int = 8
    memory_mib: int = 65536
    max_model_len: int = 262_144
    kv_cache_dtype: str = 'auto'
    # Attention cache bytes per token at the checkpoint's own cache precision ('auto').
    kv_bytes_per_token: int = 65536
    # Constant recurrent (Mamba / DeltaNet) state per running sequence, when it matters.
    state_gib_per_sequence: float = 0.0
    gpu_memory_utilization: float = 0.92
    max_num_seqs: int = 48
    enable_thinking: bool = True
    tool_call_parser: str = 'qwen3_xml'
    reasoning_parser: str = 'qwen3'
    extra_args: tuple = ()
    # More chat-template switches sent by default.
    template_kwargs: dict = field(default_factory=dict)
    # Named sets of extra vLLM flags and the one deployed.
    variants: dict = field(default_factory=dict)
    variant: str = ''
    trust_remote_code: bool = False
    # A ready-made vLLM image pinned by digest; empty = CUDA image + `pip install vllm`.
    image: str = ''
    vllm_version: str = '0.30.0'
    # Extra environment variables for the vLLM process.
    env: dict = field(default_factory=dict)
    input_modalities: tuple = ('text',)
    replicas: int = 1
    # Idle minutes before a GPU container stops (Modal allows 1..20).
    scaledown_minutes: int = 10
    # Longest single request. Modal's starter plan never schedules a GPU function whose limit is
    # 45 minutes or more (it waits without an error; measured 2026-11-11: 10 to 30 start in
    # seconds, 45 and 60 never). One model call of an agent stays far below 30.
    request_timeout_minutes: int = 30
    startup_timeout_minutes: int = 40
    # An existing volume to use for the weights / the compile caches instead of the app's own
    # (for example one an earlier deployment filled). Such a volume is never created or deleted
    # here; empty = the owned `<app>-hf-cache` / `<app>-vllm-cache`.
    weights_volume: str = ''
    compile_volume: str = ''
    port: int = 8000

    def __post_init__(self):
        if not APP_NAME.fullmatch(self.app_name):
            raise ValueError('app_name must be <prefix>-<profile>-<12 hex>')
        if not PROFILE_NAME.fullmatch(self.profile):
            raise ValueError('profile must be a short lowercase name')
        if self.gpu not in GPU_MEMORY_GIB or self.gpu not in PRICES['gpuPerSecond']:
            raise ValueError(f'unknown gpu {self.gpu!r}; expected one of {sorted(GPU_MEMORY_GIB)}')
        if not 1 <= self.gpu_count <= 8:
            raise ValueError('gpu_count must be within 1..8')
        if not 1024 <= self.max_model_len <= 1_000_000:
            raise ValueError('max_model_len must be within 1024..1000000')
        if self.kv_cache_dtype not in KV_DTYPES:
            raise ValueError(f'kv_cache_dtype must be one of {KV_DTYPES}')
        if not 0.5 <= self.gpu_memory_utilization <= 0.98:
            raise ValueError('gpu_memory_utilization must be within 0.5..0.98')
        if not 1 <= self.max_num_seqs <= 1024:
            raise ValueError('max_num_seqs must be within 1..1024')
        if not 1 <= self.replicas <= MAX_REPLICAS:
            raise ValueError(f'replicas must be within 1..{MAX_REPLICAS}')
        if not 1 <= self.scaledown_minutes <= 20:
            raise ValueError('scaledown_minutes must be within 1..20 (Modal limit)')
        if not 1 <= self.request_timeout_minutes <= 1440:
            raise ValueError('request_timeout_minutes must be within 1..1440 (Modal limit)')
        for name in ('weights_volume', 'compile_volume'):
            value = getattr(self, name)
            if value and (not VOLUME_NAME.fullmatch(value) or value.startswith(self.app_name)):
                raise ValueError(f'{name} must name an existing volume outside this app')
        if self.variant and self.variant not in self.variants:
            raise ValueError(f'unknown variant {self.variant!r}; expected one of {sorted(self.variants)}')
        if self.image and not re.fullmatch(r'[\w./-]+@sha256:[a-f0-9]{64}', self.image):
            raise ValueError('image must be pinned by digest')
        if not set(self.input_modalities) <= {'text', 'image'} or 'text' not in self.input_modalities:
            raise ValueError('input_modalities must include text and may add image')
        if not all(isinstance(arg, str) for arg in self.extra_args):
            raise ValueError('extra_args must be strings')

    @property
    def gpu_spec(self):
        return self.gpu if self.gpu_count == 1 else f'{self.gpu}:{self.gpu_count}'

    def endpoint_functions(self):
        """The web functions, one per replica; each has its own URL."""
        return list(REPLICA_FUNCTIONS[:self.replicas])

    def volumes(self):
        """Weights and compile-cache volume names, and whether this app owns (creates, deletes) each."""
        return {'weights': {'name': self.weights_volume or self.app_name + '-hf-cache', 'owned': not self.weights_volume},
                'compile': {'name': self.compile_volume or self.app_name + '-vllm-cache', 'owned': not self.compile_volume}}

    def usd_per_second(self):
        """List price of one running replica: GPU plus its reserved CPU and memory."""
        return (PRICES['gpuPerSecond'][self.gpu] * self.gpu_count + self.cpu * PRICES['cpuCorePerSecond']
                + self.memory_mib / 1024 * PRICES['memoryGibPerSecond'])

    def usd_per_hour(self):
        return round(self.usd_per_second() * 3600, 2)

    def estimate_gib(self):
        """Memory for one request at the full context. A calculation, not a measurement."""
        per_token = self.kv_bytes_per_token / (2 if self.kv_cache_dtype == 'fp8' else 1)
        kv = self.max_model_len * per_token / 2**30
        usable = GPU_MEMORY_GIB[self.gpu] * self.gpu_count * self.gpu_memory_utilization
        total = self.weights_gib + kv + self.state_gib_per_sequence
        return {'weights': self.weights_gib, 'kv_cache': round(kv, 1), 'state': self.state_gib_per_sequence,
                'total': round(total, 1), 'usable': round(usable, 1), 'fits': total <= usable}

    def chat_template_kwargs(self):
        return {'enable_thinking': self.enable_thinking, **self.template_kwargs}

    def variant_args(self):
        return list(self.variants.get(self.variant, ())) if self.variant else []

    def vllm_command(self):
        command = ['vllm', 'serve', self.model, '--revision', self.revision,
                   '--served-model-name', self.served_name,
                   '--host', '0.0.0.0', '--port', str(self.port),
                   '--max-model-len', str(self.max_model_len),
                   '--gpu-memory-utilization', str(self.gpu_memory_utilization),
                   '--kv-cache-dtype', self.kv_cache_dtype,
                   '--max-num-seqs', str(self.max_num_seqs),
                   '--enable-prefix-caching', '--middleware', 'discovery.models_metadata',
                   '--enable-auto-tool-choice', '--tool-call-parser', self.tool_call_parser,
                   '--reasoning-parser', self.reasoning_parser,
                   '--default-chat-template-kwargs', json.dumps(self.chat_template_kwargs())]
        if self.trust_remote_code:
            # The model's own code and tokenizer come from the same pinned revision as its weights; without these flags
            # the Hub serves the default branch's code files (transformers warns "A new version ... was downloaded").
            command += ['--trust-remote-code', '--code-revision', self.revision, '--tokenizer-revision', self.revision]
        if self.gpu_count > 1:
            command += ['--tensor-parallel-size', str(self.gpu_count)]
        return command + list(self.extra_args) + self.variant_args()

    def describe(self):
        """Public description: no key, no URL."""
        return {'appName': self.app_name, 'profile': self.profile, 'label': self.label, 'model': self.served_name,
                'gpu': self.gpu_spec, 'replicas': self.replicas, 'functions': self.endpoint_functions(),
                'usdPerHourPerReplica': self.usd_per_hour(), 'usdPerSecondPerReplica': self.usd_per_second(),
                'scaledownMinutes': self.scaledown_minutes, 'startupTimeoutMinutes': self.startup_timeout_minutes,
                'requestTimeoutMinutes': self.request_timeout_minutes, 'volumes': self.volumes(),
                'contextWindow': self.max_model_len, 'variant': self.variant or None,
                'inputModalities': list(self.input_modalities), 'estimateGib': self.estimate_gib(),
                'vllmCommand': self.vllm_command()}

    def to_json(self):
        data = asdict(self)
        data['extra_args'] = list(self.extra_args)
        data['input_modalities'] = list(self.input_modalities)
        return json.dumps(data, sort_keys=True)

    def to_b64(self):
        # base64: flag values with quotes survive the image's ENV line.
        return base64.b64encode(self.to_json().encode('utf-8')).decode('ascii')


def profile_data(name):
    if not PROFILE_NAME.fullmatch(name or '') or not (PROFILES_DIR / f'{name}.json').is_file():
        raise ValueError(f'unknown profile {name!r}; expected one of {profile_names()}')
    return json.loads((PROFILES_DIR / f'{name}.json').read_text(encoding='utf-8'))


def profile_names():
    return sorted(path.stem for path in PROFILES_DIR.glob('*.json'))


def client_hints(name):
    """Profile hints for worker programs (compaction point, accepted effort levels)."""
    data = profile_data(name)
    return {key: data[key] for key in ('compact_tokens', 'efforts') if key in data}


def from_dict(data):
    names = {f.name for f in fields(Settings)}
    unknown = set(data) - names
    if unknown:
        raise ValueError(f'unknown settings: {sorted(unknown)}')
    data = dict(data)
    for key in ('extra_args', 'input_modalities'):
        if key in data:
            data[key] = tuple(data[key])
    return Settings(**data)


def resolve(app_name, profile, overrides=None):
    """The profile's settings with explicit overrides, bound to an owned app name."""
    data = {key: value for key, value in profile_data(profile).items() if key not in CLIENT_KEYS}
    overrides = dict(overrides or {})
    for key in ('app_name', 'profile'):
        if key in overrides:
            raise ValueError(f'{key} cannot be overridden')
    if not app_name.split('-')[1] == profile:
        raise ValueError('the owned app name must carry its profile')
    return from_dict({**data, **overrides, 'app_name': app_name, 'profile': profile})


def from_env(env=None):
    """Inside the container (and during `modal deploy`): the frozen settings."""
    env = os.environ if env is None else env
    raw = env.get(SETTINGS_ENV)
    if not raw:
        raise ValueError(f'{SETTINGS_ENV} is required')
    return from_dict(json.loads(base64.b64decode(raw).decode('utf-8')))
