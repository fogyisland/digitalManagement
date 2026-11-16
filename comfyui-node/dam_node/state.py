"""What the node remembers between runs.

A ComfyUI installation is a long-lived thing: the address of the DAM and the
key it writes with do not change from one run to the next. Typing them into
the workflow every time is friction with no benefit, so the node writes down
what worked and reads it back.

The file holds a credential. It is written with owner-only permissions where
the platform allows it, and it is a convenience rather than a vault: anybody
who can read the file can push into the tenant the key belongs to. The
`DAM_STATE` environment variable moves it elsewhere — a mounted secret, if
that is what the installation wants.

    DAM_STATE — where the file lives (default `~/.dam-comfyui/state.json`)
"""

import json
import os
import uuid
from dataclasses import dataclass
from typing import Optional

DEFAULT_STATE_PATH = os.path.join(os.path.expanduser("~"), ".dam-comfyui", "state.json")


@dataclass(frozen=True)
class NodeState:
    """What the node remembers."""

    #: The address the platform says it answers at.
    platform_url: str = ""
    #: The key the node writes with.
    token: str = ""
    #: The node's own identity — the same ComfyUI is always the same one.
    node_key: str = ""
    #: The row the platform gave it.
    node_id: str = ""

    def merged(self, **changes) -> "NodeState":
        """A copy with some fields replaced and the others kept.

        An empty value does not overwrite: the node key is known but the
        platform id is not yet, and the second must not erase the first.
        """
        values = {
            "platform_url": self.platform_url,
            "token": self.token,
            "node_key": self.node_key,
            "node_id": self.node_id,
        }
        for name, value in changes.items():
            if name not in values:
                raise KeyError(name)
            text = str(value or "").strip()
            if text:
                values[name] = text
        return NodeState(**values)


def state_path(path: Optional[str] = None) -> str:
    """Where the state file lives."""
    return path or os.environ.get("DAM_STATE") or DEFAULT_STATE_PATH


def new_node_key() -> str:
    """A fresh identity for this ComfyUI installation.

    The key is what the platform keys its row on, so it has to stay the same
    across runs — it is written to the state file the first time it is made.
    """
    return uuid.uuid4().hex


def load_state(path: Optional[str] = None) -> NodeState:
    """Read the state file, or an empty state when there is none.

    A file that cannot be read is not a reason to fail: the node falls back
    to the environment and to what the workflow passes in. A file that is
    there but holds something else is a mistake worth saying out loud, so it
    raises — but only for a JSON error, which means the user edited it.
    """
    target = state_path(path)
    if not os.path.exists(target):
        return NodeState()
    try:
        with open(target, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except json.JSONDecodeError as error:
        raise ValueError(f"{target} is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"{target} must contain a JSON object")
    return NodeState(
        platform_url=str(payload.get("platform_url") or "").strip(),
        token=str(payload.get("token") or "").strip(),
        node_key=str(payload.get("node_key") or "").strip(),
        node_id=str(payload.get("node_id") or "").strip(),
    )


def save_state(state: NodeState, path: Optional[str] = None) -> None:
    """Write the state file, with owner-only permissions where possible.

    The directory is created if it is missing — the file lives in the user's
    home directory, which on a fresh machine may not have the folder yet.
    """
    target = state_path(path)
    directory = os.path.dirname(target)
    if directory:
        os.makedirs(directory, exist_ok=True)
    payload = {
        "platform_url": state.platform_url,
        "token": state.token,
        "node_key": state.node_key,
        "node_id": state.node_id,
    }
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
    # The file holds a credential. On a POSIX system the mode is the only
    # thing keeping another user on the machine out of it.
    try:
        os.chmod(target, 0o600)
    except OSError:
        # Windows has no POSIX mode; the file inherits the folder's own
        # protection there, and refusing to save because of that would be
        # worse than saving.
        pass
