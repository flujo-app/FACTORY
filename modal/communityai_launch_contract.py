"""Held fixed-model launch configuration; no SDK, provider or model actions.

Index content proves only deterministic placement metadata. It does not prove
an artifact Volume, raw tunnel provenance, runtime/image readiness or admission.
The resource driver still refuses all worker/text exec and the four-role batch.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import PurePosixPath

INDEX_SHA256 = "0d660e94b165eb912669a5249dff44b83188c4777a07ddb9611fb78d91b0578d"
INDEX_SIZE = 25605
EXPECTED_ARTIFACT_BYTES = 3441211939
EXPECTED_ARTIFACT_SET_DIGEST = "246ee947e886edf6f9a288a17e2699bdfa44b7fc90fd3144ebe35beafdefe060"
ARTIFACT_ROOT = "/models/snapshots/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e"
CLAIM_FLAGS = ("--expected_manifest_digest", "--expected_block_indices",
               "--expected_artifact_bytes", "--expected_artifact_set_digest",
               "--expected_cache_root")
CLAIM_PARSER_SOURCE = "2d08f31aa58c2c7b49304d0367ab51ae9aaccb11"
REQUIRED_RUNTIME_SOURCE = "681deb528a2d83a354a991a032c6ffa8d14a4242"


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _index_document(raw):
    if type(raw) is not bytes or len(raw) != INDEX_SIZE or hashlib.sha256(raw).hexdigest() != INDEX_SHA256:
        raise ValueError("Exact retained manifested checkpoint index bytes required")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate checkpoint index key")
            result[key] = value
        return result

    def non_finite(_):
        raise ValueError("Non-finite checkpoint index number")

    document = json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=non_finite)
    if type(document) is not dict or type(document.get("weight_map")) is not dict or not document["weight_map"]:
        raise ValueError("Non-empty manifested checkpoint weight_map required")
    return document["weight_map"]


def _block_plan(manifest, weight_map, start, end):
    """Fixed model.layers selection matching the pinned upstream selector.

    Every mapping entry is validated, including parameters outside this span.
    This metadata operation never opens a shard or verifies a model snapshot.
    """
    artifacts = {item["path"]: item for item in manifest["artifacts"]}
    selected = {path for path, item in artifacts.items() if item["role"] in {"config", "weight_index"}}
    if len([item for item in artifacts.values() if item["role"] == "weight_index"]) != 1:
        raise ValueError("One manifested checkpoint index required")
    prefixes = {f"model.layers.{block}." for block in range(start, end)}
    matched = set()
    for parameter, shard in weight_map.items():
        if type(parameter) is not str or not parameter or type(shard) is not str or not shard:
            raise ValueError("Invalid checkpoint index mapping")
        parsed = PurePosixPath(shard)
        if (parsed.is_absolute() or parsed == PurePosixPath(".") or "\\" in shard
                or ".." in parsed.parts or parsed.as_posix() != shard):
            raise ValueError("Non-normalized checkpoint shard path")
        if shard not in artifacts or artifacts[shard]["role"] not in {"weight", "converted_weight", "quantized_weight"}:
            raise ValueError("Checkpoint mapping must reference a declared weight artifact")
        for prefix in prefixes:
            if parameter.startswith(prefix):
                selected.add(shard)
                matched.add(prefix)
    if matched != prefixes:
        raise ValueError("Checkpoint index omits blocks from the fixed span")
    values = [artifacts[path] for path in sorted(selected)]
    if not any(item["role"] == "config" for item in values):
        raise ValueError("Manifested configuration artifact required")
    return {"block_indices": f"{start}:{end}", "artifacts": values,
            "artifact_bytes": sum(item["size"] for item in values),
            "artifact_set_digest": hashlib.sha256(_canonical(values)).hexdigest()}


def derive_worker_placements(index_bytes, *, manifest):
    """Require actual pinned index content before returning either exact claim."""
    index = next(item for item in manifest["artifacts"] if item["role"] == "weight_index")
    if index["sha256"] != INDEX_SHA256 or index["size"] != INDEX_SIZE:
        raise ValueError("Pinned manifest index identity changed")
    weight_map = _index_document(index_bytes)
    plans = [_block_plan(manifest, weight_map, start, end) for start, end in ((0, 14), (14, 28))]
    if any(plan["artifact_bytes"] != EXPECTED_ARTIFACT_BYTES
           or plan["artifact_set_digest"] != EXPECTED_ARTIFACT_SET_DIGEST for plan in plans):
        raise ValueError("Actual checkpoint placement differs from the reviewed fixed claims")
    return json.loads(_canonical(plans))


def _configure_role_arguments(plan, placements):
    """Pure argv composition; callers cannot use this as index/cache evidence."""
    scratch_parent = f'/run/communityai/{plan["run_id"]}/cache'
    for worker, placement in zip(plan["workers"], placements):
        cache = f'{scratch_parent}/{worker["role"]}'
        argv = worker["argv"]
        argv[argv.index("--cache_dir") + 1] = cache
        claims = [plan["manifest_digest"], placement["block_indices"], str(placement["artifact_bytes"]),
                  placement["artifact_set_digest"], cache]
        argv.extend(["--artifact_root", ARTIFACT_ROOT])
        for flag, value in zip(CLAIM_FLAGS, claims):
            argv.extend([flag, value])
        worker.update(placement=placement, cache_root=cache, artifact_root=ARTIFACT_ROOT)
    text_cache = f"{scratch_parent}/text_peer"
    text_argv = plan["text_peer"]["argv"]
    text_argv[text_argv.index("--cache_dir") + 1] = text_cache
    text_argv.extend(["--artifact_root", ARTIFACT_ROOT])
    plan["text_peer"].update(cache_root=text_cache, artifact_root=ARTIFACT_ROOT)
    return scratch_parent


def apply_snapshot_contract(plan, index_bytes, *, manifest):
    """Bind the main launch plan to exact index metadata; never execute it.

    The public --artifact_root interface requires the named reviewed Source
    and a qualified image. Source inspection does not qualify propagation
    through managed launchers, descendants, remote paths or runtime loaders.
    """
    placements = derive_worker_placements(index_bytes, manifest=manifest)
    index = next(item for item in manifest["artifacts"] if item["role"] == "weight_index")
    scratch_parent = _configure_role_arguments(plan, placements)
    plan.update(
        status="model_runtime_held", model_exec_allowed=False,
        index_content={"path": index["path"],
                       "size": INDEX_SIZE, "sha256": INDEX_SHA256, "verified_bytes_only": True},
        artifact_snapshot={"mount": "/models", "read_only": True, "root": ARTIFACT_ROOT,
                           "files": manifest["artifacts"], "exact_declared_files_only": True,
                           "regular_single_link_files_required": True, "owner_verification": "required_not_performed"},
        scratch_cache={"parent": scratch_parent, "writable": True,
                       "actual_canonical_paths_and_ownership": "required_not_verified"},
        runtime_interface={"claim_parser_source": CLAIM_PARSER_SOURCE,
                           "required_source_commit": REQUIRED_RUNTIME_SOURCE,
                           "artifact_root_cli": "required public worker/text --artifact_root",
                           "runtime_instance_qualified": False, "image_qualified": False,
                           "managed_node_propagation": "not_qualified"},
    )
    return json.loads(_canonical(plan))
