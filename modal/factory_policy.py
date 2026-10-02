"""Small text-only admission policy; no Modal/vLLM imports or request logging."""

import asyncio
import json
from pathlib import Path

CONFIG = json.loads(Path(__file__).with_name("config.json").read_text(encoding="utf-8"))


class PolicyRejected(ValueError):
    def __init__(self):
        super().__init__("Request rejected by factory endpoint policy.")


def normalize_request(value):
    """Bound cost-sensitive fields before handing a request to the actual engine."""
    if not isinstance(value, dict) or value.get("model") != CONFIG["servedModel"]:
        raise PolicyRejected()
    messages = value.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= CONFIG["maxMessages"]:
        raise PolicyRejected()
    for message in messages:
        if not isinstance(message, dict):
            raise PolicyRejected()
        if message.get("role") not in ("system", "user", "assistant"):
            raise PolicyRejected()
        if not isinstance(message.get("content"), str):
            raise PolicyRejected()
        if any(key in message for key in ("tool_calls", "function_call", "tool_call_id")):
            raise PolicyRejected()
    for key in ("tools", "tool_choice", "functions", "function_call", "modalities", "audio"):
        if key in value:
            raise PolicyRejected()
    for key in ("n", "best_of"):
        if key in value and (type(value[key]) is not int or value[key] != 1):
            raise PolicyRejected()
    if value.get("use_beam_search", False) is not False:
        raise PolicyRejected()
    if "stream" in value and type(value["stream"]) is not bool:
        raise PolicyRejected()
    cap = CONFIG["maxOutputTokens"]
    for key in ("max_tokens", "max_completion_tokens", "min_tokens"):
        if key in value and (type(value[key]) is not int or not 1 <= value[key] <= cap):
            raise PolicyRejected()
    if "max_tokens" in value and "max_completion_tokens" in value:
        raise PolicyRejected()
    result = dict(value)
    result["max_tokens"] = result.pop("max_completion_tokens", result.get("max_tokens", cap))
    result["n"] = 1
    # FLUJO's OpenAI adapter can send automatic prompt-cache hints; this engine
    # does not need them, and ignoring these hints does not repeat generation.
    result.pop("prompt_cache_key", None)
    result.pop("prompt_cache_options", None)
    return result


async def _error(send, status=400):
    body = json.dumps({"error": {"message": "Factory endpoint request failed.",
                                 "type": "invalid_request_error" if status < 500 else "server_error",
                                 "code": "factory_endpoint_policy"}}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class FactoryPolicyMiddleware:
    """ASGI middleware loaded by vLLM's documented --middleware option.

    Modal authenticates every URL before this container is reached. This policy
    blocks unused routes, bounds admission and replaces engine error bodies.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                await self.app(scope, receive, send)
            return
        route = (scope.get("method"), scope.get("path"))
        if route not in (("POST", "/v1/chat/completions"), ("GET", "/v1/models"), ("GET", "/health")):
            await _error(send, 404)
            return
        deadline = asyncio.get_running_loop().time() + CONFIG["requestTimeoutSeconds"]
        if route[0] == "POST":
            body = bytearray()
            try:
                async with asyncio.timeout_at(deadline):
                    while True:
                        event = await receive()
                        if event["type"] == "http.disconnect":
                            return
                        body.extend(event.get("body", b""))
                        if len(body) > CONFIG["maxRequestBytes"]:
                            await _error(send, 413)
                            return
                        if not event.get("more_body", False):
                            break
            except TimeoutError:
                await _error(send, 504)
                return
            try:
                body = json.dumps(normalize_request(json.loads(body))).encode()
            except (PolicyRejected, ValueError, UnicodeError):
                await _error(send)
                return
            headers = [(key, val) for key, val in scope.get("headers", [])
                       if key.lower() not in (b"content-length", b"transfer-encoding")]
            scope = dict(scope, headers=headers + [(b"content-length", str(len(body)).encode())])
            delivered = False

            async def normalized_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            actual_receive = normalized_receive
        else:
            actual_receive = receive
        error_status = None
        response_started = False
        error_sent = False

        async def sanitized_send(event):
            nonlocal error_status, response_started, error_sent
            if event["type"] == "http.response.start":
                if event["status"] >= 400:
                    error_status = event["status"]
                    return
                response_started = True
            if error_status is not None:
                if event["type"] == "http.response.body" and not error_sent:
                    error_sent = True
                    await _error(send, error_status)
                return
            await send(event)

        try:
            async with asyncio.timeout_at(deadline):
                await self.app(scope, actual_receive, sanitized_send)
        except Exception:
            # No raw exception/prompt/token enters logs or an error receipt.
            if not response_started and not error_sent:
                await _error(send, 504)
            else:
                raise PolicyRejected() from None
