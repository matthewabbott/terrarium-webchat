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
    agent_health_url: Optional[str]
    status_probe_interval: float
    llm_probe_interval: float
    worker_updates_url: str
    worker_ws_retry: float


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
    agent_health_url = os.environ.get("AGENT_HEALTH_URL")
    status_probe_interval = float(os.environ.get("STATUS_POLL_INTERVAL_SECONDS", "30"))
    llm_probe_interval = float(os.environ.get("LLM_STATUS_POLL_INTERVAL_SECONDS", "180"))
    worker_updates_url = os.environ.get("WORKER_WS_URL")
    worker_ws_retry = float(os.environ.get("WORKER_WS_RETRY_SECONDS", "5"))

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
        agent_health_url=agent_health_url,
        status_probe_interval=status_probe_interval,
        llm_probe_interval=llm_probe_interval,
        worker_updates_url=worker_updates_url or derive_worker_updates_url(api_base_url),
        worker_ws_retry=worker_ws_retry,
    )


async def main() -> None:
    settings = load_settings()
    console.print(f"[bold cyan]Terrarium webchat worker[/] connected to {settings.api_base_url}")

    async with RelayClient(
        api_base_url=settings.api_base_url,
        service_token=settings.service_token,
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
            status_probe_interval=settings.status_probe_interval,
            llm_probe_interval=settings.llm_probe_interval,
            worker_updates_url=settings.worker_updates_url,
            worker_ws_retry=settings.worker_ws_retry,
        )

        try:
            await worker.run_forever()
        finally:
            await agent_client.close()


if __name__ == "__main__":
    asyncio.run(main())
