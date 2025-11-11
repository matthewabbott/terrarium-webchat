"""Simple client for terrarium-agent's OpenAI-compatible API."""

from __future__ import annotations

import logging
from typing import List

import httpx

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
