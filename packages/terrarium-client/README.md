# @terrarium/webchat-client

Outbound worker that runs on the Terra machine. It polls the GraphQL relay for gated chats, forwards visitor messages to terrarium-agent, and publishes Terra's responses back via `postAgentMessage`.

## Setup
1. Install Poetry (or use the Dockerfile).
2. Copy `.env.example` to `.env` and update credentials (`GRAPHQL_URL`, `SERVICE_TOKEN`, `AGENT_API_URL`).
3. `poetry install`
4. `poetry run python -m src.main`
