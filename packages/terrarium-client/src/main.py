"""Entrypoint for the terrarium webchat worker."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass

from rich.console import Console

from .agent import AgentClient
from .relay_client import RelayClient
from .worker import TerrariumWorker

console = Console()
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


@dataclass
class Settings:
    api_base_url: str
    service_token: str
    agent_api_url: str
    agent_model: str
    poll_interval: float


def load_settings() -> Settings:
    api_base_url = os.environ.get("API_BASE_URL")
    service_token = os.environ.get("SERVICE_TOKEN")
    agent_api_url = os.environ.get("AGENT_API_URL")
    agent_model = os.environ.get("AGENT_MODEL", "terra-webchat")
    poll_interval = float(os.environ.get("POLL_INTERVAL_SECONDS", "2"))

    missing = [name for name, value in {"API_BASE_URL": api_base_url, "SERVICE_TOKEN": service_token, "AGENT_API_URL": agent_api_url}.items() if not value]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")

    return Settings(
        api_base_url=api_base_url,
        service_token=service_token,
        agent_api_url=agent_api_url,
        agent_model=agent_model,
        poll_interval=poll_interval,
    )


async def main() -> None:
    settings = load_settings()
    console.print(f"[bold cyan]Terrarium webchat worker[/] connected to {settings.api_base_url}")

    async with RelayClient(api_base_url=settings.api_base_url, service_token=settings.service_token) as relay_client:
        await relay_client.ping()
        agent_client = AgentClient(api_url=settings.agent_api_url, model=settings.agent_model)
        worker = TerrariumWorker(relay=relay_client, agent=agent_client, poll_interval=settings.poll_interval)

        try:
            await worker.run_forever()
        finally:
            await agent_client.close()


if __name__ == "__main__":
    asyncio.run(main())
