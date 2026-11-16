"""Tests for the ComfyUI nodes.

Three things are worth testing here: the node's declared interface (what
ComfyUI shows the user, and what a workflow can connect), the tensor→PNG
conversion — the one piece of real logic in the package, and the one the plan
calls out as the failure mode most likely to ship broken — and the way the
two nodes are meant to be wired to each other.
"""

import json
import os
import struct
import sys
import unittest
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class FakeTensor:
    """A stand-in for a ComfyUI `IMAGE` tensor.

    ComfyUI hands nodes a `[B, H, W, C]` float tensor. The converter is written
    against `.shape` and `.tolist()` — the smallest surface that covers both a
    real torch tensor and this fake — so the test can run without torch.
    """

    def __init__(self, rows):
        self._rows = rows
        batch = len(rows)
        height = len(rows[0])
        width = len(rows[0][0])
        channels = len(rows[0][0][0])
        self.shape = (batch, height, width, channels)

    def tolist(self):
        return self._rows


def make_gradient(height, width):
    """A `[1, H, W, 3]` image: red rises along x, green along y, blue constant."""
    batch = []
    image = []
    for y in range(height):
        row = []
        for x in range(width):
            row.append(
                [
                    x / max(width - 1, 1),
                    y / max(height - 1, 1),
                    0.5,
                ]
            )
        image.append(row)
    batch.append(image)
    return FakeTensor(batch)


class EncodePngTest(unittest.TestCase):
    """The converter's output has to be a PNG a browser will open."""

    def test_the_signature_and_the_chunks_are_well_formed(self):
        from dam_node.node import encode_png

        width, height = 2, 2
        rgba_rows = bytes(
            [
                255, 0, 0, 255,
                0, 255, 0, 255,
                0, 0, 255, 255,
                255, 255, 0, 255,
            ]
        )
        png = encode_png(rgba_rows, width, height)

        self.assertTrue(png.startswith(PNG_MAGIC), "a PNG must start with its signature")

        # Walk the chunks: length, type, payload, CRC. A corrupt chunk table
        # is what a hand-written encoder gets wrong first.
        offset = len(PNG_MAGIC)
        seen = []
        while offset < len(png):
            (length,) = struct.unpack(">I", png[offset : offset + 4])
            chunk_type = png[offset + 4 : offset + 8]
            payload = png[offset + 8 : offset + 8 + length]
            (crc,) = struct.unpack(">I", png[offset + 8 + length : offset + 12 + length])
            expected = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
            self.assertEqual(crc, expected, f"CRC mismatch in {chunk_type!r}")
            seen.append(chunk_type)
            offset += 12 + length

        self.assertEqual(seen[0], b"IHDR", "IHDR must come first")
        self.assertIn(b"IDAT", seen, "the image data must be there")
        self.assertEqual(seen[-1], b"IEND", "IEND must come last")

        header = png[16:29]
        parsed_width, parsed_height, bit_depth, colour_type = struct.unpack(">IIBB", header[:10])
        self.assertEqual((parsed_width, parsed_height), (width, height))
        self.assertEqual(bit_depth, 8, "8 bits per channel")
        self.assertEqual(colour_type, 6, "colour type 6 is RGBA")


class TensorConversionTest(unittest.TestCase):
    """A ComfyUI `IMAGE` tensor becomes PNG bytes — never a tensor."""

    def test_tensor_to_bytes_returns_a_png(self):
        from dam_node.node import tensor_to_bytes

        png = tensor_to_bytes(make_gradient(4, 3))
        self.assertEqual(png[:8], PNG_MAGIC, "the result must be a PNG, not a tensor")
        # IHDR carries the dimensions; a 4x3 image must say 4x3 (width x height).
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual((width, height), (3, 4))

    def test_tensor_to_bytes_accepts_a_single_image_and_a_batch(self):
        from dam_node.node import tensor_to_bytes

        single = FakeTensor([[[[1.0, 1.0, 1.0, 1.0]]]])
        self.assertEqual(tensor_to_bytes(single)[:8], PNG_MAGIC)

        batch = FakeTensor(
            [
                [[[1.0, 0.0, 0.0, 1.0]]],
                [[[0.0, 1.0, 0.0, 1.0]]],
            ]
        )
        # A batch publishes its first frame; a node returns one asset.
        self.assertEqual(tensor_to_bytes(batch)[:8], PNG_MAGIC)

    def test_tensor_to_bytes_prepares_a_greyscale_tensor(self):
        from dam_node.node import tensor_to_bytes

        # A `[1, H, W]` (no channel axis) is a mask or a greyscale image.
        grey = FakeTensor([[[[0.5], [0.25]]]])
        self.assertEqual(tensor_to_bytes(grey)[:8], PNG_MAGIC)


class NodeContractTest(unittest.TestCase):
    """What ComfyUI reads from the class: the interface and the wiring."""

    def test_the_access_node_declares_its_outputs(self):
        """The access node hands out the address and the token — those two
        are what the push node is wired to."""
        from dam_node.node import DAMNodeAccess

        self.assertEqual(DAMNodeAccess.RETURN_TYPES, ("STRING", "STRING", "STRING", "STRING"))
        self.assertEqual(
            DAMNodeAccess.RETURN_NAMES,
            ("platform_url", "token", "node_id", "status"),
        )
        self.assertEqual(DAMNodeAccess.CATEGORY, "DAM")
        self.assertFalse(DAMNodeAccess.OUTPUT_NODE, "connecting is a side effect, not an output")

    def test_the_access_node_offers_the_address_and_the_token(self):
        from dam_node.node import DAMNodeAccess

        optional = DAMNodeAccess.INPUT_TYPES()["optional"]
        for name in ("platform_url", "token", "node_name"):
            self.assertIn(name, optional, f"{name} must be offered")

    def test_the_push_node_declares_its_inputs_and_outputs(self):
        from dam_node.node import DAMPush

        inputs = DAMPush.INPUT_TYPES()
        self.assertIn("image", inputs["required"], "the image is the one required input")
        optional = inputs["optional"]
        for name in ("platform_url", "token", "workflow_json", "title", "tags"):
            self.assertIn(name, optional, f"{name} must be offered")
        self.assertEqual(DAMPush.RETURN_TYPES, ("STRING", "STRING"))
        self.assertEqual(DAMPush.RETURN_NAMES, ("asset_id", "status"))
        self.assertEqual(DAMPush.CATEGORY, "DAM")

    def test_the_two_nodes_can_be_wired_to_each_other(self):
        """The whole design is that the second node takes the first one's
        address and token. If the names drift apart, the wire cannot be
        made."""
        from dam_node.node import DAMNodeAccess, DAMPush

        access_outputs = set(DAMNodeAccess.RETURN_NAMES)
        push_inputs = set(DAMPush.INPUT_TYPES()["optional"])
        for name in ("platform_url", "token"):
            self.assertIn(name, access_outputs, f"{name} must come out of the access node")
            self.assertIn(name, push_inputs, f"{name} must go into the push node")

    def test_the_node_mappings_are_complete(self):
        from dam_node.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

        self.assertEqual(
            set(NODE_CLASS_MAPPINGS),
            {"DAMNodeAccess", "DAMPush"},
        )
        for name in NODE_CLASS_MAPPINGS:
            self.assertIn(name, NODE_DISPLAY_NAME_MAPPINGS)

    def test_the_old_nodes_are_gone(self):
        """They are replaced, not kept around: two ways to reach the same
        door is two ways to be wrong about which one is the truth."""
        from dam_node.node import NODE_CLASS_MAPPINGS

        for gone in ("DAMUpload", "DAMRegisterJob", "DAMLookupJob"):
            self.assertNotIn(gone, NODE_CLASS_MAPPINGS, f"{gone} was removed")


class MissingInputTest(unittest.TestCase):
    """A node with nothing to work with says so in words.

    The node runs inside somebody's render farm. A stack trace in the ComfyUI
    console tells an operator far less than a sentence on the node does.
    """

    def setUp(self):
        import tempfile

        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for key in ("DAM_API_URL", "DAM_API_KEY", "DAM_STATE", "DAM_CONFIG"):
            os.environ.pop(key, None)
        # The state file is pointed at an empty temporary file, so the test
        # does not read whatever the machine running it happens to remember —
        # a node with nothing configured has to be nothing configured
        # everywhere.
        os.environ["DAM_STATE"] = os.path.join(self.directory.name, "state.json")

    def test_the_access_node_says_when_it_has_no_address(self):
        from dam_node.node import DAMNodeAccess

        url, token, node_id, status = DAMNodeAccess().access()
        self.assertEqual(url, "")
        self.assertEqual(token, "")
        self.assertEqual(node_id, "")
        self.assertIn("平台地址", status)

    def test_the_access_node_says_when_it_has_no_key(self):
        from dam_node.node import DAMNodeAccess

        _, token, _, status = DAMNodeAccess().access(platform_url="https://dam.example.com")
        self.assertEqual(token, "")
        self.assertIn("Token", status)

    def test_the_push_node_says_when_it_has_nothing_to_push_to(self):
        from dam_node.node import DAMPush

        asset_id, status = DAMPush().push(make_gradient(2, 2))
        self.assertEqual(asset_id, "")
        self.assertIn("平台地址", status)

    def test_a_broken_workflow_is_refused_before_anything_is_pushed(self):
        """The workflow is handed back as a file that claims to be JSON. A
        broken one would come back as a lie."""
        from dam_node.node import DAMPush

        asset_id, status = DAMPush().push(
            make_gradient(2, 2),
            platform_url="https://dam.example.com",
            token="dam_key",
            workflow_json="{not json",
        )
        self.assertEqual(asset_id, "")
        self.assertIn("JSON", status)


if __name__ == "__main__":
    unittest.main()
