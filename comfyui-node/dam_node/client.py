"""The DAM HTTP client.

Standard library only (`urllib`, `json`, `uuid`): the package has to be
droppable into a ComfyUI installation without touching its environment, and
ComfyUI installations are exactly the kind of environment where a `pip
install requests` is a support ticket.

The client speaks the documented ingest contract and nothing else. Two
endpoints matter to a node:

    POST {api_url}/api/ingest/v1/comfyui/{job_id}   multipart, field `files`
    GET  {api_url}/api/v1/jobs/by-comfyui/{job_id}  look the job up again

The second one authenticates with a bearer token, not an API key — it is the
admin API — so the client sends the key as a bearer token there only, and
treats a 401 as "I cannot look this up", which is what a node on a render farm
usually gets.
"""

import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

from .config import DamConfig

#: The multipart field name the DAM's ingest endpoint expects.
FILE_FIELD = "files"


class DamError(RuntimeError):
    """A refused or failed request, carrying what the backend said."""

    def __init__(self, message: str, status: int = 0, body: Optional[Any] = None):
        super().__init__(message)
        self.status = status
        self.body = body


@dataclass(frozen=True)
class UploadedAsset:
    """The part of the ingest response a node needs."""

    id: str
    title: str
    tenant_id: Optional[str]
    raw: Mapping[str, Any]


def _encode_multipart(
    fields: Mapping[str, str], filename: str, content: bytes, content_type: str
) -> Tuple[bytes, str]:
    """Build a multipart/form-data body.

    Returns the body and the value for the `Content-Type` header (which
    carries the boundary). The file goes in the field the DAM reads (`files`);
    every other key becomes an ordinary form field.
    """
    boundary = f"----dam{uuid.uuid4().hex}"
    chunks = []

    for name, value in fields.items():
        if value is None:
            continue
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
        )
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{FILE_FIELD}"; '
            f'filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
    )
    chunks.append(content)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))

    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class DamClient:
    """A minimal HTTP client for one DAM installation."""

    def __init__(self, config: DamConfig):
        self.config = config

    # -- internals ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        content_type: Optional[str] = None,
        bearer: bool = False,
    ) -> Tuple[int, Any]:
        """Send one request and return `(status, parsed_body)`.

        Raises:
            DamError: for a transport failure or any non-2xx answer.
        """
        url = f"{self.config.api_url}{path}"
        headers = {"Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        if bearer:
            # The admin API speaks bearer tokens; the ingest API speaks API
            # keys. This is how the same key serves both.
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        else:
            headers["X-API-Key"] = self.config.api_key

        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout) as response:
                raw = response.read()
                payload = json.loads(raw.decode("utf-8")) if raw else None
                return response.status, payload
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else None
            except json.JSONDecodeError:
                payload = raw.decode("utf-8", "replace") if raw else None
            detail = payload.get("detail") if isinstance(payload, dict) else payload
            raise DamError(
                f"{method} {path} answered {error.code}: {detail}", error.code, payload
            ) from error
        except urllib.error.URLError as error:
            raise DamError(f"{method} {path} could not reach the DAM: {error.reason}") from error

    # -- the contract ------------------------------------------------------

    def upload_asset(
        self,
        *,
        job_id: str,
        filename: str,
        content: bytes,
        content_type: Optional[str] = None,
        fields: Optional[Mapping[str, Any]] = None,
    ) -> UploadedAsset:
        """Publish one file for a ComfyUI job.

        The job id is in the path, so a node can register a job and upload its
        artifact in the same call, and the DAM can deduplicate by job.

        Args:
            job_id: the node's job identifier.
            filename: the name the DAM records (`output.png`).
            content: the file bytes — a PNG, never a tensor.
            content_type: defaults to a guess from the filename.
            fields: extra form fields (`title`, `prompt`, `seed`, ...).

        Returns:
            The first asset the DAM created or found.
        """
        if not job_id:
            raise ValueError("job_id must not be empty")
        if not content:
            raise ValueError("content must not be empty")

        resolved_type = (
            content_type
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream"
        )
        body, boundary_type = _encode_multipart(
            dict(fields or {}), filename, content, resolved_type
        )
        quoted_job = urllib.parse.quote(job_id, safe="")
        _, payload = self._request(
            "POST",
            f"/api/ingest/v1/comfyui/{quoted_job}",
            body=body,
            content_type=boundary_type,
        )

        items = (payload or {}).get("items") or []
        if not items:
            raise DamError("the DAM accepted the upload but returned no asset", 0, payload)
        asset = items[0]
        return UploadedAsset(
            id=asset.get("id", ""),
            title=asset.get("title", ""),
            tenant_id=asset.get("tenant_id"),
            raw=asset,
        )

    def find_job(self, job_id: str) -> Optional[Mapping[str, Any]]:
        """Look up the asset a job produced, or `None` when there is none.

        The admin API answers 404 for an unknown job; that is a normal answer
        for a node that registered a job and has not uploaded yet, so it
        becomes `None` instead of an exception.
        """
        quoted_job = urllib.parse.quote(job_id, safe="")
        try:
            _, payload = self._request(
                "GET", f"/api/v1/jobs/by-comfyui/{quoted_job}", bearer=True
            )
        except DamError as error:
            if error.status == 404:
                return None
            raise
        return payload if isinstance(payload, dict) else None
