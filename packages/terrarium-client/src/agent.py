"""Simple client for terrarium-agent's OpenAI-compatible API."""

from __future__ import annotations

import logging
from typing import List

import httpx

from .context import Conversation

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "You are Terra, Matthew Abbott's personal website guide. Provide concise, helpful answers about "
    "his work, experience, and the content visitors can find on mbabbott.com."
)


class AgentClient:
    def __init__(self, *, api_url: str, model: str, timeout_seconds: float = 60.0, system_prompt: str = DEFAULT_SYSTEM_PROMPT) -> None:
        self.api_url = api_url
        self.model = model
        self.system_prompt = system_prompt
        self._client = httpx.AsyncClient(timeout=timeout_seconds)

    async def close(self) -> None:
        await self._client.aclose()

    async def generate(self, conversation: Conversation) -> str:
        messages = conversation.to_prompt_messages(system_prompt=self.system_prompt, max_turns=16)
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
            "stream": False,
        }
        try:
            response = await self._client.post(self.api_url, json=payload)
            response.raise_for_status()
            data = response.json()
            return (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "I am unable to respond right now, please try again later.")
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Agent call failed: %s", exc)
            return "I had trouble talking to Terra's core service. Please try again in a moment."
