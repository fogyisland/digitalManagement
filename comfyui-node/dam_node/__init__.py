"""The DAM ComfyUI nodes.

A thin ComfyUI front end over the DAM's ingest API: the nodes render an image
into PNG bytes and hand them to `DamClient`, which speaks the documented
contract. All of the integration logic lives on the DAM side — these modules
only translate ComfyUI's data into HTTP.

Only the standard library is used, so the package can be dropped into any
ComfyUI installation without touching its environment.
"""

from .client import DamClient, DamError
from .config import DamConfig, load_config

__all__ = ["DamClient", "DamError", "DamConfig", "load_config"]
