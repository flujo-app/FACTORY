"""Capture one mounted CommunityAI v2 ASGI observation without a physical send.

Run inside the pinned offline runtime with this FACTORY checkout at /factory and
CommunityAI e8f85285a974c64d5276054817dadbb0dd31c6f9 at /communityai.
The CommunityAI test host's dispatch claim refuses before post-claim peer work.
"""

import asyncio
import hashlib
import json
from pathlib import Path

from fastapi import FastAPI

import drift.api.server as server_module
import drift.factory_admission as admission_module
import drift.factory_receiver as receiver_module
import test_factory_receiver_v2 as receiver_test
import test_factory_sdk_asgi_hold as sdk_test


SOURCE_COMMIT = "e8f85285a974c64d5276054817dadbb0dd31c6f9"
COMMUNITYAI_ROOT = Path("/communityai")
SOURCES = {
    "src/drift/api/server.py": server_module.__file__,
    "src/drift/factory_admission.py": admission_module.__file__,
    "src/drift/factory_receiver.py": receiver_module.__file__,
    "tests/test_factory_receiver_v2.py": receiver_test.__file__,
    "tests/test_factory_sdk_asgi_hold.py": sdk_test.__file__,
}


async def capture():
    case = receiver_test.FactoryReceiverV2Tests(
        methodName="test_parent_mount_preserves_exact_route_admission"
    )
    await case.asyncSetUp()
    try:
        parent = FastAPI()
        parent.mount("/factory", case.app())
        response = await case.post(app=parent, path="/factory/v1/chat/completions")
        assert response.status_code == 200
        assert '"code": "request_not_dispatched"' in response.text
        assert case.events == ["transport", "original", "bearer"]
        assert case.claims == 1 and case.peer.after_claim == 0
        assert len(case.observations) == 1
        observed = case.observations[0]
        assert observed.raw_body == sdk_test.FLOW_SDK_BODY_UTF8
        assert observed.headers == receiver_test.EXPECTED_HEADERS
        assert observed.normalized_body_sha256 == sdk_test.FLOW_NORMALIZED_SHA256
        projection = {
            "format": observed.format,
            "schemaVersion": observed.schema_version,
            "method": observed.method,
            "route": observed.route,
            "headers": [list(pair) for pair in observed.headers],
            "rawBodyByteLength": len(observed.raw_body),
            "rawBodySha256": observed.raw_body_sha256,
            "normalizedBodySha256": observed.normalized_body_sha256,
            "observationSha256": observed.digest(),
        }
        source_hashes = {}
        for name, path in SOURCES.items():
            source = Path(path).resolve()
            assert source == (COMMUNITYAI_ROOT / name).resolve()
            source_hashes[name] = hashlib.sha256(source.read_bytes()).hexdigest()
        return {
            "format": "factory-communityai-v2-asgi-observation-fixture",
            "schemaVersion": 1,
            "sourceCommit": SOURCE_COMMIT,
            "sourceSha256": source_hashes,
            "entry": "parent-mounted-create_factory_receiver_app_v2",
            "requestPath": "/factory/v1/chat/completions",
            "responseStatus": response.status_code,
            "hostCallbacks": case.events,
            "dispatchClaimAttempts": case.claims,
            "peerAfterClaim": case.peer.after_claim,
            "observation": projection,
            "runtimeAdmission": "HOLD",
        }
    finally:
        await case.asyncTearDown()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(capture()), ensure_ascii=False, sort_keys=True, indent=2))
