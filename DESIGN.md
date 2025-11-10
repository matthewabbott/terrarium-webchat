# terrarium-webchat Design & TODOs

## Context
- `terrarium-agent` (~/Programming/terrarium-agent) hosts Terra behind an OpenAI-compatible HTTP API with tool support, session storage, and persona configs. It expects clients to manage conversation state and simply exposes `/v1/chat/completions` + tool definitions.
- `terrarium-irc` (~/Programming/terrarium-irc) is the reference harness: it owns context management per IRC channel, persists chat logs to SQLite, and exposes IRC-specific tools (`search_chat_logs`, `get_current_users`, enhancement request file writer, etc.).
- `terrarium-webchat` must become another harness (“web tendril”) that plugs into the same agent while speaking to a public-facing VPS (GraphQL relay + mbabbott.com widget) without opening inbound access to the Terra machine.

## Goals
1. Publish a password-gated chat widget on mbabbott.com that relays visitor messages to Terra in near real time.
2. Keep Terra’s machine outbound-only: the local worker subscribes to VPS events and pushes responses back via the GraphQL API.
3. Maintain per-visitor conversation memory (similar to per-channel history in terrarium-irc) plus curated website context so Terra can answer portfolio questions.
4. Optional stretch: allow visitors to BYO API keys and run the same UI against external models, isolated from Terra’s infrastructure.
5. Mirror terrarium-irc’s tool ergonomics (context search, enhancement requests) while adding web-specific tools (static site content, resume files, etc.).

## High-Level Architecture
```
Visitor Browser (mbabbott.com) ↔ GraphQL relay on VPS (dice-roller extension)
                                         ↑                       ↓
                         outbound-only terrarium-webchat worker (local)
                                         ↓
                               terrarium-agent HTTP API → vLLM
```
- The relay tracks chat rooms, enforces password/BYO-key gating, and emits `messageAdded` subscriptions.
- The worker authenticates with a service token, subscribes only to Terra-mode chats, builds prompts using terrarium-agent config, and posts replies via a `postMessage` mutation.
- Content tooling: worker mounts curated files (resume, project blurbs) and uses terrarium-agent tool definitions so Terra can fetch structured data.

## Component Notes
### 1. Web Frontend (mbabbott.com / `packages/web-frontend`)
- Reuse dice-roller’s Apollo client foundation; add chat widget UI (modal or docked pane) with password prompt before enabling Terra mode.
- Provide session-local storage for `chatId`, `accessCode`, and optional BYO model metadata.
- Commands:
  - `createChat(accessCode, mode)` mutation before first message.
  - `sendMessage(chatId, user: "Visitor", content, accessCode)` for each outbound text chunk.
- Subscribe to `messageStream(chatId)` to receive Terra responses and system notices.
- BYO mode: collect provider/API key/model, send once via `initExternalChat`, then keep messages client-side until server acks.

### 2. GraphQL Relay (VPS / `packages/vps-server`)
- Extend dice-roller schema with chat entities:
  - `Chat { id, mode, createdAt, status }`
  - `Message { id, chatId, sender, content, createdAt }`
- Mutations: `createChat(accessCode, mode)`, `sendVisitorMessage(chatId, content, accessCode)`, `postAgentMessage(chatId, content, serviceToken)`, `initExternalChat`, `sendExternalMessage`.
- Subscription: `messageStream(chatId)` publishing appended messages plus `chatOpened` for the worker to detect new sessions.
- Persistence: lightweight Postgres/SQLite or in-memory store with TTL, since chat volume is low; logs can flush to disk for audits.
- Security: validate access code, rate-limit per IP, verify `serviceToken` for Terra worker, encrypt BYO API keys at rest (in-memory + sealed box) and purge on chat end.
- Integration detail: the new Yoga module is exported from `packages/vps-server/src/chatModule.ts`, so dice-roller can import `buildChatModule()` and merge the typeDefs/resolvers directly without copy/pasting SDL.

### 3. Terrarium Worker (`packages/terrarium-client`)
- Language flexible (Python fits existing tooling). Responsibilities:
  1. Authenticate to GraphQL relay and subscribe/poll Terra-mode chats needing responses.
  2. Mirror terrarium-irc’s `ContextManager`: maintain per-chat memory, detect staleness, and trim tokens.
  3. Build OpenAI-format payloads for terrarium-agent: include system prompt referencing website info, the last N conversation turns, plus synthetic “web context” tool output.
  4. Handle tool calls returned by terrarium-agent (same JSON schema as in terrarium-irc). Implement executors for:
     - `read_site_page(path)` → fetch from local repo clone of mbabbott.com or from a curated markdown bundle.
     - `search_feature_docs(query)` → simple full-text search over curated docs.
     - `create_enhancement_request` → reuse terrarium-irc pattern but target `data/webchat_enhancements/`.
  5. Stream responses back to GraphQL via `postAgentMessage` mutation, chunking if needed.
- Logging: follow terrarium-irc’s `data/enhancements` precedent; keep transcripts locally with PII scrubbing before archiving.

### 4. Content Curation & Tooling
- Maintain a `content/` directory inside this repo containing markdown exports of resume, portfolio highlights, FAQ, etc.
- Provide Python helper to load these docs into embeddings or simple search indexes consumed by tools.
- Optionally add a `web_nav` tool that fetches live mbabbott.com pages via HTTP (respecting rate limits) to answer up-to-date questions.

### 5. Optional BYO Model Path
- Frontend toggles “Use Terra” vs “Bring your own model”.
- For BYO: GraphQL relay stores encrypted provider config and acts as proxy (OpenAI-compatible fetch). Terra worker ignores these chats.
- Rate-limit and time out external requests to avoid draining VPS resources; stream responses to client as they arrive.

## TODO Backlog
| Priority | Area | Task |
|---------|------|------|
| P0 | Documentation | Finalize repo scaffolding per AGENTS.md (packages/, shared/, docker-compose) so new code has a home. |
| P0 | VPS Server | Fork/extend dice-roller schema with chat types, password gating, and service-token auth; add `messageStream` subscription. |
| P0 | Terrarium Worker | Scaffold Python/Node service with env-driven GraphQL endpoint + service token; reuse terrarium-irc context manager patterns. |
| P0 | Frontend | Build minimal chat widget with password prompt, message list, and basic error states; wire to GraphQL mutations/subscriptions. |
| P1 | Worker → Agent Bridge | Implement OpenAI-compatible client (can import from terrarium-irc’s `llm/agent_client.py`) and ensure tool execution loop matches terrarium-agent expectations. |
| P1 | Content Tools | Create curated `content/` bundle and implement `read_site_page` & `search_feature_docs` tool handlers. |
| P1 | Persistence | Decide on lightweight storage (SQLite or Redis) for chat metadata on VPS; add retention + pruning jobs. |
| P1 | Access Control | Add rate limiting + CAPTCHA hook (optional) to GraphQL relay; rotate access code regularly. |
| P2 | Observability | Add structured logging and metrics (request latency, active chats) to relay and worker; surface alerts if worker disconnects. |
| P2 | BYO Models | Add `initExternalChat` + `sendExternalMessage` mutations plus provider adapters (OpenAI-compatible first). |
| P2 | UX Enhancements | Support typing indicators, retry UI, downloadable transcripts. |
| P3 | Automation | GitHub Actions for lint/test per workspace and deployment scripts for VPS/worker. |
| P3 | Knowledge Updates | Automate syncing mbabbott.com source files into worker content bundle (e.g., nightly rsync or git submodule). |

## Testing Strategy
- **Unit**: Jest for GraphQL resolvers, pytest for worker tool handlers, Vitest for React components.
- **Integration**: docker-compose stack locally (GraphQL + worker + mocked agent) to validate publish/subscribe loop and password gating.
- **End-to-End**: Playwright test hitting local Vite dev server with stubbed GraphQL responses and worker echoing via test harness.
- **Load/Resilience**: Simulate multiple chats to ensure worker queues requests and VPS with 2 GB RAM remains stable; backoff and reconnection logic are required on worker side.

This design mirrors the inverted MCP strategy demonstrated in terrarium-irc while adapting it for a public web channel with stricter auth and content tooling tailored to mbabbott.com.

## Deployment Status & Next Actions (Nov 10, 2025)
- **Local validation complete**: GraphQL relay + worker + frontend all run locally. Worker polls the relay, calls the real terrarium-agent, and posts replies; frontend streams updates via `messageStream`.
- **Ready for VPS**:
  1. Deploy `packages/vps-server` (or import `buildChatModule()` into dice-roller) on the VPS. Set `CHAT_PASSWORD` and `SERVICE_TOKEN`, expose the endpoint at `https://mbabbott.com/graphql`.
  2. Deploy the worker (`packages/terrarium-client`) on the Terra machine. Point `GRAPHQL_URL` to the public VPS URL (w/ HTTPS) and set `SERVICE_TOKEN`/`AGENT_API_URL` appropriately.
  3. Build the frontend with `VITE_GRAPHQL_URL` + `VITE_GRAPHQL_WS_URL` targeting the public endpoint and redeploy mbabbott.com with the compiled assets.
  4. Verify end-to-end by creating a chat via curl or the UI, confirm Terra responses appear, and monitor logs for rate limiting/auth errors.
- **Open tasks for VPS integration**:
  - Merge schema into dice-roller or run as a sidecar service managed by pm2/systemd.
  - Store `.env` secrets securely on both VPS and Terra machines.
  - Update Nginx (or another reverse proxy) to forward WebSocket traffic (`/graphql`).
  - Add basic monitoring/log rotation for the relay and worker processes.
