"""The ComfyUI nodes.

Two nodes, and they are meant to be wired to each other:

    DAMNodeAccess   asks the platform where it is, announces this ComfyUI
                    installation, and hands out the address and the token
    DAMPush         pushes a rendered image and the workflow that produced it

The second node takes its address and its token from the first one, so the
workflow carries the connection itself: move the DAM to another address, or
give it another key, and the change happens in one place.

The one piece of real logic is the tensor conversion: ComfyUI hands a node a
`[B, H, W, C]` float tensor in the 0..1 range, and the DAM wants a PNG. There
is no Pillow here — the package must install into a ComfyUI environment
without dragging a wheel behind it — so the encoder is written out. A PNG is
a signature, three chunks and a CRC, which is a page of code.
"""

import json
import platform as host_platform
import socket
import struct
import uuid
import zlib

from .client import DamError
from .config import load_config, resolve_endpoint
from .state import load_state, new_node_key, save_state

#: PNG's magic number — the first eight bytes of every file.
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: The version of this node package.
PACKAGE_VERSION = "2.0.0"


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

    Each row is prefixed with its filter type byte; the filtered bytes are
    the difference from the prediction, modulo 256. The filter is applied to
    the byte stream of the row — including the alpha channel — exactly as the
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


def _machine_name() -> str:
    """A name for this machine, so an operator can tell two nodes apart."""
    try:
        name = socket.gethostname().strip()
    except OSError:
        name = ""
    return name or "comfyui"


def _machine_platform() -> str:
    """The operating system and the machine it runs on."""
    try:
        system = host_platform.system()
        release = host_platform.release()
        machine = host_platform.machine()
    except Exception:  # pragma: no cover - platform details are best effort
        return ""
    parts = [part for part in (system, release, machine) if part]
    return " ".join(parts)


def _comfyui_version() -> str:
    """The ComfyUI version this node runs inside, if it can be found.

    The import is guarded on purpose: the package has to import cleanly
    outside ComfyUI too — that is how it is tested.
    """
    try:
        import comfy  # type: ignore
    except Exception:
        return ""
    version = getattr(comfy, "__version__", None)
    if isinstance(version, str) and version.strip():
        return version.strip()
    try:
        from comfy.cli_args import args  # type: ignore

        value = getattr(args, "version", None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:
        return ""
    return ""


class DAMNodeAccess:
    """接入平台：问清楚平台在哪儿，并把这台 ComfyUI 登记上去。

    The node answers two questions the second node cannot answer for itself:
    where the platform is, and what the node may write with. Both come out of
    the node as strings, so the next node can be wired to them.

    What it remembers between runs is the point: the address and the token
    are written down once the first time they work, and the node reads them
    back afterwards. Leaving the inputs empty is then the normal way to use
    it.
    """

    CATEGORY = "DAM"
    FUNCTION = "access"
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("platform_url", "token", "node_id", "status")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # The address of the platform. Empty means "use the one I
                # remember", and failing that "use DAM_API_URL".
                "platform_url": ("STRING", {"default": ""}),
                # The key that says whose data may be written. Empty means
                # "use the one I remember", and failing that "use
                # DAM_API_KEY".
                "token": ("STRING", {"default": ""}),
                # The name this node answers to. Empty means the machine's
                # own name.
                "node_name": ("STRING", {"default": ""}),
            },
        }

    def access(self, platform_url: str = "", token: str = "", node_name: str = ""):
        """Register this node and hand out the address and the token.

        Returns:
            `(platform_url, token, node_id, status)` — every string is empty
            when the node could not connect, and the status says why.
        """
        config = load_config()
        try:
            state = load_state()
        except ValueError as error:
            return ("", "", "", f"状态文件有问题：{error}")

        url, key = resolve_endpoint(config, state, platform_url, token)
        if not url:
            return ("", "", "", "缺少平台地址：填入平台网址，或设置 DAM_API_URL")
        if not key:
            return ("", "", "", "缺少 Token：填入 API Key，或设置 DAM_API_KEY")

        # The identity has to survive the runs, or every run would be a new
        # node on the platform's list.
        node_key = state.node_key or new_node_key()
        name = str(node_name or "").strip() or _machine_name()

        from .client import DamClient

        try:
            payload = DamClient(url, key, config.timeout).register_node(
                node_key=node_key,
                name=name,
                version=PACKAGE_VERSION,
                comfyui_version=_comfyui_version(),
                platform=_machine_platform(),
            )
        except DamError as error:
            return ("", "", "", f"接入失败：{error}")
        except ValueError as error:
            return ("", "", "", f"接入失败：{error}")

        # The platform's own answer wins: it is the address an operator says
        # this instance answers at. Without one, the address we reached it on
        # is the next best thing.
        resolved_url = str(payload.get("platform_url") or "").strip() or url
        node_id = str(payload.get("node_id") or "").strip()

        try:
            save_state(
                state.merged(
                    platform_url=resolved_url,
                    token=key,
                    node_key=node_key,
                    node_id=node_id,
                )
            )
        except OSError as error:
            # The registration worked; only the convenience failed. Saying so
            # is better than pretending the node will remember it next time.
            return (
                resolved_url,
                key,
                node_id,
                f"已接入 {resolved_url}，但状态写入失败（下次要再填一次）：{error}",
            )

        return (resolved_url, key, node_id, f"已接入 {resolved_url}（节点 {name}）")


class DAMPush:
    """推送资产：把图片和工作流一起送进平台。

    The address and the token come from the access node — that is what the
    wire between them is for. When they are left empty, the node falls back
    to what it remembered last time, so a workflow that only has this node in
    it still works after the first run.
    """

    CATEGORY = "DAM"
    FUNCTION = "push"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("asset_id", "status")
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                # Wire these to the access node's outputs.
                "platform_url": ("STRING", {"default": ""}),
                "token": ("STRING", {"default": ""}),
                # The ComfyUI workflow that produced the image. It is stored
                # with the asset and can be downloaded again from the asset's
                # own page.
                "workflow_json": ("STRING", {"default": "", "multiline": True}),
                "job_id": ("STRING", {"default": ""}),
                "title": ("STRING", {"default": ""}),
                "tags": ("STRING", {"default": ""}),
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": -1, "min": -1}),
            },
        }

    def push(
        self,
        image,
        platform_url: str = "",
        token: str = "",
        workflow_json: str = "",
        job_id: str = "",
        title: str = "",
        tags: str = "",
        prompt: str = "",
        seed: int = -1,
    ):
        """Render the tensor to a PNG and push it, with the workflow.

        Returns:
            `(asset_id, status)` — `asset_id` is empty when the push failed,
            and the status says why.
        """
        config = load_config()
        try:
            state = load_state()
        except ValueError as error:
            return ("", f"推送失败：状态文件有问题：{error}")

        url, key = resolve_endpoint(config, state, platform_url, token)
        if not url:
            return ("", "推送失败：缺少平台地址，请先跑一次「DAM 接入」")
        if not key:
            return ("", "推送失败：缺少 Token，请先跑一次「DAM 接入」")

        workflow = str(workflow_json or "").strip()
        if workflow:
            # The workflow is stored as the node sent it and handed back as
            # a file. A broken one would come back as a file that claims to
            # be JSON and is not — so it is refused here, with a sentence.
            try:
                json.loads(workflow)
            except json.JSONDecodeError as error:
                return ("", f"推送失败：工作流不是合法 JSON（{error}）")

        # The job id is the correlation with the generator. Left empty, one
        # is made — a fresh one every run, so two runs of the same workflow
        # are two records rather than one overwritten record.
        resolved_job = str(job_id or "").strip() or f"comfyui-{uuid.uuid4().hex[:12]}"

        fields = {"source_tool": "comfyui", "job_id": resolved_job}
        if title:
            fields["title"] = str(title)
        if tags:
            fields["tag_names"] = str(tags)
        if prompt:
            fields["prompt"] = str(prompt)
        if seed is not None and int(seed) >= 0:
            fields["seed"] = str(int(seed))
        if workflow:
            fields["workflow_json"] = workflow

        content = tensor_to_bytes(image)

        from .client import DamClient

        try:
            asset = DamClient(url, key, config.timeout).upload_asset(
                job_id=resolved_job,
                filename=f"{_slug(resolved_job)}.png",
                content=content,
                content_type="image/png",
                fields=fields,
            )
        except DamError as error:
            return ("", f"推送失败：{error}")
        except ValueError as error:
            return ("", f"推送失败：{error}")

        size = f"{len(content) // 1024} KB"
        workflow_note = "，含工作流" if workflow else ""
        return (asset.id, f"已推送到 DAM（{size}{workflow_note}）")


NODE_CLASS_MAPPINGS = {
    "DAMNodeAccess": DAMNodeAccess,
    "DAMPush": DAMPush,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DAMNodeAccess": "DAM 接入",
    "DAMPush": "DAM 推送",
}

__all__ = [
    "encode_png",
    "tensor_to_bytes",
    "DAMNodeAccess",
    "DAMPush",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
