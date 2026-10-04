"""Host integration for a fixed two-worker CommunityAI swarm; never deploys.

Requires the CommunityAI runtime containing create_factory_app, reviewed at
petals-revival commit 0cd07931fe32676c10d06d964ae7162005d25580 (PR 35).
The provider supervisor must first admit and own the Modal resources, pre-cache
the manifest's verified artifacts, and supply actual tunnel/seed observations.
Use Modal raw TCP tunnels (unencrypted_ports/tcp_socket), carrying Hivemind's own
application TLS. Modal TLS-termination sockets are not a substitute for peer TLS.
This module does not grant Original admission, model downloads, resource starts,
or paid dispatch. Its formation input is configuration, not authenticated proof.

build_launch_plan emits real `python -m drift.cli server/text-peer` commands.
The text-peer role may share a container with the bootstrap/API only when its
listen and public tunnel ports are distinct. The two block workers are distinct
resources. create_coordinator_app is called by a trusted host with its existing
Original admission callback and credential identifier, then served by that host.
No default admission callback, alternate model route, or provider retry exists.

Only coordinator composition and launch configuration are implemented here.
Modal deployment, formation, Original receiver authentication, inference, and
provider retirement remain unverified until the owning supervisor executes them.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
import hashlib
import inspect
import ipaddress
import json
import math
from pathlib import Path
import re
import time


MANIFEST_PATH = Path(__file__).with_name("communityai-model-manifest.json")
MANIFEST_RAW_SHA256 = "c0020aa16d142d8392c5179160f83f6f113f6142a081a2481925a1ae8ff90d5b"
MANIFEST_DIGEST = "sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056"
MODEL = "Qwen/Qwen3-1.7B"
REVISION = "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e"
RUNTIME_MANIFEST = "/opt/factory/communityai-model-manifest.json"
ROLES = ("bootstrap", "worker_0", "worker_1", "text_peer")
RESOURCE_RE = re.compile(r"sb-[A-Za-z0-9_-]{1,128}\Z")
PEER_RE = re.compile(r"/ip4/([^/]+)/tcp/([1-9][0-9]{0,4})/p2p/([1-9A-HJ-NP-Za-km-z]{20,128})\Z")


def _object(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f"Invalid {label} fields")
    return value


def _number(value, label):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"Invalid {label}")
    return value


def _port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError("An actual public/listen port is required")
    return value


def load_pinned_manifest():
    """Read exact retained bytes; the protocol digest is a separate identity."""
    raw = MANIFEST_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest() != MANIFEST_RAW_SHA256:
        raise ValueError("Pinned manifest file changed")
    data = json.loads(raw)
    data["aliases"] = sorted(data["aliases"])
    data["artifacts"] = sorted(data["artifacts"], key=lambda item: (item["path"], item["role"]))
    canonical = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)
    if "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest() != MANIFEST_DIGEST:
        raise ValueError("Pinned manifest protocol identity changed")
    if data["source"] != {"repository": MODEL, "revision": REVISION} or data["model"]["num_blocks"] != 28:
        raise ValueError("Fixed model topology changed")
    return data


def validate_formation(formation, *, now=None):
    """Validate supplied configuration, without authenticating its provenance."""
    load_pinned_manifest()
    _object(formation, ("run_id", "manifest_digest", "expires_at_unix", "endpoints", "bootstrap_peers"), "formation")
    if not isinstance(formation["run_id"], str) or re.fullmatch(r"factory-[a-z0-9][a-z0-9-]{2,55}", formation["run_id"]) is None:
        raise ValueError("Explicit run-owned factory- name required")
    if formation["manifest_digest"] != MANIFEST_DIGEST:
        raise ValueError("Formation must use the fixed protocol manifest digest")
    now = _number(time.time() if now is None else now, "clock")
    expires = _number(formation["expires_at_unix"], "formation expiry")
    if not now < expires <= now + 21600:
        raise ValueError("Formation observation is expired or exceeds the bounded launch window")
    _object(formation["endpoints"], ROLES, "endpoint roles")
    endpoints = {}
    public_sockets, local_sockets = set(), set()
    for role in ROLES:
        item = _object(formation["endpoints"][role],
                       ("resource_id", "ipv4", "public_port", "listen_port", "transport", "application_tls"), "endpoint")
        if item["transport"] != "modal-raw-tcp" or item["application_tls"] is not True:
            raise ValueError("Actual raw TCP tunnel carrying peer application TLS required")
        resource = item["resource_id"]
        if not isinstance(resource, str) or RESOURCE_RE.fullmatch(resource) is None:
            raise ValueError("Recorded Modal Sandbox resource ID required")
        try:
            ip = ipaddress.IPv4Address(item["ipv4"])
        except (ValueError, TypeError) as exc:
            raise ValueError("Observed global IPv4 tunnel address required") from exc
        if str(ip) != item["ipv4"] or not ip.is_global:
            raise ValueError("Observed global IPv4 tunnel address required")
        public_port, listen_port = _port(item["public_port"]), _port(item["listen_port"])
        public_socket, local_socket = (str(ip), public_port), (resource, listen_port)
        if public_socket in public_sockets or local_socket in local_sockets:
            raise ValueError("Roles must have distinct public and local sockets")
        public_sockets.add(public_socket)
        local_sockets.add(local_socket)
        endpoints[role] = dict(item)
    if endpoints["worker_0"]["resource_id"] == endpoints["worker_1"]["resource_id"]:
        raise ValueError("The two block workers must be separate Modal resources")
    peers = formation["bootstrap_peers"]
    if type(peers) is not list or not 1 <= len(peers) <= 4 or len(set(peers)) != len(peers):
        raise ValueError("Observed bootstrap multiaddrs required")
    seed = endpoints["bootstrap"]
    for peer in peers:
        match = PEER_RE.fullmatch(peer) if isinstance(peer, str) else None
        if match is None or match[1] != seed["ipv4"] or int(match[2]) != seed["public_port"]:
            raise ValueError("Bootstrap peer must match the actual bootstrap public tunnel")
    # Return a snapshot so mutation of caller dictionaries cannot retarget a plan.
    return {**formation, "endpoints": endpoints, "bootstrap_peers": list(peers)}


def _addresses(endpoint):
    return ["--host_maddrs", f'/ip4/0.0.0.0/tcp/{endpoint["listen_port"]}',
            "--announce_maddrs", f'/ip4/{endpoint["ipv4"]}/tcp/{endpoint["public_port"]}']


def build_launch_plan(formation, *, now=None):
    """Return launch configuration only. No process, cloud call, or success claim."""
    formation = validate_formation(formation, now=now)
    peers = formation["bootstrap_peers"]
    workers = []
    for role, span in (("worker_0", "0:14"), ("worker_1", "14:28")):
        endpoint = formation["endpoints"][role]
        argv = ["python", "-m", "drift.cli", "server", MODEL, "--model_manifest", RUNTIME_MANIFEST,
                "--block_indices", span, "--device", "cuda", "--torch_dtype", "bfloat16",
                "--attn_implementation", "eager", "--cache_dir", f"/models/{REVISION}",
                "--identity_path", f"/run/communityai/{role}.key", "--health_state_path", f"/run/communityai/{role}.json",
                "--throughput", "0.01", "--num_handlers", "1", "--inference_max_length", "2048",
                "--attn_cache_tokens", "2048", "--max_batch_size", "2048", "--update_period", "10",
                "--expiration", "40", "--request_timeout", "180", "--session_timeout", "180",
                "--step_timeout", "180", "--ready_timeout", "180", "--no_auto_relay",
                *_addresses(endpoint), "--initial_peers", *peers]
        workers.append({"role": role, "resource_id": endpoint["resource_id"], "block_indices": span, "argv": argv})
    text = formation["endpoints"]["text_peer"]
    text_argv = ["python", "-m", "drift.cli", "text-peer", RUNTIME_MANIFEST,
                 "--identity_path", "/run/communityai/text-peer.key", "--cache_dir", f"/models/{REVISION}",
                 "--max_context_tokens", "2048", "--max_output_tokens", "64",
                 *_addresses(text), "--initial_peers", *peers]
    return {"schema_version": 1, "run_id": formation["run_id"], "manifest_digest": MANIFEST_DIGEST,
            "manifest_raw_sha256": MANIFEST_RAW_SHA256, "model_revision": REVISION,
            "status": "not_started", "admission": "NO_ADMISSION", "formation_provenance": "not_authenticated",
            "workers": workers, "text_peer": {"resource_id": text["resource_id"], "argv": text_argv},
            "coordinator": {"factory": "communityai_bootstrap:create_coordinator_app",
                            "initial_peers": peers, "request_timeout_seconds": 180,
                            "requires": ["trusted Original admission callback", "trusted API credential identifier"]},
            "bootstrap": {"requires": "Supervisor-owned TLS DHT and observed visible multiaddrs",
                          "host_maddrs": [f'/ip4/0.0.0.0/tcp/{formation["endpoints"]["bootstrap"]["listen_port"]}'],
                          "announce_maddrs": [f'/ip4/{formation["endpoints"]["bootstrap"]["ipv4"]}/tcp/{formation["endpoints"]["bootstrap"]["public_port"]}'],
                          "transport": "modal-raw-tcp", "tls": True},
            "environment": {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"}}


def create_coordinator_app(formation, *, factory_admission, api_key_identifier):
    """Compose the real artifact-free Factory API; the host owns admission.

    Configuration strings and callbacks are not evidence of their authority.
    CommunityAI itself invokes admission before loading/dispatch and requires the
    exact distributed text runtime. Calls with no adapters fail before imports.
    No text-peer generation engine is loaded in this coordinator process.
    """
    if any(not callable(adapter) or inspect.iscoroutinefunction(adapter)
           or inspect.iscoroutinefunction(getattr(adapter, "__call__", None))
           for adapter in (factory_admission, api_key_identifier)):
        raise ValueError("Trusted synchronous host admission and credential adapters required")
    formation = validate_formation(formation)
    from drift.api.server import create_factory_app
    from drift.model_manifest import ModelManifest
    from drift.node.discovery import CoverageTarget, ModelCoverageDiscovery
    from drift.node.loading import make_text_peer_loader
    from drift.node.model_manager import ModelDescriptor, ModelManager
    import drift

    manifest = ModelManifest.load(MANIFEST_PATH)
    manifest.validate_runtime(drift.__version__)
    if manifest.digest_id != MANIFEST_DIGEST:
        raise ValueError("Installed runtime disagrees with the fixed manifest identity")
    peers = tuple(formation["bootstrap_peers"])
    discovery = ModelCoverageDiscovery([CoverageTarget(manifest, peers)], discover_text=True,
                                       update_period=10, startup_timeout=15)
    manager = ModelManager()
    try:
        manager.add_shutdown_callback(discovery.close)
        manager.register(ModelDescriptor(MANIFEST_DIGEST, manifest_digest=MANIFEST_DIGEST,
                                         repository=MODEL, name=manifest.name, execution="distributed"),
                         make_text_peer_loader(manifest, initial_peers=peers, request_timeout=180),
                         route_health=discovery.observer(MANIFEST_DIGEST))
        app = create_factory_app(model_manager=manager, factory_admission=factory_admission,
                                 api_key_identifier=api_key_identifier, max_concurrent=1,
                                 default_max_tokens=64, request_timeout=180)
    except BaseException:
        # No admission/HTTP start occurred. Close both owned components even if
        # construction failed after registration; manager owns any lazy runtime.
        try:
            manager.shutdown()
        finally:
            discovery.close()
        raise
    lifecycle = {"startup": "not_started", "startup_error": None, "runtime_error": None,
                 "shutdown": "not_requested", "shutdown_errors": []}
    app.state.factory_communityai_lifecycle = lifecycle
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        try:
            # Re-check expiry before transport startup, not just at construction.
            validate_formation(formation)
            async with original_lifespan(instance):
                lifecycle["startup"] = "starting_discovery"
                await asyncio.to_thread(discovery.start)
                lifecycle["startup"] = "discovery_started_readiness_unverified"
                yield
        except BaseException as exc:
            field = "runtime_error" if lifecycle["startup"] == "discovery_started_readiness_unverified" else "startup_error"
            lifecycle[field] = type(exc).__name__
            raise
        finally:
            lifecycle["shutdown"] = "close_requested"
            for closer in (manager.shutdown, discovery.close):
                try:
                    await asyncio.to_thread(closer)
                except BaseException as exc:
                    lifecycle["shutdown_errors"].append(type(exc).__name__)
            # Upstream close routines are best-effort. This records return,
            # not peer/container retirement or complete descendant closure.
            lifecycle["shutdown"] = ("close_failed" if lifecycle["shutdown_errors"]
                                      else "close_returned_retirement_unverified")
            if lifecycle["shutdown_errors"]:
                raise RuntimeError("CommunityAI coordinator cleanup failed")

    app.router.lifespan_context = lifespan
    return app
