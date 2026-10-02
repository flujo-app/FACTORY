"""Offline ASGI and admission tests. No weights, Modal calls or GPU required."""

import asyncio
import json
import unittest

import factory_policy as policy


def request(**changes):
    return {"model": "factory-coder", "messages": [{"role": "user", "content": "private prompt"}], **changes}


async def invoke(app, value=None, path="/v1/chat/completions", method="POST", chunks=None):
    body = json.dumps(value).encode() if chunks is None else b""
    events = list(chunks or [{"type": "http.request", "body": body}])
    output = []

    async def receive():
        if events:
            return events.pop(0)
        return {"type": "http.disconnect"}

    async def send(event):
        output.append(event)

    await policy.FactoryPolicyMiddleware(app)(
        {"type": "http", "method": method, "path": path, "headers": [(b"content-length", str(len(body)).encode())]},
        receive, send)
    return output


class AdmissionTests(unittest.TestCase):
    def test_default_and_completion_alias_caps(self):
        self.assertEqual(policy.normalize_request(request())["max_tokens"], 1024)
        self.assertEqual(policy.normalize_request(request(max_completion_tokens=24))["max_tokens"], 24)

    def test_rejects_fanout_tokens_tools_and_media(self):
        for patch in ({"n": 2}, {"best_of": 2}, {"max_tokens": 1025}, {"max_tokens": True},
                      {"tools": []}, {"use_beam_search": True}, {"stream": "true"},
                      {"messages": [{"role": "user", "content": [{"type": "image_url"}]}]},
                      {"messages": [{"role": "tool", "content": "tool output"}]},
                      {"messages": []}, {"model": "another-model"}):
            with self.subTest(patch=patch), self.assertRaises(policy.PolicyRejected):
                policy.normalize_request(request(**patch))

    def test_compatible_cache_hints_and_stream_are_not_retried(self):
        value = policy.normalize_request(request(stream=True, prompt_cache_key="private", prompt_cache_options={}))
        self.assertTrue(value["stream"])
        self.assertNotIn("prompt_cache_key", value)
        self.assertNotIn("prompt_cache_options", value)

    def test_missing_policy_error_has_no_private_payload(self):
        try:
            policy.normalize_request(request(model="private-api-token"))
        except policy.PolicyRejected as error:
            self.assertNotIn("private", str(error))


class MiddlewareTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_body_is_cancelled_before_engine_dispatch(self):
        dispatched = []
        cancelled = []
        output = []

        async def receive():
            try:
                await asyncio.sleep(1)
            finally:
                cancelled.append(True)

        async def downstream(*args):
            dispatched.append(True)

        async def send(event):
            output.append(event)

        original = policy.CONFIG["requestTimeoutSeconds"]
        policy.CONFIG["requestTimeoutSeconds"] = 0.01
        try:
            await policy.FactoryPolicyMiddleware(downstream)(
                {"type": "http", "method": "POST", "path": "/v1/chat/completions", "headers": []}, receive, send)
        finally:
            policy.CONFIG["requestTimeoutSeconds"] = original
        self.assertEqual(output[0]["status"], 504)
        self.assertEqual(dispatched, [])
        self.assertEqual(cancelled, [True])

    async def test_normalizes_body_and_content_length_once(self):
        calls = []

        async def downstream(scope, receive, send):
            event = await receive()
            calls.append(json.loads(event["body"]))
            self.assertEqual(dict(scope["headers"])[b"content-length"], str(len(event["body"])).encode())
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b'{"choices": []}'})

        output = await invoke(downstream, request(max_completion_tokens=15))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["max_tokens"], 15)
        self.assertEqual(output[0]["status"], 200)

    async def test_rejects_payload_before_engine_dispatch(self):
        calls = []

        async def downstream(*args):
            calls.append(True)

        output = await invoke(downstream, chunks=[{"type": "http.request", "body": b"x" * 65537}])
        self.assertEqual(calls, [])
        self.assertEqual(output[0]["status"], 413)
        output = await invoke(downstream, request(n=9))
        self.assertEqual(calls, [])
        self.assertEqual(output[0]["status"], 400)

    async def test_error_body_and_unused_route_are_private(self):
        async def downstream(scope, receive, send):
            await send({"type": "http.response.start", "status": 500, "headers": []})
            await send({"type": "http.response.body", "body": b"private-api-token private prompt", "more_body": True})
            await send({"type": "http.response.body", "body": b"private prompt", "more_body": False})

        output = await invoke(downstream, request())
        self.assertEqual(output[0]["status"], 500)
        self.assertEqual(len(output), 2)
        self.assertNotIn("private", repr(output))
        output = await invoke(downstream, path="/metrics", method="GET")
        self.assertEqual(output[0]["status"], 404)

    async def test_streaming_success_is_preserved(self):
        async def downstream(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
            await send({"type": "http.response.body", "body": b"data: answer\n\n", "more_body": True})
            await send({"type": "http.response.body", "body": b"data: [DONE]\n\n", "more_body": False})

        output = await invoke(downstream, request(stream=True))
        self.assertEqual(output[1]["body"], b"data: answer\n\n")
        self.assertTrue(output[1]["more_body"])
        self.assertFalse(output[2]["more_body"])

    async def test_handler_timeout_cancels_downstream_and_does_not_retry(self):
        cancelled = []

        async def downstream(*args):
            try:
                await asyncio.sleep(1)
            finally:
                cancelled.append(True)

        original = policy.CONFIG["requestTimeoutSeconds"]
        policy.CONFIG["requestTimeoutSeconds"] = 0.01
        try:
            output = await invoke(downstream, request())
        finally:
            policy.CONFIG["requestTimeoutSeconds"] = original
        self.assertEqual(output[0]["status"], 504)
        self.assertEqual(cancelled, [True])


if __name__ == "__main__":
    unittest.main()
