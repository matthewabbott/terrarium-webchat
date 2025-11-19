"""Polling worker that bridges visitor chats to terrarium-agent."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import suppress
from datetime import datetime, timedelta
from typing import Dict, Optional

from websockets.client import connect as ws_connect

from .agent import AgentClient, AgentClientError
from .context import Conversation
from .relay_client import RelayClient
from .status import ComponentStatus, WorkerStatusReport

logger = logging.getLogger(__name__)


class TerrariumWorker:
    def __init__(
        self,
        *,
        relay: RelayClient,
        agent: AgentClient,
        poll_interval: float = 2.0,
        max_turns: int = 16,
        status_probe_interval: float = 30.0,
        llm_probe_interval: float = 180.0,
        worker_updates_url: Optional[str] = None,
        worker_ws_retry: float = 5.0,
    ) -> None:
        self.relay = relay
        self.agent = agent
        self.poll_interval = poll_interval
        self.max_turns = max_turns
        self.status_probe_interval = status_probe_interval
        self.llm_probe_interval = llm_probe_interval
        self.worker_updates_url = worker_updates_url
        self.worker_ws_retry = worker_ws_retry
        self._conversations: Dict[str, Conversation] = {}
        self._processed_message_ids: set[str] = set()
        self._agent_api_status = ComponentStatus()
        self._llm_status = ComponentStatus()
        self._status_task: Optional[asyncio.Task[None]] = None
        self._worker_updates_task: Optional[asyncio.Task[None]] = None
        self._queue_worker: Optional[asyncio.Task[None]] = None
        self._chat_queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending_chat_ids: set[str] = set()

    async def run_forever(self) -> None:
        logger.info("Worker started with poll interval %.1fs", self.poll_interval)
        self._status_task = asyncio.create_task(self._status_probe_loop())
        self._queue_worker = asyncio.create_task(self._chat_queue_worker())
        if self.worker_updates_url:
            self._worker_updates_task = asyncio.create_task(self._worker_updates_loop())
        try:
            while True:
                try:
                    await self.tick()
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Worker tick failed: %s", exc)
                await asyncio.sleep(self.poll_interval)
        finally:
            tasks = [self._status_task, self._queue_worker, self._worker_updates_task]
            for task in tasks:
                if task is None:
                    continue
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    async def tick(self) -> None:
        chats = await self.relay.fetch_open_chats()
        for chat in chats:
            self._enqueue_chat(chat["id"])

    async def _process_chat(self, chat_id: str) -> None:
        conversation = self._conversations.setdefault(chat_id, Conversation(chat_id=chat_id))
        await self._sync_chat(conversation)

    async def _sync_chat(self, conversation: Conversation) -> None:
        messages = await self.relay.fetch_messages(conversation.chat_id)
        sorted_messages = sorted(messages, key=lambda msg: msg["createdAt"])
        for message in sorted_messages:
            role = 'user' if message["sender"] == "Visitor" else 'assistant'
            conversation.ingest(role=role, content=message["content"], message_id=message["id"])

        pending = [
            msg
            for msg in sorted_messages
            if msg["sender"] == "Visitor" and msg["id"] not in self._processed_message_ids
        ]
        for visitor_message in pending:
            await self._handle_visitor_message(conversation, visitor_message)
            self._processed_message_ids.add(visitor_message["id"])

    async def _handle_visitor_message(
        self,
        conversation: Conversation,
        message: Dict[str, str],
    ) -> None:
        logger.info("Processing message %s for chat %s", message["id"], conversation.chat_id)
        conversation.prune(self.max_turns)
        try:
            response, latency_ms = await self.agent.generate(conversation)
            self._llm_status.mark(
                "online",
                detail="Responded to visitor message",
                latency_ms=latency_ms,
            )
        except AgentClientError as exc:
            logger.error("Agent generate failed: %s", exc)
            self._llm_status.mark("offline", detail=str(exc))
            response = "I had trouble talking to Terra's core service. Please try again shortly."
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error while generating a response: %s", exc)
            self._llm_status.mark("offline", detail=str(exc))
            response = "Terra hit an unexpected issue. Please try again in a moment."
        conversation.add_turn("assistant", response)
        await self.relay.post_agent_message(conversation.chat_id, response)
        await self._publish_status()

    def _enqueue_chat(self, chat_id: str) -> None:
        if chat_id in self._pending_chat_ids:
            return
        self._pending_chat_ids.add(chat_id)
        self._chat_queue.put_nowait(chat_id)

    async def _chat_queue_worker(self) -> None:
        while True:
            chat_id = await self._chat_queue.get()
            try:
                await self._process_chat(chat_id)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Queue worker failed for chat %s: %s", chat_id, exc)
            finally:
                self._pending_chat_ids.discard(chat_id)
                self._chat_queue.task_done()

    async def _worker_updates_loop(self) -> None:
        assert self.worker_updates_url is not None
        headers = [("x-service-token", self.relay.service_token)]
        while True:
            try:
                async with ws_connect(self.worker_updates_url, extra_headers=headers) as websocket:
                    logger.info("Connected to worker updates stream")
                    async for raw in websocket:
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Ignoring invalid worker event payload")
                            continue
                        if payload.get("type") == "chat_activity":
                            chat_id = payload.get("chatId")
                            if isinstance(chat_id, str):
                                self._enqueue_chat(chat_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Worker updates stream error: %s", exc)
                await asyncio.sleep(self.worker_ws_retry)

    async def _status_probe_loop(self) -> None:
        try:
            while True:
                try:
                    await self._probe_agent_api()
                    await self._maybe_probe_llm()
                    await self._publish_status()
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Status probe failed: %s", exc)
                await asyncio.sleep(self.status_probe_interval)
        except asyncio.CancelledError:  # pragma: no cover - cancellation path
            logger.info("Status probe loop cancelled")

    async def _probe_agent_api(self) -> None:
        status, detail = await self.agent.check_api_status()
        self._agent_api_status.mark(status, detail=detail)

    async def _maybe_probe_llm(self, force: bool = False) -> None:
        if not force and self._llm_status.checked_at is not None:
            elapsed = datetime.utcnow() - self._llm_status.checked_at
            if elapsed < timedelta(seconds=self.llm_probe_interval):
                return
        status, detail, latency_ms = await self.agent.probe_llm()
        self._llm_status.mark(status, detail=detail, latency_ms=latency_ms)

    async def _publish_status(self) -> None:
        report = WorkerStatusReport(agent_api=self._agent_api_status, llm=self._llm_status)
        try:
            await self.relay.post_worker_status(report)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Unable to publish worker status: %s", exc)
