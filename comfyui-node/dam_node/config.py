"""Where the DAM is, and who the node is.

Two things have to be known before anything can be pushed: the address of the
DAM, and the key that says whose data may be written. Both are read from
three places, in this order:

    1. what the workflow passes into the node — the most recent statement
    2. what the node remembered last time — what it proved to work
    3. the environment or the JSON file — what the operator configured once

The order matters. A value typed into the node is the newest intent; the
remembered one is the one that already worked; the environment is the
fallback for a node that has never run.

Nothing here is required. A node with no address says so in a sentence on the
node — it does not raise, because a stack trace in the ComfyUI console tells
an operator less than "缺少平台地址" does.
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

from .state import NodeState

DEFAULT_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dam_config.json"
)


@dataclass(frozen=True)
class DamConfig:
    """What the operator configured once."""

    #: The installation root, e.g. `https://dam.example.com`.
    api_url: str = ""
    #: The key that says which tenant's data the node may write.
    api_key: str = ""
    #: Seconds per request.
    timeout: float = 30.0


def _read_json(path: str) -> dict:
    """Read the JSON configuration file, or an empty mapping if there is none.

    A file that exists but is malformed is an error, not a silent default:
    the user wrote it, so a typo in it should be reported rather than ignored.
    """
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        try:
            payload = json.load(handle)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def load_config(path: Optional[str] = None) -> DamConfig:
    """Build the configuration from the environment and the JSON file.

    Recognised names, environment first and file second:

        DAM_API_URL  / api_url    the installation root
        DAM_API_KEY  / api_key    a key with the `upload` scope
        DAM_TIMEOUT  / timeout    seconds, per request

    A malformed timeout falls back to the default rather than raising: a
    typo in a number should not stop the node from working. A malformed
    *file* does raise — that is a mistake in something the user wrote on
    purpose, and it is better said than ignored.

    Raises:
        ValueError: when the configuration file is not readable JSON.
    """
    config_path = path or os.environ.get("DAM_CONFIG") or DEFAULT_CONFIG_PATH
    from_file = _read_json(config_path)

    api_url = os.environ.get("DAM_API_URL") or from_file.get("api_url") or ""
    api_key = os.environ.get("DAM_API_KEY") or from_file.get("api_key") or ""

    raw_timeout = os.environ.get("DAM_TIMEOUT") or from_file.get("timeout") or 30.0
    try:
        timeout = float(raw_timeout)
    except (TypeError, ValueError):
        timeout = 30.0

    return DamConfig(
        api_url=str(api_url).strip(),
        api_key=str(api_key).strip(),
        timeout=timeout,
    )


def resolve_endpoint(
    config: DamConfig,
    state: NodeState,
    platform_url: str = "",
    token: str = "",
) -> tuple:
    """The address and the key to use, from the three sources in order.

    Args:
        config: what the operator configured once
        state: what the node remembered last time
        platform_url: what the workflow passed in
        token: what the workflow passed in

    Returns:
        `(platform_url, token)` — either may be empty, and the caller says so
        in words rather than guessing.
    """
    url = str(platform_url or "").strip() or state.platform_url or config.api_url
    key = str(token or "").strip() or state.token or config.api_key
    return url.rstrip("/"), key
