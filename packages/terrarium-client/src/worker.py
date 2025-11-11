"""Polling worker that bridges visitor chats to terrarium-agent."""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, List

from .agent import AgentClient
from .context import Conversation
from .relay_client import RelayClient

logger = logging.getLogger(__name__)


class TerrariumWorker:
    def __init__(
        self,
        *,
        relay: RelayClient,
        agent: AgentClient,
        poll_interval: float = 2.0,
        max_turns: int = 16,
    ) -> None:
        self.relay = relay
        self.agent = agent
        self.poll_interval = poll_interval
        self.max_turns = max_turns
        self._conversations: Dict[str, Conversation] = {}
        self._processed_message_ids: set[str] = set()

    async def run_forever(self) -> None:
        logger.info("Worker started with poll interval %.1fs", self.poll_interval)
        while True:
            try:
                await self.tick()
            except Exception as exc:  # noqa: BLE001
                logger.exception("Worker tick failed: %s", exc)
            await asyncio.sleep(self.poll_interval)

    async def tick(self) -> None:
        chats = await self.relay.fetch_open_chats()
        for chat in chats:
            chat_id = chat["id"]
            conversation = self._conversations.setdefault(chat_id, Conversation(chat_id=chat_id))
            await self._sync_chat(conversation)

    async def _sync_chat(self, conversation: Conversation) -> None:
        messages = await self.relay.fetch_messages(conversation.chat_id)
        sorted_messages = sorted(messages, key=lambda msg: msg["createdAt"])
        for message in sorted_messages:
            role = 'user' if message["sender"] == "Visitor" else 'assistant'
            conversation.ingest(role=role, content=message["content"], message_id=message["id"])

        pending = [msg for msg in sorted_messages if msg["sender"] == "Visitor" and msg["id"] not in self._processed_message_ids]
        for visitor_message in pending:
            await self._handle_visitor_message(conversation, visitor_message)
            self._processed_message_ids.add(visitor_message["id"])

    async def _handle_visitor_message(self, conversation: Conversation, message: Dict[str, str]) -> None:
        logger.info("Processing message %s for chat %s", message["id"], conversation.chat_id)
        conversation.prune(self.max_turns)
        response = await self.agent.generate(conversation)
        conversation.add_turn("assistant", response)
        await self.relay.post_agent_message(conversation.chat_id, response)
