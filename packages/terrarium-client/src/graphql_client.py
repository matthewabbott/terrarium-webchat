"""HTTP client for interacting with the GraphQL relay."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

OPEN_CHATS_QUERY = """
query WorkerOpenChats {
  openChats {
    id
    mode
    status
    createdAt
    updatedAt
  }
}
"""

MESSAGES_QUERY = """
query WorkerMessages($chatId: ID!) {
  messages(chatId: $chatId) {
    id
    chatId
    sender
    content
    createdAt
  }
}
"""

POST_AGENT_MESSAGE_MUTATION = """
mutation PostAgentMessage($chatId: ID!, $content: String!) {
  postAgentMessage(chatId: $chatId, content: $content) {
    id
    chatId
    sender
    content
    createdAt
  }
}
"""


class GraphQLClient:
    def __init__(self, *, graphql_url: str, service_token: str) -> None:
        self.graphql_url = graphql_url
        self.service_token = service_token
        self._client = httpx.AsyncClient(timeout=15)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "GraphQLClient":
        return self

    async def __aexit__(self, *_exc_info) -> None:
        await self.close()

    async def execute(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        response = await self._client.post(
            self.graphql_url,
            json={"query": query, "variables": variables},
            headers=self._headers,
        )
        response.raise_for_status()
        payload = response.json()
        if "errors" in payload:
            raise RuntimeError(f"GraphQL error: {payload['errors']}")
        return payload["data"]

    async def ping(self) -> None:
        await self.execute("query Health { _health }")

    async def fetch_open_chats(self) -> List[Dict[str, Any]]:
        data = await self.execute(OPEN_CHATS_QUERY)
        return data.get("openChats", [])

    async def fetch_messages(self, chat_id: str) -> List[Dict[str, Any]]:
        data = await self.execute(MESSAGES_QUERY, {"chatId": chat_id})
        return data.get("messages", [])

    async def post_agent_message(self, chat_id: str, content: str) -> Dict[str, Any]:
        data = await self.execute(POST_AGENT_MESSAGE_MUTATION, {"chatId": chat_id, "content": content})
        return data["postAgentMessage"]

    @property
    def _headers(self) -> Dict[str, str]:
        return {"x-service-token": self.service_token}
