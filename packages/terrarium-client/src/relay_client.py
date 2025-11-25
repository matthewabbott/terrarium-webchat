"""HTTP client for interacting with the REST chat relay."""

from __future__ import annotations

from typing import Any, Dict, List, Optional
import hmac
import hashlib
import json
import time

import httpx

from .status import WorkerStatusReport


class RelayClient:
    def __init__(
        self,
        *,
        api_base_url: str,
        service_token: str,
        hmac_secret: Optional[str] = None,
        hmac_enabled: bool = False,
        hmac_max_skew_seconds: int = 300,
    ) -> None:
        self.api_base_url = api_base_url.rstrip('/')
        self.service_token = service_token
        self._client = httpx.AsyncClient(timeout=15)
        self._hmac_secret = hmac_secret or ""
        self._hmac_enabled = hmac_enabled and bool(self._hmac_secret)
        self._hmac_max_skew_seconds = hmac_max_skew_seconds

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "RelayClient":
        return self

    async def __aexit__(self, *_exc_info) -> None:
        await self.close()

    async def ping(self) -> None:
        await self.fetch_open_chats()

    async def fetch_open_chats(self) -> List[Dict[str, Any]]:
        response = await self._client.get(f"{self.api_base_url}/api/chats/open", headers=self._headers("GET", "/api/chats/open"))
        response.raise_for_status()
        payload = response.json()
        return [{"id": chat_id} for chat_id in payload.get("chatIds", [])]

    async def fetch_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        path = f"/api/chat/{chat_id}/messages"
        response = await self._client.get(f"{self.api_base_url}{path}", headers=self._headers("GET", path))
        response.raise_for_status()
        return response.json()

    async def post_agent_message(self, chat_id: str, content: str) -> Dict[str, Any]:
        path = f"/api/chat/{chat_id}/agent"
        body = {"content": content}
        response = await self._client.post(f"{self.api_base_url}{path}", headers=self._headers("POST", path, body), json=body)
        response.raise_for_status()
        return response.json()

    async def post_agent_chunk(self, chat_id: str, content: str, done: bool = False) -> None:
        path = f"/api/chat/{chat_id}/agent-chunk"
        body = {"content": content, "done": done}
        response = await self._client.post(f"{self.api_base_url}{path}", headers=self._headers("POST", path, body), json=body)
        response.raise_for_status()

    async def post_worker_status(self, report: WorkerStatusReport) -> None:
        path = "/api/worker/status"
        body = report.to_payload()
        response = await self._client.post(f"{self.api_base_url}{path}", headers=self._headers("POST", path, body), json=body)
        response.raise_for_status()

    async def post_worker_state(
        self,
        chat_id: str,
        state: str,
        detail: Optional[str] = None,
    ) -> None:
        payload: Dict[str, Any] = {"state": state}
        if detail:
            payload["detail"] = detail
        path = f"/api/chat/{chat_id}/worker-state"
        response = await self._client.post(f"{self.api_base_url}{path}", headers=self._headers("POST", path, payload), json=payload)
        response.raise_for_status()

    def _headers(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {"x-service-token": self.service_token}
        if not self._hmac_enabled:
            return headers
        timestamp = str(int(time.time()))
        body_str = "" if body is None else json.dumps(body, separators=(",", ":"), sort_keys=True)
        payload = "\n".join([method.upper(), path, timestamp, body_str])
        signature = hmac.new(self._hmac_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        headers.update(
            {
                "x-signature": signature,
                "x-signature-ts": timestamp,
                "x-signature-scope": "terra-worker",
            }
        )
        return headers
