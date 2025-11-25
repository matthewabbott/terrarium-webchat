"""Entrypoint for the terrarium webchat worker."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse, urlunparse

from rich.console import Console

from .agent import AgentClient
from .relay_client import RelayClient
from .worker import TerrariumWorker
from .prompt import WEBCHAT_SYSTEM_PROMPT

console = Console()
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


@dataclass
class Settings:
    api_base_url: str
    service_token: str
    agent_api_url: str
    agent_model: str
    poll_interval: float
    poll_while_ws_connected: bool
    chat_log_dir: str
    log_assistant_chunks: bool
    agent_health_url: Optional[str]
    status_probe_interval: float
    llm_probe_interval: float
    worker_updates_url: str
    worker_ws_retry: float
    max_concurrent_chats: int
    max_chat_queue_size: int
    max_log_bytes: int
    hmac_enabled: bool
    hmac_secret: str
    hmac_max_skew_seconds: int


def derive_worker_updates_url(api_base_url: str) -> str:
    parsed = urlparse(api_base_url)
    scheme = 'wss' if parsed.scheme == 'https' else 'ws'
    base_path = parsed.path.rstrip('/')
    full_path = f"{base_path}/api/worker/updates"
    if not full_path.startswith('/'):
        full_path = '/' + full_path
    return urlunparse(parsed._replace(scheme=scheme, path=full_path, query='', fragment=''))


def load_settings() -> Settings:
    api_base_url = os.environ.get("API_BASE_URL")
    service_token = os.environ.get("SERVICE_TOKEN")
    agent_api_url = os.environ.get("AGENT_API_URL")
    agent_model = os.environ.get("AGENT_MODEL", "terra-webchat")
    poll_interval = float(os.environ.get("POLL_INTERVAL_SECONDS", "2"))
    poll_while_ws_connected = os.environ.get("POLL_WHILE_WS_CONNECTED", "true").lower() != "false"
    chat_log_dir = os.environ.get("CHAT_LOG_DIR", "chat-logs")
    log_assistant_chunks = os.environ.get("LOG_ASSISTANT_CHUNKS", "false").lower() == "true"
    agent_health_url = os.environ.get("AGENT_HEALTH_URL")
    status_probe_interval = float(os.environ.get("STATUS_POLL_INTERVAL_SECONDS", "30"))
    llm_probe_interval = float(os.environ.get("LLM_STATUS_POLL_INTERVAL_SECONDS", "180"))
    worker_updates_url = os.environ.get("WORKER_WS_URL")
    worker_ws_retry = float(os.environ.get("WORKER_WS_RETRY_SECONDS", "5"))
    max_concurrent_chats = int(os.environ.get("MAX_CONCURRENT_CHATS", "2"))
    max_chat_queue_size = int(os.environ.get("MAX_CHAT_QUEUE_SIZE", "200"))
    max_log_bytes = int(os.environ.get("MAX_LOG_BYTES", str(1_000_000_000)))
    hmac_enabled = (os.environ.get("HMAC_ENABLED") or "false").lower() == "true"
    hmac_secret = os.environ.get("HMAC_SECRET", "")
    hmac_max_skew_seconds = int(os.environ.get("HMAC_MAX_SKEW_SECONDS", "300"))

    missing = [
        name
        for name, value in {
            "API_BASE_URL": api_base_url,
            "SERVICE_TOKEN": service_token,
            "AGENT_API_URL": agent_api_url,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")

    return Settings(
        api_base_url=api_base_url,
        service_token=service_token,
        agent_api_url=agent_api_url,
        agent_model=agent_model,
        poll_interval=poll_interval,
        poll_while_ws_connected=poll_while_ws_connected,
        chat_log_dir=chat_log_dir,
        log_assistant_chunks=log_assistant_chunks,
        agent_health_url=agent_health_url,
        status_probe_interval=status_probe_interval,
        llm_probe_interval=llm_probe_interval,
        worker_updates_url=worker_updates_url or derive_worker_updates_url(api_base_url),
        worker_ws_retry=worker_ws_retry,
        max_concurrent_chats=max_concurrent_chats,
        max_chat_queue_size=max_chat_queue_size,
        max_log_bytes=max_log_bytes,
        hmac_enabled=hmac_enabled,
        hmac_secret=hmac_secret,
        hmac_max_skew_seconds=hmac_max_skew_seconds,
    )


async def main() -> None:
    settings = load_settings()
    console.print(f"[bold cyan]Terrarium webchat worker[/] connected to {settings.api_base_url}")

    async with RelayClient(
        api_base_url=settings.api_base_url,
        service_token=settings.service_token,
        hmac_secret=settings.hmac_secret,
        hmac_enabled=settings.hmac_enabled,
        hmac_max_skew_seconds=settings.hmac_max_skew_seconds,
    ) as relay_client:
        await relay_client.ping()
        agent_client = AgentClient(
            api_url=settings.agent_api_url,
            model=settings.agent_model,
            health_url=settings.agent_health_url,
            system_prompt=WEBCHAT_SYSTEM_PROMPT,
        )
        worker = TerrariumWorker(
            relay=relay_client,
            agent=agent_client,
            poll_interval=settings.poll_interval,
            poll_while_ws_connected=settings.poll_while_ws_connected,
            chat_log_dir=settings.chat_log_dir,
            log_assistant_chunks=settings.log_assistant_chunks,
            status_probe_interval=settings.status_probe_interval,
            llm_probe_interval=settings.llm_probe_interval,
            worker_updates_url=settings.worker_updates_url,
            worker_ws_retry=settings.worker_ws_retry,
            max_concurrent_chats=settings.max_concurrent_chats,
            max_queue_size=settings.max_chat_queue_size,
            chat_log_max_bytes=settings.max_log_bytes,
        )

        try:
            await worker.run_forever()
        finally:
            await agent_client.close()


if __name__ == "__main__":
    asyncio.run(main())
