"""Tests for the DAM ComfyUI client.

The client's only job is to speak the DAM's ingest contract correctly, so the
tests drive it against a real (in-process) HTTP server and inspect what
actually arrived on the wire: the method, the path, the header, and the raw
multipart body. Mocking `urllib` would prove the code calls the functions the
test told it to call; capturing the request proves the contract.
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class CaptureHandler(BaseHTTPRequestHandler):
    """Record every request and answer a canned JSON response."""

    # The values the test asserts on, set by the test before it runs.
    response_status = 201
    response_body = {"items": [{"id": "asset-1"}], "count": 1}
    requests = []

    def _record_and_respond(self, method, body):
        CaptureHandler.requests.append(
            {
                "method": method,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": body,
            }
        )
        payload = json.dumps(CaptureHandler.response_body).encode("utf-8")
        self.send_response(CaptureHandler.response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):  # noqa: N802 - http.server's naming
        length = int(self.headers.get("Content-Length", "0"))
        self._record_and_respond("POST", self.rfile.read(length))

    def do_GET(self):  # noqa: N802 - http.server's naming
        self._record_and_respond("GET", b"")

    def log_message(self, format, *args):  # noqa: A002 - http.server's signature
        """Silence the default access log; the test output is the report."""


class ClientContractTest(unittest.TestCase):
    """What the DAM receives when the node publishes a file."""

    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        CaptureHandler.requests.clear()
        CaptureHandler.response_status = 201
        CaptureHandler.response_body = {"items": [{"id": "asset-1"}], "count": 1}
        os.environ["DAM_API_URL"] = self.base_url
        os.environ["DAM_API_KEY"] = "dam_test_key"
        os.environ.pop("DAM_TENANT", None)

    def test_upload_asset_posts_multipart_to_the_comfyui_endpoint(self):
        """The ingest contract: multipart, field `files`, path .../comfyui/{job}."""
        from dam_node.config import load_config
        from dam_node.client import DamClient

        config = load_config()
        self.assertEqual(config.api_url, self.base_url)
        self.assertEqual(config.api_key, "dam_test_key")

        client = DamClient(config)
        result = client.upload_asset(
            job_id="job-42",
            filename="output.png",
            content=b"\x89PNG\r\n\x1a\nfake-png-bytes",
            content_type="image/png",
            fields={"title": "A generated image"},
        )

        self.assertEqual(len(CaptureHandler.requests), 1, "exactly one request must be sent")
        request = CaptureHandler.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/api/ingest/v1/comfyui/job-42")
        self.assertEqual(request["headers"].get("x-api-key"), "dam_test_key")

        content_type = request["headers"].get("content-type", "")
        self.assertTrue(
            content_type.startswith("multipart/form-data; boundary="),
            f"expected a multipart body, got {content_type!r}",
        )
        body = request["body"]
        self.assertIn(b'name="files"', body, "the file field must be named `files`")
        self.assertIn(b'filename="output.png"', body, "the filename must travel with the part")
        self.assertIn(b"Content-Type: image/png", body, "the part must carry its content type")
        self.assertIn(b"fake-png-bytes", body, "the bytes must be the ones handed in")
        self.assertIn(b'name="title"', body, "extra fields must travel as form fields")
        self.assertIn(b"A generated image", body)

        self.assertEqual(result.id, "asset-1")
        self.assertEqual(result.raw["id"], "asset-1")

    def test_upload_asset_reports_the_backend_error(self):
        """A refused upload raises with the backend's own message."""
        from dam_node.config import load_config
        from dam_node.client import DamClient, DamError

        CaptureHandler.response_status = 403
        CaptureHandler.response_body = {"detail": "Missing scope: upload"}

        client = DamClient(load_config())
        with self.assertRaises(DamError) as caught:
            client.upload_asset(
                job_id="job-43",
                filename="x.png",
                content=b"x",
                content_type="image/png",
            )
        self.assertEqual(caught.exception.status, 403)
        self.assertIn("Missing scope: upload", str(caught.exception))

    def test_lookup_job_returns_none_when_the_job_is_unknown(self):
        """`GET /jobs/by-comfyui/{job}` answers 404 for a job with no asset."""
        from dam_node.config import load_config
        from dam_node.client import DamClient

        CaptureHandler.response_status = 404
        CaptureHandler.response_body = {"detail": "Not found"}

        client = DamClient(load_config())
        self.assertIsNone(client.find_job("job-unknown"))

    def test_config_falls_back_to_the_json_file(self):
        """Without the environment, the JSON file is the configuration."""
        import tempfile

        from dam_node.config import load_config

        for key in ("DAM_API_URL", "DAM_API_KEY", "DAM_TENANT"):
            os.environ.pop(key, None)
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dam_config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "api_url": "http://127.0.0.1:9999",
                        "api_key": "dam_from_file",
                        "tenant": "team-a",
                    },
                    handle,
                )
            config = load_config(path)
        self.assertEqual(config.api_url, "http://127.0.0.1:9999")
        self.assertEqual(config.api_key, "dam_from_file")
        self.assertEqual(config.tenant, "team-a")


if __name__ == "__main__":
    unittest.main()
