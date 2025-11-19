"""Simple client for terrarium-agent's OpenAI-compatible API."""

from __future__ import annotations

import logging
from time import perf_counter
from typing import Optional, Tuple
from urllib.parse import urlparse, urlunparse

import httpx
from httpx import HTTPStatusError, RequestError

from .context import Conversation

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = """\
You are Terra-webchat, also known as Terra. You are an instance of GLM-4.5-Air-AWQ-4bit
running on Matthew Abbott's NVIDIA DGX Spark machine. This is one of many endpoints of yours
and at this one, you're in a chat window at mbabbott.com/terra/.

In the future, you'll have tools to know more about your ecosystem and the mbabbott.com website.
Matthew will count on you to tell visitors about what they can see on the site, and also
how he's totally cool and they should hire him or something.

For now though those tools are under development, so you should just b urself."""


class AgentClientError(Exception):
    """Raised when terrarium-agent does not return a usable response."""


def _derive_health_url(api_url: str) -> str:
    parsed = urlparse(api_url)
    path = parsed.path
    marker = '/v1/'
    if marker in path:
        prefix = path.split(marker)[0]
        normalized_path = f"{prefix}/health"
    else:
        normalized_path = '/health'
    return urlunparse(parsed._replace(path=normalized_path, query='', fragment=''))


class AgentClient:
    def __init__(
        self,
        *,
        api_url: str,
        model: str,
        timeout_seconds: float = 60.0,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        health_url: Optional[str] = None,
    ) -> None:
        self.api_url = api_url
        self.model = model
        self.system_prompt = system_prompt
        self.health_url = health_url or _derive_health_url(api_url)
        self._client = httpx.AsyncClient(timeout=timeout_seconds)

    async def close(self) -> None:
        await self._client.aclose()

    async def generate(self, conversation: Conversation) -> Tuple[str, float]:
        messages = conversation.to_prompt_messages(system_prompt=self.system_prompt, max_turns=16)
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
            "stream": False,
        }
        return await self._post_for_content(payload)

    async def check_api_status(self) -> Tuple[str, Optional[str]]:
        url = self.health_url or self.api_url
        try:
            response = await self._client.get(url)
            if 200 <= response.status_code < 300:
                return "online", None
            detail = f"HTTP {response.status_code}"
            if response.status_code >= 500:
                return "degraded", detail
            return "online", detail
        except RequestError as exc:
            logger.warning("Agent health check failed: %s", exc)
            return "offline", str(exc)

    async def probe_llm(self) -> Tuple[str, Optional[str], Optional[float]]:
        health_prompt = [
            {
                "role": "system",
                "content": "You are Terra's self-check. Reply with a short 'ok' acknowledgement.",
            },
            {"role": "user", "content": "Ping"},
        ]
        payload = {
            "model": self.model,
            "messages": health_prompt,
            "temperature": 0.0,
            "stream": False,
            "max_tokens": 4,
        }
        try:
            _, latency_ms = await self._post(payload)
            return "online", None, latency_ms
        except AgentClientError as exc:
            return "offline", str(exc), None

    async def _post_for_content(self, payload: dict) -> Tuple[str, float]:
        data, latency_ms = await self._post(payload)
        try:
            message = (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
                .strip()
            )
        except (KeyError, IndexError, AttributeError):  # pragma: no cover - defensive
            message = ""
        if not message:
            raise AgentClientError("Terrarium agent returned an empty response")
        return message, latency_ms

    async def _post(self, payload: dict) -> Tuple[dict, float]:
        try:
            start = perf_counter()
            response = await self._client.post(self.api_url, json=payload)
            latency_ms = (perf_counter() - start) * 1000
            response.raise_for_status()
            return response.json(), latency_ms
        except HTTPStatusError as exc:
            logger.error("Agent HTTP error: %s", exc)
            raise AgentClientError(f"Agent returned HTTP {exc.response.status_code}") from exc
        except RequestError as exc:
            logger.error("Agent request failed: %s", exc)
            raise AgentClientError(str(exc)) from exc
