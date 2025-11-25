# @terrarium/webchat-vps-server

Lightweight Express + WebSocket relay that runs on the VPS. It gates visitor access with an access code, exposes REST endpoints for the worker, and streams chat updates over a `/api/chat` WebSocket per visitor.

## Routes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/chat/:chatId/messages` | access code in body | Visitor sends a message. |
| `GET` | `/api/chat/:chatId/messages` | access code or `x-service-token` | Fetch chat transcript. |
| `GET` | `/api/chats/open` | `x-service-token` | Worker polls for chats needing attention. |
| `POST` | `/api/chat/:chatId/agent` | `x-service-token` | Worker posts Terra’s reply. |
| `POST` | `/api/chat/:chatId/agent-chunk` | `x-service-token` | Worker streams partial assistant content (not persisted). |
| `POST` | `/api/worker/status` | `x-service-token` | Worker publishes terrarium-agent/vLLM health probes. |
| `POST` | `/api/chat/:chatId/worker-state` | `x-service-token` | Worker reports per-chat queue/processing status. |
| `GET` | `/api/chat/:chatId/worker-state` | access code or `x-service-token` | Fetch the latest worker state for a chat (UI fallback). |
| `GET` | `/api/health` | access code in query | Relay + worker heartbeat status for the UI. |
| `GET` | `/api/metrics` | `x-service-token` | Basic relay metrics (HTTP counts, latency avg, WS counts, log queue). |
| `WS` | `/api/chat?chatId=…&accessCode=…` | access code in query | Live stream of chat messages and worker-state events. |
| `WS` | `/api/worker/updates` | `x-service-token` header | Push channel that pings the worker when a visitor posts a new message. |

`GET /api/health` now returns a `chain` array describing each hop (frontend, relay, worker heartbeat, terrarium-agent API, vLLM). The worker keeps those entries fresh by POSTing to `/api/worker/status` whenever it pings the agent or completes a visitor prompt. Pair this with the `/api/worker/updates` WebSocket so the worker gets notified instantly when a visitor sends a gated message, and use `/api/chat/:chatId/worker-state` so the UI can render “queued / thinking / error” copy for each chat without waiting for a health poll.

## Scripts
- `npm run dev` – start the relay with `tsx` + hot reload
- `npm run build` – compile to `dist/`
- `npm run start` – run compiled server
- `npm run lint` – type-check only
- `npm run test` – placeholder for future route tests

## Env Vars (`.env`)
```
CHAT_PASSWORD=terra-access
SERVICE_TOKEN=super-secret-service-token
PORT=4100
BASE_PATH=/terrarium   # optional; defaults to empty so routes live at /api
WORKER_STALE_THRESHOLD_MS=60000  # optional; heartbeat freshness window for /api/health
LOG_CHAT_EVENTS=true  # set to false to disable chat log writes
LOG_DIR=/var/log/terrarium-chat  # optional; where JSONL chat logs are written when enabled
LOG_ASSISTANT_CHUNKS=false  # optional; log streaming chunks when chat logging is on
BODY_SIZE_LIMIT=256kb  # limit for JSON bodies
MAX_MESSAGE_LENGTH=4000  # reject oversized chat messages
RATE_LIMIT_WINDOW_MS=60000  # window for rate limiting
RATE_LIMIT_MAX_PER_IP=60  # max requests per IP per window on visitor endpoints
RATE_LIMIT_MAX_PER_CHAT=120  # max requests per chatId per window on visitor endpoints
```

When `BASE_PATH` is set, HTTP routes live at `<BASE_PATH>/api/*` and the WebSocket listens at `<BASE_PATH>/api/chat`. Leave it empty for local dev.

## Deployment Notes
1. Build the workspace (`npm run build --workspace packages/vps-server`).
2. Sync `dist/` + `package.json` into `/var/www/html/terrarium-server/` on the VPS.
3. Install production dependencies there (`npm install --omit=dev`).
4. Run via PM2 (`pm2 start dist/index.js --name terrarium-rest-chat`).
5. Update nginx to proxy `/terrarium/chat` (HTTP + WebSocket) to the relay port.
