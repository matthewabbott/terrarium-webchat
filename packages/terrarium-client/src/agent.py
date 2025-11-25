"""Simple client for terrarium-agent's OpenAI-compatible API."""

from __future__ import annotations

import asyncio
import json
import logging
import random
from time import perf_counter, time
from typing import Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse, urlunparse

import httpx
from httpx import HTTPStatusError, RequestError, TimeoutException

from .context import Conversation

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = """\
You are Terra-webchat (Terra), the mbabbott.com chat widget.

"""


class AgentClientError(Exception):
    """Raised when terrarium-agent does not return a usable response."""

    def __init__(self, message: str, *, category: str = "unknown") -> None:
        super().__init__(message)
        self.category = category


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
        max_retries: int = 3,
        circuit_breaker_failures: int = 3,
        circuit_breaker_cooldown: float = 10.0,
    ) -> None:
        self.api_url = api_url
        self.model = model
        self.system_prompt = system_prompt
        self.health_url = health_url or _derive_health_url(api_url)
        self._client = httpx.AsyncClient(timeout=timeout_seconds)
        self._max_retries = max(1, max_retries)
        self._circuit_failures = circuit_breaker_failures
        self._circuit_cooldown = circuit_breaker_cooldown
        self._consecutive_failures = 0
        self._circuit_open_until: Optional[float] = None

    async def close(self) -> None:
        await self._client.aclose()

    async def chat(
        self,
        *,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        temperature: float = 0.7,
        max_tokens: Optional[int] = None,
        stream: bool = False,
        on_chunk: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> Tuple[Dict, float]:
        payload: Dict[str, object] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if stream:
            return await self._stream(payload, on_chunk)
        return await self._post(payload)

    async def generate(self, conversation: Conversation) -> Tuple[str, float]:
        messages = conversation.to_prompt_messages(system_prompt=self.system_prompt, max_turns=16)
        response, latency_ms = await self.chat(messages=messages)
        message = response.get("content", "")
        if not message:
            raise AgentClientError("Terrarium agent returned an empty response")
        return message, latency_ms

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
        async def send() -> Tuple[dict, float]:
            start = perf_counter()
            response = await self._client.post(self.api_url, json=payload)
            latency_ms = (perf_counter() - start) * 1000
            response.raise_for_status()
            return response.json(), latency_ms

        return await self._execute_with_retries(send)

    async def _stream(
        self,
        payload: dict,
        on_chunk: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> Tuple[Dict, float]:
        async def stream_once() -> Tuple[Dict, float]:
            start = perf_counter()
            content_parts: List[str] = []
            tool_calls: List[Dict] = []

            async with self._client.stream("POST", self.api_url, json=payload) as response:
                try:
                    response.raise_for_status()
                except HTTPStatusError as exc:
                    logger.error("Agent stream HTTP error: %s", exc)
                    raise AgentClientError(
                        f"Agent returned HTTP {exc.response.status_code}", category="http_error"
                    ) from exc

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = parsed.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if delta.get("content"):
                        content_parts.append(delta["content"])
                        if on_chunk:
                            await on_chunk(delta["content"])
                    if delta.get("tool_calls"):
                        for call in delta["tool_calls"]:
                            existing = next((c for c in tool_calls if c.get("id") == call.get("id")), None)
                            if existing:
                                existing_fn = existing.setdefault("function", {})
                                delta_fn = call.get("function", {})
                                if "arguments" in delta_fn:
                                    existing_fn["arguments"] = existing_fn.get("arguments", "") + delta_fn["arguments"]
                            else:
                                tool_calls.append(call)

            latency_ms = (perf_counter() - start) * 1000
            message: Dict[str, object] = {"role": "assistant", "content": "".join(content_parts)}
            if tool_calls:
                message["tool_calls"] = tool_calls
            return message, latency_ms

        return await self._execute_with_retries(stream_once, is_stream=True)

    async def _execute_with_retries(
        self,
        func: Callable[[], Awaitable[Tuple[Dict, float]]],
        *,
        is_stream: bool = False,
    ) -> Tuple[Dict, float]:
        now = time()
        if self._circuit_open_until and now < self._circuit_open_until:
            raise AgentClientError("Agent circuit is open; backing off", category="circuit_open")
        for attempt in range(self._max_retries):
            try:
                result = await func()
                self._consecutive_failures = 0
                self._circuit_open_until = None
                return result
            except AgentClientError as exc:
                retryable = exc.category in {"timeout", "network", "server_error"}
                if not retryable or attempt == self._max_retries - 1:
                    self._record_failure()
                    raise
                self._record_failure()
                backoff = min(2 ** attempt, 8) + random.random()
                logger.warning(
                    "Agent %s attempt %d/%d failed (%s); backing off %.1fs",
                    "stream" if is_stream else "request",
                    attempt + 1,
                    self._max_retries,
                    exc.category,
                    backoff,
                )
                await asyncio.sleep(backoff)
            except HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else 0
                if status == 401:
                    category = "auth"
                elif status >= 500:
                    category = "server_error"
                else:
                    category = "http_error"
                self._record_failure()
                raise AgentClientError(f"Agent returned HTTP {status}", category=category) from exc
            except TimeoutException as exc:
                self._record_failure()
                if attempt == self._max_retries - 1:
                    raise AgentClientError("Agent request timed out", category="timeout") from exc
                backoff = min(2 ** attempt, 8) + random.random()
                logger.warning("Agent timeout; retrying in %.1fs", backoff)
                await asyncio.sleep(backoff)
            except RequestError as exc:
                self._record_failure()
                if attempt == self._max_retries - 1:
                    raise AgentClientError(str(exc), category="network") from exc
                backoff = min(2 ** attempt, 8) + random.random()
                logger.warning("Agent network error; retrying in %.1fs", backoff)
                await asyncio.sleep(backoff)

        raise AgentClientError("Agent retries exhausted", category="unknown")

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._circuit_failures:
            self._circuit_open_until = time() + self._circuit_cooldown
            logger.warning(
                "Agent circuit opened for %.1fs after %d consecutive failures",
                self._circuit_cooldown,
                self._consecutive_failures,
            )
