# @terrarium/webchat-client

Outbound worker that runs on the Terra machine. It polls the REST relay for gated chats, forwards visitor messages to terrarium-agent, and publishes Terra's responses back via the `/api/chat/:chatId/agent` endpoint.

## Setup
1. Install Poetry (or use the Dockerfile).
2. Copy `.env.example` to `.env` and update credentials (`API_BASE_URL`, `SERVICE_TOKEN`, `AGENT_API_URL`). Optionally set `AGENT_HEALTH_URL` if the terrarium-agent health probe lives somewhere other than `<AGENT_API_URL before /v1>/health`, and tune `STATUS_POLL_INTERVAL_SECONDS` / `LLM_STATUS_POLL_INTERVAL_SECONDS` if you want faster or slower health checks.
3. `poetry install`
4. `poetry run python -m src.main`

The worker now pings terrarium-agent on a timer (fast HTTP probe + slower LLM inference probe) and POSTs those results back to the relay via `/api/worker/status`. The web UI uses that feed to highlight which hop in the Terra chain is unhealthy before a visitor ever sends a message.
