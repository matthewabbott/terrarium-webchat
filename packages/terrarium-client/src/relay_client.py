"""HTTP client for interacting with the REST chat relay."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from .status import WorkerStatusReport


class RelayClient:
    def __init__(self, *, api_base_url: str, service_token: str) -> None:
        self.api_base_url = api_base_url.rstrip('/')
        self.service_token = service_token
        self._client = httpx.AsyncClient(timeout=15)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "RelayClient":
        return self

    async def __aexit__(self, *_exc_info) -> None:
        await self.close()

    async def ping(self) -> None:
        await self.fetch_open_chats()

    async def fetch_open_chats(self) -> List[Dict[str, Any]]:
        response = await self._client.get(
            f"{self.api_base_url}/api/chats/open",
            headers=self._headers,
        )
        response.raise_for_status()
        payload = response.json()
        return [{"id": chat_id} for chat_id in payload.get("chatIds", [])]

    async def fetch_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        response = await self._client.get(
            f"{self.api_base_url}/api/chat/{chat_id}/messages",
            headers=self._headers,
        )
        response.raise_for_status()
        return response.json()

    async def post_agent_message(self, chat_id: str, content: str) -> Dict[str, Any]:
        response = await self._client.post(
            f"{self.api_base_url}/api/chat/{chat_id}/agent",
            headers=self._headers,
            json={"content": content},
        )
        response.raise_for_status()
        return response.json()

    async def post_worker_status(self, report: WorkerStatusReport) -> None:
        response = await self._client.post(
            f"{self.api_base_url}/api/worker/status",
            headers=self._headers,
            json=report.to_payload(),
        )
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
        response = await self._client.post(
            f"{self.api_base_url}/api/chat/{chat_id}/worker-state",
            headers=self._headers,
            json=payload,
        )
        response.raise_for_status()

    @property
    def _headers(self) -> Dict[str, str]:
        return {"x-service-token": self.service_token}
