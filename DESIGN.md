# terrarium-webchat Design & TODOs

## Context
- `terrarium-agent` (~/Programming/terrarium-agent) hosts Terra behind an OpenAI-compatible HTTP API with tool support, session storage, and persona configs. It expects clients to manage conversation state and simply exposes `/v1/chat/completions` + tool definitions.
- `terrarium-irc` (~/Programming/terrarium-irc) is the reference harness: it owns context management per IRC channel, persists chat logs to SQLite, and exposes IRC-specific tools (`search_chat_logs`, `get_current_users`, enhancement request file writer, etc.).
- `terrarium-webchat` must become another harness (“web tendril”) that plugs into the same agent while speaking to a public-facing VPS without opening inbound access to the Terra machine. The VPS now runs an Express + WebSocket relay rather than GraphQL/Yoga to keep things simple.

## Goals
1. Publish a password-gated chat widget on mbabbott.com that relays visitor messages to Terra in near real time.
2. Keep Terra’s machine outbound-only: the local worker polls the VPS REST API and pushes responses back via a service-token-protected endpoint.
3. Maintain per-visitor conversation memory (similar to per-channel history in terrarium-irc) plus curated website context so Terra can answer portfolio questions.
4. Optional stretch: allow visitors to BYO API keys and run the same UI against external models, isolated from Terra’s infrastructure.
5. Mirror terrarium-irc’s tool ergonomics (context search, enhancement requests) while adding web-specific tools (static site content, resume files, etc.).

## High-Level Architecture
```
Visitor Browser (mbabbott.com)
    |  HTTPS + WS (/api/chat)
    v
VPS relay (Express + ws, password gated)
    ^                              \
    | REST (service token)          \__ Outbound only
    |                                  \
Terrarium worker (Python)  ----->  terrarium-agent HTTP API -> vLLM
```
- The relay tracks chat rooms in memory, enforces password gating, exposes a WebSocket stream per chat, and provides REST endpoints for visitors (`/api/chat/:chatId/messages`) and the worker (`/api/chats/open`, `/api/chat/:chatId/agent`).
- The worker authenticates with a service token, polls for open chats, assembles prompts using terrarium-agent config, and posts replies via `/api/chat/:chatId/agent`.
- Content tooling: worker mounts curated files (resume, project blurbs) and uses terrarium-agent tool definitions so Terra can fetch structured data.

## Component Notes
### 1. Web Frontend (mbabbott.com / `packages/web-frontend`)
- Vite/React single page at `/terra`. Stores `chatId` + access code in `sessionStorage` so refreshes keep context.
- Calls REST endpoints instead of GraphQL, and opens a `WS_BASE/api/chat?chatId=…` socket for live updates.
- Handles retries, optimistic acknowledgements, typing indicator, and mobile-ready auto-resizing composer.
- BYO model mode (future): UX stays local, but requests could hit a different backend path.

### 2. VPS Relay (Express + ws / `packages/vps-server`)
- Minimal in-memory store for chats + messages (sufficient for low-traffic demo). TTL pruning can be added later.
- Routes today:
  - `POST /api/chat/:chatId/messages` – visitor message; access code required in body.
  - `GET /api/chat/:chatId/messages` – returns history for visitors (access code) or worker (service token header).
  - `GET /api/chats/open` – worker-only list of chat IDs to service.
  - `POST /api/chat/:chatId/agent` – worker posts Terra replies (service token).
  - `WS /api/chat` – query params `chatId` + `accessCode`; streams JSON messages as they arrive.
- Security knobs: access code, service token, nginx rate limiting, optional captcha. Future features include persistence (SQLite/Redis) and per-IP throttles.

### 3. Terrarium Worker (`packages/terrarium-client`)
- Python + Poetry so it can reuse terrarium-irc utilities.
- Polls `/api/chats/open`, hydrates message history, feeds context into terrarium-agent, and posts responses via the agent endpoint.
- Maintains `Conversation` instances per chat for trimming + dedupe, and tracks processed visitor message IDs to avoid duplicate replies.
- Future: add long-polling or WebSocket client if we want to push events instead of polling; add tool execution (read site pages, search docs, enhancement logging, etc.).

### 4. Content Curation & Tooling
- Maintain a `content/` directory inside this repo containing markdown exports of resume, portfolio highlights, FAQ, etc.
- Provide Python helper to load these docs into embeddings or simple search indexes consumed by tools.
- Optionally add a `web_nav` tool that fetches live mbabbott.com pages via HTTP (respecting rate limits) to answer up-to-date questions.

### 5. Optional BYO Model Path
- Frontend toggles “Use Terra” vs “Bring your own model”.
- For BYO: relay acts as a thin proxy that forwards OpenAI-compatible calls to third-party providers. Terra worker ignores these chats entirely.
- Rate-limit and time out external requests to avoid draining VPS resources; stream responses to client as they arrive.

## TODO Backlog
| Priority | Area | Task |
|---------|------|------|
| P0 | Documentation | Finish updating DEPLOYMENT/README with REST relay setup + nginx notes. |
| P0 | VPS Server | Add persistence + TTL pruning to the in-memory store; add structured logging + request metrics. |
| P0 | Terrarium Worker | Port terrarium-irc context tooling, add retry/backoff for REST calls, and support tool execution returned by terrarium-agent. |
| P0 | Frontend | Hook up real content tools once worker supports them; add BYO mode switch for future experiments. |
| P1 | Worker → Agent Bridge | Implement OpenAI-compatible streaming and tool loop (can import from terrarium-irc’s `llm/agent_client.py`). |
| P1 | Content Tools | Create curated `content/` bundle and implement `read_site_page` & `search_feature_docs` tool handlers. |
| P1 | Persistence | Decide on lightweight storage (SQLite or Redis) for chat metadata on VPS; add retention + pruning jobs. |
| P1 | Access Control | Add rate limiting + CAPTCHA hook to relay; rotate access code regularly. |
| P2 | Observability | Add structured logging and metrics (request latency, active chats) to relay and worker; surface alerts if worker disconnects. |
| P2 | BYO Models | Implement BYO endpoint in relay + UI toggle; manage provider secrets per session. |
| P2 | UX Enhancements | Support downloadable transcripts, shareable links, transcripts emailed to visitors. |
| P3 | Automation | GitHub Actions for lint/test per workspace and deployment scripts for VPS/worker. |
| P3 | Knowledge Updates | Automate syncing mbabbott.com source files into worker content bundle (e.g., nightly rsync or git submodule). |

## Testing Strategy
- **Unit**: Vitest (or Jest) + supertest for Express routes, pytest for worker tool handlers, Vitest for React components.
- **Integration**: docker-compose stack locally (relay + worker + mocked agent) to validate REST/WebSocket flow and password gating.
- **End-to-End**: Playwright test hitting local Vite dev server with stubbed REST responses and worker echoing via test harness.
- **Load/Resilience**: Simulate multiple chats to ensure worker queues requests, relay handles reconnects, and WebSocket fan-out stays healthy under a couple hundred connections.

## Deployment Status & Next Actions (Nov 10, 2025)
- **VPS**: Express relay deployed via PM2 (`terrarium-rest-chat`) on port 4100, reverse proxied at `/terrarium/chat` + WebSocket upgrades handled by nginx. Frontend bundle deployed to `/var/www/html/terra` with terra-themed styling.
- **Worker**: Python service polls `https://mbabbott.com/api/chats/open` (via `API_BASE_URL`) using `SERVICE_TOKEN=super-secret-service-token`; responses forwarded to terrarium-agent at `http://127.0.0.1:8080/v1/chat/completions`.
- **Remaining polish**:
  1. Add persistence + TTL to relay store before inviting more traffic.
  2. Harden nginx config (rate limits / headers) and document rotation of access/service tokens.
  3. Flesh out deployment docs so the DGX host + VPS steps match the new REST flow (WIP in `DEPLOYMENT.md`).
  4. Backfill automated tests for the new server + UI flows.
