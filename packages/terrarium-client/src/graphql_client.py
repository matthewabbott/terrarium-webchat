"""Minimal HTTP client for the GraphQL relay.

Replace this with a subscription-aware client once the schema solidifies.
"""

from __future__ import annotations

import httpx


class GraphQLClient:
    def __init__(self, *, graphql_url: str, service_token: str) -> None:
        self.graphql_url = graphql_url
        self.service_token = service_token
        self._client = httpx.AsyncClient(timeout=10)

    async def ping(self) -> None:
        response = await self._client.post(
            self.graphql_url,
            json={"query": "query Health { _health }"},
            headers={"x-service-token": self.service_token},
        )
        response.raise_for_status()

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "GraphQLClient":
        return self

    async def __aexit__(self, *_exc_info) -> None:
        await self.close()
