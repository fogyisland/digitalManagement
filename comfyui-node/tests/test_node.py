"""Tests for the ComfyUI nodes.

Two things are worth testing here and nothing else is: the node's declared
interface (what ComfyUI shows the user, and what a workflow can connect), and
the tensor→PNG conversion — the one piece of real logic in the package, and
the one the plan calls out as the failure mode most likely to ship broken.
"""

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

    def test_upload_node_declares_its_inputs_and_outputs(self):
        from dam_node.node import DAMUpload

        inputs = DAMUpload.INPUT_TYPES()
        required = inputs["required"]
        for name in ("image", "title", "job_id"):
            self.assertIn(name, required, f"{name} must be a required input")
        self.assertIn("tags", required, "tags must be offered")
        self.assertEqual(DAMUpload.RETURN_TYPES, ("STRING", "STRING"))
        self.assertEqual(DAMUpload.RETURN_NAMES, ("asset_id", "status"))
        self.assertEqual(DAMUpload.CATEGORY, "DAM")
        self.assertFalse(DAMUpload.OUTPUT_NODE, "uploading is a side effect, not an output")

    def test_register_and_lookup_nodes_declare_their_inputs(self):
        from dam_node.node import DAMLookupJob, DAMRegisterJob

        self.assertIn("job_id", DAMRegisterJob.INPUT_TYPES()["required"])
        self.assertIn("job_id", DAMLookupJob.INPUT_TYPES()["required"])
        self.assertEqual(DAMLookupJob.RETURN_TYPES, ("STRING", "STRING"))

    def test_register_reports_what_it_actually_did(self):
        """Registration is local — the node must not claim the DAM holds it.

        `DAMRegisterJob` makes no HTTP call: the asset row is created later,
        by `DAMUpload`. A status sentence that reads as success ("已登记，上传后
        可在 DAM 中查到") tells an operator the work is done, so they skip the
        upload and then hunt for an asset that was never created. The status
        has to say when the registration takes effect, and it must not claim
        the asset is already findable.
        """
        from dam_node.node import DAMRegisterJob

        job_id, status = DAMRegisterJob().register("job-20261105-a")
        self.assertEqual(job_id, "job-20261105-a", "the id must be passed through")
        self.assertIn("上传", status, "the status has to say when it takes effect")
        self.assertNotRegex(
            status,
            r"已登记|可在 ?DAM ?中查到|上传成功",
            "the status must not claim the DAM already holds the job",
        )

    def test_the_readme_marks_registration_as_local(self):
        """The status sentence is a few characters in the node; the README is
        where the rule is read before a workflow is wired up. Registration
        being local is the one fact an operator cannot see from the UI."""
        readme = os.path.join(os.path.dirname(__file__), "..", "README.md")
        with open(readme, encoding="utf-8") as handle:
            text = " ".join(handle.read().split())
        sentences = [sentence for sentence in text.split("。") if "登记" in sentence]
        self.assertTrue(
            any("本地" in sentence for sentence in sentences),
            "the README has to say the registration is local — no sentence "
            "mentioning 登记 says so",
        )

    def test_the_node_mappings_are_complete(self):
        from dam_node.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

        self.assertEqual(
            set(NODE_CLASS_MAPPINGS),
            {"DAMUpload", "DAMRegisterJob", "DAMLookupJob"},
        )
        for name in NODE_CLASS_MAPPINGS:
            self.assertIn(name, NODE_DISPLAY_NAME_MAPPINGS)


if __name__ == "__main__":
    unittest.main()
