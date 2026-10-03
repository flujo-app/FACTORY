"""Validate pinned Hub HTTP continuations before the SDK can append a body."""

from contextvars import ContextVar
from functools import wraps
import hashlib
import inspect
from pathlib import Path
import re


PROTOCOL = "http-range-v1"
_CURRENT_DOWNLOAD = ContextVar("factory_hub_http_download", default=None)


class HttpResumeError(RuntimeError):
    def __init__(self):
        super().__init__("HTTP continuation differs from the admitted byte range")


def guard_identity():
    return {"schemaVersion": 1, "protocol": PROTOCOL,
            "guardSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def require_identity(value):
    expected = guard_identity()
    if (not isinstance(value, dict) or set(value) != set(expected)
            or any(type(value[key]) is not type(item) or value[key] != item
                   for key, item in expected.items())):
        raise HttpResumeError()
    return expected


def install_http_resume_guard(expected_identity):
    """Use the SDK's real size/retry context and its supported Requests backend."""
    identity = require_identity(expected_identity)
    import requests
    from huggingface_hub import configure_http_backend, file_download
    from huggingface_hub.utils import _http

    original_http_get = file_download.http_get
    original_backend = _http._GLOBAL_BACKEND_FACTORY
    signature = inspect.signature(original_http_get)
    if not {"url", "temp_file", "resume_size", "expected_size"}.issubset(signature.parameters):
        raise HttpResumeError()
    observations = {"validatedResponses": 0}

    def response_guard(response, *args, **kwargs):
        context = _CURRENT_DOWNLOAD.get()
        # Redirects and HTTP errors have no body that the SDK may append. The
        # final request is checked, including whether a redirect lost Range.
        if response.is_redirect or response.status_code >= 400:
            return response
        requested = response.request.headers.get("Range")
        if context is None:
            if response.request.method == "GET" and requested is not None:
                response.close()
                raise HttpResumeError()
            return response
        offset, total = context
        if offset == 0:
            return response
        match = re.fullmatch(r"bytes=([0-9]{1,20})-", requested or "")
        actual = re.fullmatch(r"bytes ([0-9]{1,20})-([0-9]{1,20})/([0-9]{1,20})", response.headers.get("Content-Range", ""))
        length = response.headers.get("Content-Length")
        valid = (response.request.method == "GET" and response.status_code == 206
                 and match is not None and int(match.group(1)) == offset
                 and actual is not None and tuple(map(int, actual.groups())) == (offset, total - 1, total)
                 and response.headers.get("Content-Encoding", "identity").lower() == "identity"
                 and (length is None or (re.fullmatch(r"[0-9]{1,20}", length) is not None and int(length) == total - offset)))
        if not valid:
            response.close()
            raise HttpResumeError()
        observations["validatedResponses"] += 1
        return response

    @wraps(original_http_get)
    def guarded_http_get(*args, **kwargs):
        arguments = signature.bind(*args, **kwargs)
        arguments.apply_defaults()
        offset, total = arguments.arguments["resume_size"], arguments.arguments["expected_size"]
        if (type(offset) is not int or offset < 0
                or (offset > 0 and (type(total) is not int or total <= 0 or offset > total))):
            raise HttpResumeError()
        token = _CURRENT_DOWNLOAD.set((offset, total))
        try:
            return original_http_get(*args, **kwargs)
        finally:
            _CURRENT_DOWNLOAD.reset(token)

    def session_factory():
        session = requests.Session()
        session.trust_env = False
        session.headers["Accept-Encoding"] = "identity"
        session.hooks["response"].append(response_guard)
        return session

    class Guard:
        closed = False

        def receipt(self):
            return {**identity, **observations}

        def close(self):
            if self.closed:
                return
            if file_download.http_get is not guarded_http_get:
                raise HttpResumeError()
            file_download.http_get = original_http_get
            configure_http_backend(backend_factory=original_backend)
            self.closed = True

    # Native recursive http_get retries look up this wrapper again and set a
    # fresh offset; ContextVar also separates the SDK's file-worker threads.
    file_download.http_get = guarded_http_get
    try:
        configure_http_backend(backend_factory=session_factory)
    except BaseException:
        file_download.http_get = original_http_get
        raise
    return Guard()
