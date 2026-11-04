"""Configuration for the DAM nodes.

The nodes need two things: where the DAM is, and who they are. Both are read
from the environment first — that is the form that travels with a container or
a shell — and from a JSON file second, so a user who never touches environment
variables can keep a file next to their ComfyUI installation.

Environment wins over the file on purpose: a `DAM_API_URL` exported for one
run must not be silently overridden by a file that was configured months ago.
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

DEFAULT_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dam_config.json"
)


@dataclass(frozen=True)
class DamConfig:
    """Everything the client needs to talk to one DAM installation."""

    api_url: str
    api_key: str
    tenant: Optional[str] = None
    timeout: float = 30.0

    def __post_init__(self) -> None:
        if not self.api_url:
            raise ValueError("api_url must not be empty")
        if not self.api_key:
            raise ValueError("api_key must not be empty")


def _read_json(path: str) -> dict:
    """Read the JSON configuration file, or an empty mapping if there is none.

    A file that exists but is malformed is an error, not a silent default: the
    user wrote it, so a typo in it should be reported rather than ignored.
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

        DAM_API_URL  / api_url    the installation root, e.g. http://dam.local:8000
        DAM_API_KEY  / api_key    a key with the `upload` scope
        DAM_TENANT   / tenant     a label for the log line only; the tenant the
                                  data lands in is the key's, decided by the DAM
        DAM_TIMEOUT  / timeout    seconds, per request

    Raises:
        ValueError: when a required value is missing.
    """
    config_path = path or os.environ.get("DAM_CONFIG") or DEFAULT_CONFIG_PATH
    from_file = _read_json(config_path)

    api_url = os.environ.get("DAM_API_URL") or from_file.get("api_url") or ""
    api_key = os.environ.get("DAM_API_KEY") or from_file.get("api_key") or ""
    tenant = os.environ.get("DAM_TENANT") or from_file.get("tenant") or None

    raw_timeout = os.environ.get("DAM_TIMEOUT") or from_file.get("timeout") or 30.0
    try:
        timeout = float(raw_timeout)
    except (TypeError, ValueError) as error:
        raise ValueError(f"timeout must be a number, got {raw_timeout!r}") from error

    if not api_url:
        raise ValueError(
            "DAM_API_URL is not set — export it, or put `api_url` in "
            f"{config_path}"
        )
    if not api_key:
        raise ValueError(
            "DAM_API_KEY is not set — export it, or put `api_key` in "
            f"{config_path}"
        )
    return DamConfig(api_url=api_url.rstrip("/"), api_key=api_key, tenant=tenant, timeout=timeout)
