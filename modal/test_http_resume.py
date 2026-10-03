"""Tiny real-Hub/Requests loopback probes; no model, Modal, or public HTTP."""

import argparse
import base64
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
import unittest
from unittest.mock import patch


DATA = b"abcdefgh"
PREFIX = DATA[:3]
ALLOWED_PORTS = set()
OBSERVATIONS = []


def require_loopback(event, arguments):
    if event == "socket.connect":
        address = arguments[1]
        if not (isinstance(address, tuple) and len(address) == 2
                and address[0] == "127.0.0.1" and address[1] in ALLOWED_PORTS):
            raise RuntimeError("Only this probe's owned loopback listener is admitted")


def sha(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, case):
        self.case = case
        self.requests = []
        self.release_stall = threading.Event()
        super().__init__(("127.0.0.1", 0), FixtureHandler)


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *arguments):
        pass

    def do_GET(self):
        server = self.server
        server.requests.append({"path": self.path, "range": self.headers.get("Range")})
        case = server.case
        if self.path == "/retry" and self.headers.get("Range") is None:
            # A genuine streamed prefix, followed by an actual socket read
            # timeout. Requests raises ConnectionError; Hub recursively resumes.
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"3\r\n" + PREFIX + b"\r\n")
            self.wfile.flush()
            server.release_stall.wait(5)
            self.close_connection = True
            return
        if self.path in ("/redirect", "/retry"):
            server.release_stall.set()
            self.send_response(302)
            self.send_header("Location", "/final")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            return

        status, body = 206, DATA[3:]
        headers = {"Content-Range": "bytes 3-7/8", "Content-Length": "5"}
        if case in ("ignored-200", "initial-200", "retry-ignored-200", "redirect-missing-request-range"):
            status, body = 200, DATA
            headers = {"Content-Length": "8"}
        elif case == "wrong-start-206":
            body = DATA[2:7]
            headers["Content-Range"] = "bytes 2-6/8"
        elif case == "missing-content-range":
            del headers["Content-Range"]
        elif case == "malformed-content-range":
            headers["Content-Range"] = "bytes three-seven/eight"
        elif case == "wrong-total":
            headers["Content-Range"] = "bytes 3-7/9"
        elif case == "wrong-end":
            headers["Content-Range"] = "bytes 3-6/8"
        elif case == "encoded":
            headers["Content-Encoding"] = "gzip"
        elif case == "wrong-length":
            headers["Content-Length"] = "6"
        elif case == "missing-content-length":
            del headers["Content-Length"]
        elif case == "redirect-changed-request-range":
            body = DATA[2:]
            headers = {"Content-Range": "bytes 2-7/8", "Content-Length": "6"}
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # A guarded rejection can close the connection before this tiny
            # body is sent. The writer's bytes decide whether anything appended.
            pass
        self.close_connection = True


@contextmanager
def listener(case):
    server = FixtureServer(case)
    port = server.server_address[1]
    ALLOWED_PORTS.add(port)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        yield server, f"http://127.0.0.1:{port}"
    finally:
        server.release_stall.set()
        server.shutdown()
        server.server_close()
        thread.join(2)
        ALLOWED_PORTS.remove(port)
        if thread.is_alive():
            raise RuntimeError("Owned loopback listener did not close")


def source_tuple(arguments, file_download, http_backend, requests):
    helper = Path(arguments.helper_directory) / "http_resume.py"
    return {
        "probeSha256": sha(__file__),
        "guardSha256": sha(helper) if helper.is_file() else None,
        "hubVersion": importlib.metadata.version("huggingface-hub"),
        "fileDownloadSha256": sha(file_download.__file__),
        "httpBackendSha256": sha(http_backend.__file__),
        "requestsVersion": importlib.metadata.version("requests"),
        "requestsSessionsSha256": sha(requests.sessions.__file__),
        "requestsModelsSha256": sha(requests.models.__file__),
    }


class ResumeProbe(unittest.TestCase):
    def __init__(self, case, arguments, helper, file_download, http_backend, requests):
        super().__init__("runTest")
        self.case = case
        self.arguments = arguments
        self.helper = helper
        self.sdk = file_download
        self.backend = http_backend
        self.requests_library = requests

    def id(self):
        return f"http_resume.{self.arguments.mode}.{self.case}"

    def runTest(self):
        case, helper, sdk = self.case, self.helper, self.sdk
        original_get, original_backend = sdk.http_get, self.backend._GLOBAL_BACKEND_FACTORY
        if case.startswith("invalid-identity-"):
            expected = helper.guard_identity()
            expected = {**expected, **({"guardSha256": "0" * 64} if case.endswith("hash") else {"unexpected": True})}
            with self.assertRaises(helper.HttpResumeError):
                helper.install_http_resume_guard(expected)
            self.assertIs(sdk.http_get, original_get)
            self.assertIs(self.backend._GLOBAL_BACKEND_FACTORY, original_backend)
            OBSERVATIONS.append({"case": case, "rejectedBeforeHttp": True, "backendRestored": True})
            return

        initial = b"" if case.startswith("retry-") or case == "initial-200" else (
            DATA + b"x" if case == "oversized-partial" else DATA if case == "complete-partial" else PREFIX)
        filename = Path(self.arguments.output_directory) / f"{case}.incomplete"
        with filename.open("xb") as destination:
            destination.write(initial)
        guard, guard_receipt, caught, returned = None, None, None, False
        with listener(case) as (server, origin):
            try:
                if helper is not None:
                    expected = {"schemaVersion": 1, "protocol": "http-range-v1",
                                "guardSha256": sha(Path(self.arguments.helper_directory) / "http_resume.py")}
                    self.assertEqual(helper.guard_identity(), expected)
                    guard = helper.install_http_resume_guard(expected)
                redirect = case in ("valid-redirect", "redirect-missing-request-range", "redirect-changed-request-range")
                endpoint = "/retry" if case.startswith("retry-") else "/redirect" if redirect else "/body"
                original_rebuild = self.requests_library.sessions.Session.rebuild_method

                def rebuild(session, prepared, response):
                    original_rebuild(session, prepared, response)
                    if response.headers.get("Location") == "/final":
                        if case == "redirect-missing-request-range":
                            prepared.headers.pop("Range", None)
                        elif case == "redirect-changed-request-range":
                            prepared.headers["Range"] = "bytes=2-"

                # Only redirect header mutation and a bounded socket timeout
                # are fixture controls. Requests and Hub streaming/retry logic
                # execute unchanged, with real loopback socket responses.
                with patch.object(self.requests_library.sessions.Session, "rebuild_method", rebuild), \
                        patch.object(sdk.constants, "HF_HUB_DOWNLOAD_TIMEOUT", 0.25):
                    with filename.open("ab") as destination:
                        try:
                            sdk.http_get(origin + endpoint, destination, resume_size=destination.tell(),
                                         expected_size=len(DATA), displayed_filename="loopback-fixture")
                            returned = True
                        except Exception as error:
                            caught = error
                if guard is not None:
                    guard_receipt = guard.receipt()
            finally:
                if guard is not None:
                    guard.close()
                self.assertIs(sdk.http_get, original_get)
                self.assertIs(self.backend._GLOBAL_BACKEND_FACTORY, original_backend)
            actual = filename.read_bytes()
            observed = {"case": case, "initialBytes": len(initial), "actualBytes": len(actual),
                        "actualBase64": base64.b64encode(actual).decode("ascii"),
                        "sdkReturned": returned, "errorType": type(caught).__name__ if caught else None,
                        "requests": list(server.requests), "guardReceipt": guard_receipt, "backendRestored": True}
            OBSERVATIONS.append(observed)

            if self.arguments.mode == "baseline":
                if case == "ignored-200":
                    self.assertIsInstance(caught, OSError)
                    self.assertFalse(returned)
                    self.assertEqual(actual, PREFIX + DATA)
                else:
                    self.assertIsNone(caught)
                    self.assertTrue(returned)
                    self.assertEqual(actual, PREFIX + DATA[2:7])
                    self.assertEqual(len(actual), len(DATA))
                    self.assertNotEqual(actual, DATA)
                self.assertEqual(server.requests, [{"path": "/body", "range": "bytes=3-"}])
                return

            expected_receipt = {**helper.guard_identity(), "validatedResponses": guard_receipt["validatedResponses"]}
            self.assertEqual(guard_receipt, expected_receipt)
            self.assertIs(type(guard_receipt["validatedResponses"]), int)
            if case in ("valid-206", "missing-content-length", "valid-redirect", "retry-valid-redirect", "initial-200", "complete-partial"):
                self.assertIsNone(caught)
                self.assertTrue(returned)
                self.assertEqual(actual, DATA)
                self.assertEqual(guard_receipt["validatedResponses"], 0 if case in ("initial-200", "complete-partial") else 1)
            else:
                self.assertIsInstance(caught, helper.HttpResumeError)
                self.assertFalse(returned)
                self.assertEqual(actual, PREFIX if case == "retry-ignored-200" else initial)
                self.assertEqual(guard_receipt["validatedResponses"], 0)
            if case in ("complete-partial", "oversized-partial"):
                self.assertEqual(server.requests, [])
            elif case.startswith("retry-"):
                self.assertEqual(server.requests, [{"path": "/retry", "range": None},
                                                  {"path": "/retry", "range": "bytes=3-"},
                                                  {"path": "/final", "range": "bytes=3-"}])
            elif redirect:
                final_range = None if case == "redirect-missing-request-range" else (
                    "bytes=2-" if case == "redirect-changed-request-range" else "bytes=3-")
                self.assertEqual(server.requests, [{"path": "/redirect", "range": "bytes=3-"},
                                                  {"path": "/final", "range": final_range}])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("baseline", "candidate"), required=True)
    parser.add_argument("--owned-site", required=True)
    parser.add_argument("--helper-directory", required=True)
    parser.add_argument("--output-directory", required=True)
    arguments = parser.parse_args()
    assert sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
    owned_site = Path(arguments.owned_site).resolve()
    assert sys.path.count(str(owned_site)) == 1
    assert os.environ["HF_HUB_DISABLE_XET"] == "1" and os.environ["HF_HUB_ENABLE_HF_TRANSFER"] == "0"
    assert os.environ["HF_HUB_DISABLE_TELEMETRY"] == "1" and os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == "1"
    assert Path(os.environ["NETRC"]).read_bytes() == b"\n"
    sys.addaudithook(require_loopback)
    import huggingface_hub
    from huggingface_hub import file_download
    from huggingface_hub.utils import _http as http_backend
    from huggingface_hub.utils import disable_progress_bars
    import requests
    assert importlib.metadata.version("huggingface-hub") == "0.36.0"
    for module in (huggingface_hub, file_download, http_backend, requests, requests.sessions, requests.models):
        assert Path(module.__file__).resolve().is_relative_to(owned_site)
    # Keep even the unguarded baseline anonymous. Only transport logging is
    # muted: streamed socket errors and the native SDK retry still execute.
    def anonymous_session():
        session = requests.Session()
        session.trust_env = False
        session.headers["Accept-Encoding"] = "identity"
        return session
    huggingface_hub.configure_http_backend(backend_factory=anonymous_session)
    file_download.logger.disabled = True
    http_backend.logger.disabled = True
    disable_progress_bars()
    before = source_tuple(arguments, file_download, http_backend, requests)
    helper = None
    if arguments.mode == "candidate":
        specification = importlib.util.spec_from_file_location("factory_http_resume_probe", Path(arguments.helper_directory) / "http_resume.py")
        helper = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(helper)
    cases = ["ignored-200", "wrong-start-206"]
    if helper is not None:
        cases += ["missing-content-range", "malformed-content-range", "wrong-total", "wrong-end", "encoded", "wrong-length",
                  "valid-206", "missing-content-length", "valid-redirect", "redirect-missing-request-range",
                  "redirect-changed-request-range", "oversized-partial", "complete-partial", "initial-200",
                  "retry-valid-redirect", "retry-ignored-200", "invalid-identity-hash", "invalid-identity-extra"]
    suite = unittest.TestSuite(ResumeProbe(case, arguments, helper, file_download, http_backend, requests) for case in cases)
    diagnostics = io.StringIO()
    result = unittest.TextTestRunner(stream=diagnostics, verbosity=2).run(suite)
    sys.stderr.write(diagnostics.getvalue())
    after = source_tuple(arguments, file_download, http_backend, requests)
    report = {"format": "factory-real-hub-loopback-resume-probes", "version": 1, "mode": arguments.mode,
              "success": result.wasSuccessful() and before == after, "testsRun": result.testsRun,
              "sourceTupleBefore": before, "sourceTupleAfter": after, "sourceUnchanged": before == after,
              "observations": OBSERVATIONS, "siteInitializationDisabled": True,
              "moduleImports": {name: name in sys.modules for name in ("modal", "torch", "vllm", "hf_xet")},
              "scope": "Real SDK tiny loopback control-flow evidence; no model/provider call or historical cloud-cause claim."}
    raw = (json.dumps(report, indent=2) + "\n").encode()
    with (Path(arguments.output_directory) / "receipt.private.json").open("xb") as destination:
        destination.write(raw)
    print(json.dumps({"success": report["success"], "mode": arguments.mode, "testsRun": result.testsRun,
                      "receiptSha256": hashlib.sha256(raw).hexdigest()}))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
