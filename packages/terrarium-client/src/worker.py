"""Polling worker that bridges visitor chats to terrarium-agent."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional

from websockets.client import connect as ws_connect

from .agent import AgentClient, AgentClientError
from .context import Conversation
from .relay_client import RelayClient
from .tools import TOOL_DEFINITIONS, ToolExecutor
from .prompt import WEBCHAT_SYSTEM_PROMPT
from .status import ComponentStatus, WorkerStatusReport

logger = logging.getLogger(__name__)


class ChatLogger:
    """Append-only JSONL logger for chat events."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def log(self, chat_id: str, event_type: str, payload: Dict) -> None:
        record = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "chatId": chat_id,
            "type": event_type,
            "payload": payload,
        }
        try:
            path = self.root / f"{chat_id}.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False)
                handle.write("\n")
        except Exception as exc:  # noqa: BLE001
            logger.debug("Unable to write chat log entry: %s", exc)


class TerrariumWorker:
    def __init__(
        self,
        *,
        relay: RelayClient,
        agent: AgentClient,
        poll_interval: float = 2.0,
        poll_while_ws_connected: bool = True,
        chat_log_dir: str = "chat-logs",
        max_turns: int = 16,
        max_tool_iterations: int = 8,
        status_probe_interval: float = 30.0,
        llm_probe_interval: float = 180.0,
        worker_updates_url: Optional[str] = None,
        worker_ws_retry: float = 5.0,
        ) -> None:
        self.relay = relay
        self.agent = agent
        self.poll_interval = poll_interval
        self.poll_while_ws_connected = poll_while_ws_connected
        self.max_turns = max_turns
        self.max_tool_iterations = max_tool_iterations
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
        self._tool_executor = ToolExecutor()
        self._ws_connected: bool = False
        self._logger = ChatLogger(Path(chat_log_dir))

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
        if self._ws_connected and not self.poll_while_ws_connected:
            logger.debug("Skipping poll; worker updates WebSocket is connected")
            return
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
        self._logger.log(
            conversation.chat_id,
            "visitor_message",
            {"id": message["id"], "content": message.get("content", ""), "createdAt": message.get("createdAt")},
        )
        conversation.prune(self.max_turns)
        await self._update_worker_state(conversation.chat_id, "processing")
        worker_state = "responded"
        worker_state_detail: Optional[str] = None
        try:
            response, latency_ms = await self._run_tool_loop(conversation)
            self._llm_status.mark(
                "online",
                detail="Responded to visitor message",
                latency_ms=latency_ms,
            )
        except AgentClientError as exc:
            logger.error("Agent generate failed: %s", exc)
            self._llm_status.mark("offline", detail=str(exc))
            response = "I had trouble talking to Terra's core service. Please try again shortly."
            worker_state = "error"
            worker_state_detail = str(exc)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected error while generating a response: %s", exc)
            self._llm_status.mark("offline", detail=str(exc))
            response = "Terra hit an unexpected issue. Please try again in a moment."
            worker_state = "error"
            worker_state_detail = str(exc)
        conversation.add_turn("assistant", response)
        await self.relay.post_agent_message(conversation.chat_id, response)
        await self._publish_chunk(conversation.chat_id, "", done=True)
        await self._update_worker_state(conversation.chat_id, worker_state, worker_state_detail)
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
                    self._ws_connected = True
                    logger.info("Connected to worker updates stream at %s", self.worker_updates_url)
                    async for raw in websocket:
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Ignoring invalid worker event payload")
                            continue
                        if payload.get("type") == "chat_activity":
                            chat_id = payload.get("chatId")
                            if isinstance(chat_id, str):
                                logger.debug("Received chat activity event for chat %s", chat_id)
                                self._enqueue_chat(chat_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Worker updates stream error: %s", exc)
                await asyncio.sleep(self.worker_ws_retry)
            finally:
                self._ws_connected = False
                logger.info("Worker updates stream disconnected; will retry in %.1fs", self.worker_ws_retry)

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

    async def _update_worker_state(
        self,
        chat_id: str,
        state: str,
        detail: Optional[str] = None,
    ) -> None:
        self._logger.log(chat_id, "worker_state", {"state": state, "detail": detail})
        try:
            await self.relay.post_worker_state(chat_id, state, detail)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Unable to update worker state: %s", exc)

    async def _run_tool_loop(self, conversation: Conversation) -> tuple[str, float]:
        messages = conversation.to_prompt_messages(system_prompt=self.agent.system_prompt, max_turns=self.max_turns)
        last_latency_ms = 0.0

        async def on_chunk(chunk: str) -> None:
            await self._publish_chunk(conversation.chat_id, chunk, done=False)

        for iteration in range(self.max_tool_iterations):
            response_message, latency_ms = await self.agent.chat(
                messages=messages,
                tools=TOOL_DEFINITIONS,
                stream=True,
                on_chunk=on_chunk,
            )
            last_latency_ms = latency_ms
            tool_calls = response_message.get("tool_calls") or []
            if tool_calls:
                # Save assistant turn (tool calls may not have content)
                conversation.add_turn("assistant", response_message.get("content", ""))
                if tool_calls:
                    self._logger.log(
                        conversation.chat_id,
                        "tool_calls",
                        {
                            "iteration": iteration,
                            "tool_calls": tool_calls,
                        },
                    )
                messages.append(response_message)
                for call in tool_calls:
                    tool_name = call.get("function", {}).get("name", "")
                    args_raw = call.get("function", {}).get("arguments", "") or "{}"
                    tool_id = call.get("id") or "tool_call"
                    try:
                        args = json.loads(args_raw)
                    except json.JSONDecodeError:
                        args = {}
                    result = await self._tool_executor.execute(tool_name, args)
                    tool_result_message = {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "name": tool_name,
                        "content": result,
                    }
                    self._logger.log(
                        conversation.chat_id,
                        "tool_result",
                        {"tool_call_id": tool_id, "name": tool_name, "arguments": args, "result": result},
                    )
                    messages.append(tool_result_message)
                    conversation.add_turn("tool", result)
                continue

            content = response_message.get("content", "") or ""
            if not content:
                raise AgentClientError("Terrarium agent returned an empty response")
            self._logger.log(
                conversation.chat_id,
                "assistant_message",
                {
                    "content": content,
                    "latency_ms": last_latency_ms,
                    "iterations": iteration + 1,
                },
            )
            return content, last_latency_ms

        raise AgentClientError("Reached max tool iterations without a response")

    async def _publish_chunk(self, chat_id: str, content: str, *, done: bool) -> None:
        if not content and not done:
            return
        try:
            if content:
                self._logger.log(
                    chat_id,
                    "assistant_chunk",
                    {"content": content, "done": done},
                )
            await self.relay.post_agent_chunk(chat_id, content=content, done=done)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Unable to publish chunk for chat %s: %s", chat_id, exc)
