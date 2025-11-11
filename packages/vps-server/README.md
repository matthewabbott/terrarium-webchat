# @terrarium/webchat-vps-server

Lightweight Express + WebSocket relay that runs on the VPS. It gates visitor access with an access code, exposes REST endpoints for the worker, and streams chat updates over a `/api/chat` WebSocket per visitor.

## Routes
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/chat/:chatId/messages` | access code in body | Visitor sends a message. |
| `GET` | `/api/chat/:chatId/messages` | access code or `x-service-token` | Fetch chat transcript. |
| `GET` | `/api/chats/open` | `x-service-token` | Worker polls for chats needing attention. |
| `POST` | `/api/chat/:chatId/agent` | `x-service-token` | Worker posts Terra’s reply. |
| `WS` | `/api/chat?chatId=…&accessCode=…` | access code in query | Live stream of chat messages. |

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
```

When `BASE_PATH` is set, HTTP routes live at `<BASE_PATH>/api/*` and the WebSocket listens at `<BASE_PATH>/api/chat`. Leave it empty for local dev.

## Deployment Notes
1. Build the workspace (`npm run build --workspace packages/vps-server`).
2. Sync `dist/` + `package.json` into `/var/www/html/terrarium-server/` on the VPS.
3. Install production dependencies there (`npm install --omit=dev`).
4. Run via PM2 (`pm2 start dist/index.js --name terrarium-rest-chat`).
5. Update nginx to proxy `/terrarium/chat` (HTTP + WebSocket) to the relay port.
