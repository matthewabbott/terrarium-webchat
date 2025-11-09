"""Entry point for the terrarium webchat worker.

This scaffold just validates environment configuration and prints
placeholder logs. Flesh it out with the subscription + tool loop
outlined in DESIGN.md.
"""

from __future__ import annotations

import asyncio
import os
from typing import Final

from rich.console import Console

from .graphql_client import GraphQLClient

console: Final = Console()


async def main() -> None:
    graphql_url = os.environ.get("GRAPHQL_URL")
    service_token = os.environ.get("SERVICE_TOKEN")

    if not graphql_url or not service_token:
        raise RuntimeError("GRAPHQL_URL and SERVICE_TOKEN must be set")

    client = GraphQLClient(graphql_url=graphql_url, service_token=service_token)
    console.print(
        f"[bold cyan]terrarium-webchat worker[/] watching {graphql_url} (token: {service_token[:4]}…)",
    )
    await client.ping()


if __name__ == "__main__":
    asyncio.run(main())
