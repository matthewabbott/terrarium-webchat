# @terrarium/webchat-client

Outbound worker that runs on the Terra machine. It polls the REST relay for gated chats, forwards visitor messages to terrarium-agent, and publishes Terra's responses back via the `/api/chat/:chatId/agent` endpoint. It now supports tool calls + streaming so the web UI can show “thinking” updates while Terra works.

## Setup
1. Install Poetry (or use the Dockerfile).
2. Copy `.env.example` to `.env` and update credentials (`API_BASE_URL`, `SERVICE_TOKEN`, `AGENT_API_URL`). Optionally set `AGENT_HEALTH_URL` if the terrarium-agent health probe lives somewhere other than `<AGENT_API_URL before /v1>/health`, tune `STATUS_POLL_INTERVAL_SECONDS` / `LLM_STATUS_POLL_INTERVAL_SECONDS` as needed, and point `WORKER_WS_URL` (defaults to `<API_BASE_URL> -> ws://…/api/worker/updates`) at the relay’s new worker WebSocket.
3. `poetry install`
4. `poetry run python -m src.main`

The worker now pings terrarium-agent on a timer (fast HTTP probe + slower LLM inference probe) and POSTs those results back to the relay via `/api/worker/status`. The web UI uses that feed to highlight which hop in the Terra chain is unhealthy before a visitor ever sends a message. It also maintains a long-lived WebSocket connection to `/api/worker/updates`, so visitor messages wake the worker immediately without waiting for the next poll tick, and it updates `/api/chat/:chatId/worker-state` whenever a chat is queued, processing, or hits an error so the frontend can surface clear “Terra is thinking…” copy per chat.

### Tools + content
- Tool definitions live in `src/tools.py` (site map, page fetch, site search, bio, projects, web search placeholder).
- Populate cached site content under `content/` (e.g., markdown/HTML exports) and optional `projects.json`/`site_map.json` for richer results.
- The system prompt is in `src/prompt.py` and is loaded automatically by the worker.
- Configure web search by setting `SEARCH_API_URL` (e.g., a SearxNG `/search?format=json` endpoint) and optional `SEARCH_API_KEY`.
