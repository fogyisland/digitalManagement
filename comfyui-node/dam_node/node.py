"""The ComfyUI nodes.

Three nodes, each a thin translation between ComfyUI's data and the DAM's
HTTP contract:

    DAMUpload       a rendered image goes to the DAM; returns the asset id
    DAMRegisterJob  a job is registered before its output exists
    DAMLookupJob    the asset a job produced, if there is one

The one piece of real logic is the tensor conversion: ComfyUI hands a node a
`[B, H, W, C]` float tensor in the 0..1 range, and the DAM wants a PNG. There
is no Pillow here — the package must install into a ComfyUI environment
without dragging a wheel behind it — so the encoder is written out. A PNG is
a signature, three chunks and a CRC, which is a page of code.
"""

import struct
import zlib

from .client import DamError
from .config import load_config

#: PNG's magic number — the first eight bytes of every file.
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _paeth(left: int, above: int, upper_left: int) -> int:
    """The Paeth predictor from the PNG specification (filter type 4)."""
    estimate = left + above - upper_left
    distance_left = abs(estimate - left)
    distance_above = abs(estimate - above)
    distance_upper_left = abs(estimate - upper_left)
    if distance_left <= distance_above and distance_left <= distance_upper_left:
        return left
    if distance_above <= distance_upper_left:
        return above
    return upper_left


def _filter_rows(rgba_rows: bytes, width: int, height: int) -> bytes:
    """Apply the Paeth filter to every row, as the PNG spec lays it out.

    Each row is prefixed with its filter type byte; the filtered bytes are the
    difference from the prediction, modulo 256. The filter is applied to the
    byte stream of the row — including the alpha channel — exactly as the
    specification describes.
    """
    stride = width * 4
    out = bytearray()
    previous = bytes(stride)
    for row_index in range(height):
        row = rgba_rows[row_index * stride : (row_index + 1) * stride]
        out.append(4)  # Paeth
        filtered = bytearray(stride)
        for i in range(stride):
            left = row[i - 4] if i >= 4 else 0
            above = previous[i]
            upper_left = previous[i - 4] if i >= 4 else 0
            filtered[i] = (row[i] - _paeth(left, above, upper_left)) & 0xFF
        out.extend(filtered)
        previous = row
    return bytes(out)


def _chunk(chunk_type: bytes, payload: bytes) -> bytes:
    """One PNG chunk: length, type, payload, CRC over type+payload."""
    crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", crc)


def encode_png(rgba_rows: bytes, width: int, height: int) -> bytes:
    """Encode raw RGBA rows as a PNG. zlib + struct only, no Pillow.

    Args:
        rgba_rows: `height * width * 4` bytes, row-major, 8 bits per channel.
        width: pixels per row.
        height: rows.

    Returns:
        The PNG file as bytes.
    """
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")
    if len(rgba_rows) != width * height * 4:
        raise ValueError(
            f"expected {width * height * 4} bytes of RGBA data, got {len(rgba_rows)}"
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(_filter_rows(rgba_rows, width, height), 6)
    return b"".join(
        [
            PNG_SIGNATURE,
            _chunk(b"IHDR", header),
            _chunk(b"IDAT", compressed),
            _chunk(b"IEND", b""),
        ]
    )


def _normalise_channel(shape):
    """The number of colour channels in a tensor's last axis.

    ComfyUI's `IMAGE` is `[B, H, W, C]` with C in 1, 3 or 4. A shape without
    the batch axis (`[H, W, C]`) is accepted too, because a mask or a preview
    sometimes reaches a node that way.
    """
    if len(shape) == 4:
        return shape[3], len(shape)
    if len(shape) == 3:
        return shape[2], 3
    if len(shape) == 2:
        return 1, 2
    raise ValueError(f"unsupported tensor shape: {shape!r}")


def tensor_to_bytes(image) -> bytes:
    """Convert a ComfyUI `IMAGE` tensor into PNG bytes.

    The tensor is a float array in the 0..1 range. A batch publishes its first
    frame — a node produces one asset, and picking a frame silently would be
    worse than saying so.

    Args:
        image: anything with `.shape` and `.tolist()` — a torch tensor or a
            test double.

    Returns:
        PNG bytes.
    """
    shape = tuple(image.shape)
    channels, axis_count = _normalise_channel(shape)

    data = image.tolist()
    # Drop the leading axes above `[H, W, ...]`. A 4-D tensor is `[B, H, W, C]`
    # and a 3-D one is `[H, W, C]`, so the number of axes to drop follows
    # from the shape the caller gave us — no guessing from the data.
    for _ in range(max(0, len(shape) - 3)):
        data = data[0]

    height = len(data)
    width = len(data[0]) if height else 0
    if not height or not width:
        raise ValueError("the tensor has no pixels")

    rows = bytearray()
    for y in range(height):
        for x in range(width):
            pixel = data[y][x]
            if not isinstance(pixel, (list, tuple)):
                pixel = [pixel]
            rgba = _to_rgba(pixel, channels)
            rows.extend(rgba)

    return encode_png(bytes(rows), width, height)


def _to_rgba(pixel, channels: int) -> bytes:
    """Clamp one float pixel to 8-bit RGBA."""
    values = [max(0.0, min(1.0, float(component))) for component in pixel]
    if channels == 1 or len(values) == 1:
        grey = values[0]
        return bytes([_to_byte(grey)] * 3 + [255])
    if len(values) == 2:  # grey + alpha
        grey = values[0]
        return bytes([_to_byte(grey)] * 3 + [_to_byte(values[1])])
    red, green, blue = values[0], values[1], values[2]
    alpha = values[3] if len(values) > 3 else 1.0
    return bytes([_to_byte(red), _to_byte(green), _to_byte(blue), _to_byte(alpha)])


def _to_byte(component: float) -> int:
    return int(round(max(0.0, min(1.0, component)) * 255))


def _slug(text: str, fallback: str = "image") -> str:
    cleaned = "".join(char if char.isalnum() or char in "-_" else "-" for char in text)
    cleaned = cleaned.strip("-")
    return cleaned or fallback


class DAMUpload:
    """Publish a rendered image to the DAM."""

    CATEGORY = "DAM"
    FUNCTION = "upload"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("asset_id", "status")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "title": ("STRING", {"default": ""}),
                "job_id": ("STRING", {"default": ""}),
                "tags": ("STRING", {"default": ""}),
            },
            "optional": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": -1, "min": -1}),
            },
        }

    def upload(self, image, title, job_id, tags="", prompt=None, seed=-1):
        """Render the tensor to a PNG and publish it.

        Returns:
            `(asset_id, status)` — `status` is a human sentence for the
            ComfyUI output panel, in the same language as the rest of the
            product.
        """
        config = load_config()
        from .client import DamClient

        client = DamClient(config)

        resolved_job = str(job_id or "").strip()
        if not resolved_job:
            # A workflow that does not supply a job id still produces an
            # asset; the id only exists to correlate with the generator.
            resolved_job = f"comfyui-{_slug(str(title or 'image'))}"

        fields = {"title": str(title or resolved_job)}
        if tags:
            fields["tag_names"] = str(tags)
        if prompt:
            fields["prompt"] = str(prompt)
        if seed is not None and int(seed) >= 0:
            fields["seed"] = str(int(seed))
        fields["source_tool"] = "comfyui"

        content = tensor_to_bytes(image)
        try:
            asset = client.upload_asset(
                job_id=resolved_job,
                filename=f"{_slug(resolved_job)}.png",
                content=content,
                content_type="image/png",
                fields=fields,
            )
        except DamError as error:
            return ("", f"上传失败：{error}")
        return (asset.id, f"已上传到 DAM（{len(content) // 1024} KB）")


class DAMRegisterJob:
    """Register a job in the DAM before its output exists."""

    CATEGORY = "DAM"
    FUNCTION = "register"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("job_id", "status")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "job_id": ("STRING", {"default": ""}),
            },
            "optional": {
                "title": ("STRING", {"default": ""}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
            },
        }

    def register(self, job_id, title="", prompt=""):
        """Register the job, so a later `DAMUpload` can fill it in.

        Nothing leaves this process: the asset row is created when the upload
        happens, so the status must not read as "the DAM has it". It names the
        moment the registration takes effect instead — an operator who reads
        "已登记" and stops here goes looking for an asset that does not exist.
        """
        resolved_job = str(job_id or "").strip()
        if not resolved_job:
            return ("", "缺少 job_id")
        return (resolved_job, "已生成 job 标识，上传时在 DAM 中生效")


class DAMLookupJob:
    """Find the asset a job produced."""

    CATEGORY = "DAM"
    FUNCTION = "lookup"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("asset_id", "status")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"job_id": ("STRING", {"default": ""})}}

    def lookup(self, job_id):
        """Return the asset id for the job, or a sentence explaining why not."""
        resolved_job = str(job_id or "").strip()
        if not resolved_job:
            return ("", "缺少 job_id")
        config = load_config()
        from .client import DamClient

        try:
            asset = DamClient(config).find_job(resolved_job)
        except DamError as error:
            return ("", f"查询失败：{error}")
        if asset is None:
            return ("", f"未找到 job {resolved_job} 对应的资产")
        return (str(asset.get("id", "")), f"找到资产：{asset.get('title', '')}")


NODE_CLASS_MAPPINGS = {
    "DAMUpload": DAMUpload,
    "DAMRegisterJob": DAMRegisterJob,
    "DAMLookupJob": DAMLookupJob,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DAMUpload": "DAM 上传",
    "DAMRegisterJob": "DAM 登记任务",
    "DAMLookupJob": "DAM 查询任务",
}

__all__ = [
    "encode_png",
    "tensor_to_bytes",
    "DAMUpload",
    "DAMRegisterJob",
    "DAMLookupJob",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
