# @terrarium/webchat-client

Outbound worker that runs on the Terra machine. It polls the REST relay for gated chats, forwards visitor messages to terrarium-agent, and publishes Terra's responses back via the `/api/chat/:chatId/agent` endpoint.

## Setup
1. Install Poetry (or use the Dockerfile).
2. Copy `.env.example` to `.env` and update credentials (`API_BASE_URL`, `SERVICE_TOKEN`, `AGENT_API_URL`). Point `API_BASE_URL` at the nginx prefix, e.g. `https://mbabbott.com/terrarium`.
3. `poetry install`
4. `poetry run python -m src.main`
