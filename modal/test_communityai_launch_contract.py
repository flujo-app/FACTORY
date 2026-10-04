"""Owned exact index metadata + CPU configuration checks; no model/provider use."""

import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import unittest

import communityai_bootstrap as bootstrap
import communityai_launch_contract as contract
from test_communityai_bootstrap import formation


INDEX_FIXTURE = Path(__file__).with_name("fixtures") / "communityai-qwen3-model-index.json"
INDEX_BYTES = INDEX_FIXTURE.read_bytes()


class LaunchContractTests(unittest.TestCase):
    def plan(self):
        return bootstrap.build_launch_plan(formation(), index_bytes=INDEX_BYTES, now=1000)

    def test_actual_retained_index_metadata_derives_both_fixed_placements(self):
        self.assertEqual(len(INDEX_BYTES), 25605)
        self.assertEqual(hashlib.sha256(INDEX_BYTES).hexdigest(), contract.INDEX_SHA256)
        plans = contract.derive_worker_placements(INDEX_BYTES, manifest=bootstrap.load_pinned_manifest())
        self.assertEqual([plan["block_indices"] for plan in plans], ["0:14", "14:28"])
        for plan in plans:
            self.assertEqual(plan["artifact_bytes"], 3441211939)
            self.assertEqual(plan["artifact_set_digest"], "246ee947e886edf6f9a288a17e2699bdfa44b7fc90fd3144ebe35beafdefe060")
            self.assertEqual([item["path"] for item in plan["artifacts"]],
                             ["config.json", "model-00001-of-00002.safetensors", "model.safetensors.index.json"])

    def test_main_plan_requires_exact_index_bytes_without_default_or_fixture_fallback(self):
        with self.assertRaises(TypeError):
            bootstrap.build_launch_plan(formation(), now=1000)
        for raw in (None, b"", INDEX_BYTES + b"\n", b" " + INDEX_BYTES[1:]):
            with self.subTest(raw_type=type(raw)), self.assertRaisesRegex(ValueError, "Exact retained"):
                bootstrap.build_launch_plan(formation(), index_bytes=raw, now=1000)

    def test_workers_have_all_five_claims_and_the_same_explicit_owned_scratch_root(self):
        plan = self.plan()
        for worker, span in zip(plan["workers"], ("0:14", "14:28")):
            args = worker["argv"]
            values = [bootstrap.MANIFEST_DIGEST, span, "3441211939", contract.EXPECTED_ARTIFACT_SET_DIGEST,
                      f'/run/communityai/{plan["run_id"]}/cache/{worker["role"]}']
            for flag, expected in zip(contract.CLAIM_FLAGS, values):
                self.assertEqual(args.count(flag), 1)
                self.assertEqual(args[args.index(flag) + 1], expected)
            self.assertEqual(args[args.index("--block_indices") + 1], span)
            self.assertEqual(args[args.index("--cache_dir") + 1], values[-1])
            self.assertEqual(args[args.index("--artifact_root") + 1], contract.ARTIFACT_ROOT)
            self.assertNotIn("--num_blocks", args)
            self.assertNotIn("--config", args)
            self.assertNotIn("--token", args)
            self.assertFalse(any(arg.startswith("DRIFT_INTERNAL_LOADING_") for arg in args))

    def test_snapshot_is_complete_plain_manifest_layout_and_cache_paths_are_lexically_disjoint(self):
        plan = self.plan()
        snapshot = plan["artifact_snapshot"]
        self.assertEqual(snapshot["root"], contract.ARTIFACT_ROOT)
        self.assertTrue(snapshot["read_only"])
        self.assertTrue(snapshot["exact_declared_files_only"])
        self.assertTrue(snapshot["regular_single_link_files_required"])
        self.assertEqual(snapshot["files"], bootstrap.load_pinned_manifest()["artifacts"])
        self.assertEqual(len(snapshot["files"]), 8)
        roots = [item["cache_root"] for item in plan["workers"]] + [plan["text_peer"]["cache_root"]]
        self.assertEqual(len(set(roots)), 3)
        for root in roots:
            path = PurePosixPath(root)
            self.assertTrue(path.is_absolute())
            self.assertEqual(path.as_posix(), root)
            self.assertFalse(path.is_relative_to(PurePosixPath(snapshot["root"])))
            self.assertFalse(PurePosixPath(snapshot["root"]).is_relative_to(path))
        text = plan["text_peer"]["argv"]
        self.assertEqual(text[text.index("--cache_dir") + 1], roots[-1])
        self.assertEqual(text[text.index("--artifact_root") + 1], snapshot["root"])
        self.assertFalse(any(flag in text for flag in contract.CLAIM_FLAGS))

    def test_index_content_match_never_qualifies_volume_transport_runtime_or_admission(self):
        plan = self.plan()
        self.assertEqual(plan["status"], "model_runtime_held")
        self.assertFalse(plan["model_exec_allowed"])
        self.assertEqual(plan["admission"], "NO_ADMISSION")
        self.assertEqual(plan["formation_provenance"], "not_authenticated")
        self.assertTrue(plan["index_content"]["verified_bytes_only"])
        self.assertEqual(plan["artifact_snapshot"]["owner_verification"], "required_not_performed")
        self.assertEqual(plan["scratch_cache"]["actual_canonical_paths_and_ownership"], "required_not_verified")
        self.assertEqual(plan["runtime_interface"]["required_source_commit"],
                         "681deb528a2d83a354a991a032c6ffa8d14a4242")
        self.assertFalse(plan["runtime_interface"]["runtime_instance_qualified"])
        self.assertFalse(plan["runtime_interface"]["image_qualified"])
        self.assertEqual(plan["runtime_interface"]["managed_node_propagation"], "not_qualified")

    def test_fixture_metadata_missing_block_or_foreign_shard_is_rejected(self):
        manifest = bootstrap.load_pinned_manifest()
        weight_map = json.loads(INDEX_BYTES)["weight_map"]
        missing = {name: shard for name, shard in weight_map.items() if not name.startswith("model.layers.0.")}
        with self.assertRaisesRegex(ValueError, "omits blocks"):
            contract._block_plan(manifest, missing, 0, 14)
        for bad_shard in ("../foreign.safetensors", "./model-00001-of-00002.safetensors", "config.json", "undeclared.safetensors"):
            fixture_map = copy.deepcopy(weight_map)
            fixture_map["outside_this_span.weight"] = bad_shard
            with self.subTest(bad_shard=bad_shard), self.assertRaises(ValueError):
                contract._block_plan(manifest, fixture_map, 0, 14)


if __name__ == "__main__":
    unittest.main()
