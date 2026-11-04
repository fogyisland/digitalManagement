"""ComfyUI entry point.

ComfyUI imports every directory under `custom_nodes/` as a package and reads
`NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS` from it. This module
re-exports them from `dam_node.node`, so the whole directory is the node pack.
"""

from .dam_node.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
