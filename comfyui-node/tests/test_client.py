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

    def client(self):
        from dam_node.client import DamClient

        return DamClient(self.base_url, "dam_test_key")

    def test_upload_asset_posts_multipart_to_the_comfyui_endpoint(self):
        """The ingest contract: multipart, field `files`, path .../comfyui/{job}."""
        client = self.client()
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

    def test_the_workflow_travels_with_the_asset(self):
        """The workflow is the asset's own history — it rides along in the
        same multipart body, as the field the platform reads."""
        client = self.client()
        workflow = json.dumps({"1": {"class_type": "KSampler"}}, ensure_ascii=False)
        client.upload_asset(
            job_id="job-43",
            filename="output.png",
            content=b"png-bytes",
            content_type="image/png",
            fields={"workflow_json": workflow, "source_tool": "comfyui"},
        )

        body = CaptureHandler.requests[0]["body"]
        self.assertIn(b'name="workflow_json"', body, "the workflow must be its own field")
        self.assertIn(b"KSampler", body, "the workflow must arrive verbatim")
        self.assertIn(b'name="source_tool"', body)

    def test_register_node_posts_json_to_the_register_endpoint(self):
        """The node says hello with JSON, and gets the address back."""
        CaptureHandler.response_status = 200
        CaptureHandler.response_body = {
            "node_id": "node-7",
            "node_key": "abc123",
            "name": "studio",
            "platform_url": "https://dam.example.com",
        }

        payload = self.client().register_node(
            node_key="abc123",
            name="studio",
            version="2.0.0",
            comfyui_version="0.3.40",
            platform="Windows 11 AMD64",
        )

        request = CaptureHandler.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/api/ingest/v1/nodes/register")
        self.assertEqual(request["headers"].get("x-api-key"), "dam_test_key")
        self.assertIn("application/json", request["headers"].get("content-type", ""))

        sent = json.loads(request["body"].decode("utf-8"))
        self.assertEqual(sent["node_key"], "abc123")
        self.assertEqual(sent["name"], "studio")
        self.assertEqual(sent["version"], "2.0.0")
        self.assertEqual(sent["comfyui_version"], "0.3.40")

        self.assertEqual(payload["node_id"], "node-7")
        self.assertEqual(payload["platform_url"], "https://dam.example.com")

    def test_upload_asset_reports_the_backend_error(self):
        """A refused upload raises with the backend's own message."""
        from dam_node.client import DamError

        CaptureHandler.response_status = 403
        CaptureHandler.response_body = {"detail": "Missing scope: upload"}

        with self.assertRaises(DamError) as caught:
            self.client().upload_asset(
                job_id="job-44",
                filename="x.png",
                content=b"x",
                content_type="image/png",
            )
        self.assertEqual(caught.exception.status, 403)
        self.assertIn("Missing scope: upload", str(caught.exception))

    def test_a_client_without_an_address_refuses_before_it_dials(self):
        """The failure is a sentence about the node, not a connection error."""
        from dam_node.client import DamClient, DamError

        with self.assertRaises(DamError) as caught:
            DamClient("", "dam_test_key").register_node(node_key="abc")
        self.assertIn("no DAM address", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
