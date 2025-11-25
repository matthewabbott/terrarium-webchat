# Deployment Playbook

This guide explains how to run the terrarium webchat stack across the VPS (REST relay + website assets) and the local LLM host (outbound worker). It mirrors the existing dice-roller deployment flow so you can reuse PM2, nginx, and `/var/www/html` conventions.

### Safe deploy workflow (don’t wipe live again)
- The **staging mirror** lives at `~/mbabbott-webpage/var/www/html/` and is the source of truth for deploys. Do your staging rsyncs into that mirror.
- The **live site** is `/var/www/html/`. To deploy, sync **staging → live**:
  ```bash
  sudo rsync -av --delete ~/mbabbott-webpage/var/www/html/ /var/www/html/
  sudo chown -R www-data:www-data /var/www/html/
  ```
  Never rsync from live back into staging (that’s what wiped the site).
- Relay/other service `.env` files stay only under `/var/www/html/.../.env`; keep a local copy if you need to re-create them after a rebuild.

## 1. Build artifacts on the VPS

```bash
cd /root/terrarium-webchat
npm install  # once per VM
npm run build --workspace packages/vps-server
npm run build --workspace packages/web-frontend
```

Outputs:
- `packages/vps-server/dist/` → Node server bundle to run under PM2
- `packages/web-frontend/dist/` → static assets to copy into the mbabbott.com site

## 2. Deploy the REST relay

1. **Staging directory** – create a sibling of the dice server so permissions stay consistent:
   ```bash
   sudo mkdir -p /var/www/html/terrarium-server
   sudo chown $USER:$USER /var/www/html/terrarium-server
   ```
2. **Copy build + package files**:
   ```bash
   rsync -av --delete packages/vps-server/dist/ /var/www/html/terrarium-server/dist/
   rsync -av packages/vps-server/package*.json /var/www/html/terrarium-server/
   ```
3. **Install prod deps** (within `/var/www/html/terrarium-server`):
   ```bash
   cd /var/www/html/terrarium-server
   npm install --omit=dev
   ```
4. **Environment** – copy `.env.example` (`packages/vps-server/.env.example`) to `/var/www/html/terrarium-server/.env` and fill in (example values shown):
   ```ini
CHAT_PASSWORD=terra-access                # visitor access code
SERVICE_TOKEN=super-secret-service-token  # shared secret with the worker
PORT=4100                                 # relay port (match nginx proxy)
BASE_PATH=/terrarium                      # mount REST + WS under /terrarium/api
WORKER_STALE_THRESHOLD_MS=60000           # optional heartbeat freshness window for /api/health
LOG_CHAT_EVENTS=true                      # set false to disable chat log writes on the relay
LOG_DIR=/var/log/terrarium-chat           # optional custom log directory when enabled
LOG_ASSISTANT_CHUNKS=false                # include streaming chunks in logs when enabled
```
5. **PM2 service**:
   ```bash
   cd /var/www/html/terrarium-server
   pm2 start dist/index.js --name terrarium-rest-chat --cwd /var/www/html/terrarium-server
   pm2 save
   ```
6. **nginx routes** – add to `/etc/nginx/sites-available/default` (update port if you chose something else):
   ```nginx
   # REST endpoints
   location /terrarium/api/ {
       proxy_pass http://127.0.0.1:4100/api/;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
   }

   # WebSocket stream
   location /terrarium/api/chat {
       proxy_pass http://127.0.0.1:4100/api/chat;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }

   # Worker WebSocket updates
   location /terrarium/api/worker/updates {
       proxy_pass http://127.0.0.1:4100/api/worker/updates;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }
   ```
   Reload nginx: `sudo systemctl reload nginx`.

With this config the public base URL becomes `https://mbabbott.com/terrarium`, so the frontend can call `https://mbabbott.com/terrarium/api/...` and open `wss://mbabbott.com/terrarium/api/chat`.

## 3. Deploy the chat page to mbabbott.com

1. Copy the Vite build into the site mirror:
   ```bash
   rsync -av --delete packages/web-frontend/dist/ ~/mbabbott-webpage/var/www/html/terra/
   ```
2. `packages/web-frontend/.env.production` (checked in) pins prod settings:
   ```ini
   VITE_BASE_PATH=/terra/
   VITE_API_BASE=https://mbabbott.com/terrarium/
   VITE_WS_BASE=wss://mbabbott.com/terrarium/
   ```
   Adjust if you deploy to a different subdirectory. Keep the API/WS bases ending with `/` so the client resolves `api/...` paths under the same prefix. The runtime code appends `/api/...` or `/api/chat` automatically.
3. Deploy to nginx root:
   ```bash
   sudo cp -r ~/mbabbott-webpage/var/www/html/* /var/www/html/
   sudo chown -R www-data:www-data /var/www/html/
   ```
4. Visit `https://mbabbott.com/terra/` to confirm the UI renders, prompts for the access code, and shows the “Terra is listening” status when a worker is online.

## 4. Local LLM host (terrarium worker)

On the Terra machine (outbound-only box):

```bash
cd ~/terrarium-webchat/packages/terrarium-client
cp .env.example .env  # edit values below
poetry install
```

`.env` values:
- `API_BASE_URL=https://mbabbott.com/terrarium`
- `SERVICE_TOKEN=<matches VPS .env>`
- `AGENT_API_URL=http://127.0.0.1:8080/v1/chat/completions` (or your terrarium-agent URL)
- Optional `AGENT_MODEL`, `POLL_INTERVAL_SECONDS`

Run the worker (wrap in systemd, pm2, or tmux for production):

```bash
poetry run python -m src.main
```

The worker polls `/api/chats/open`, fetches messages per chat, calls terrarium-agent, and posts replies via `/api/chat/:chatId/agent`. Keep outbound HTTPS open to the VPS; no inbound ports are required.

## 5. Verification checklist

- `curl https://mbabbott.com/terrarium/api/chats/open -H 'x-service-token: …'` returns a JSON list (empty when idle).
- `curl 'https://mbabbott.com/terrarium/api/health?accessCode=terra-access'` confirms `workerReady` flips to `true` when the terrarium worker polls.
- `wscat -c wss://mbabbott.com/terrarium/api/chat?chatId=<id>&accessCode=terra-access` streams messages.
- Vite widget loads on mbabbott.com/terra, accepts the access code, and shows new messages.
- `pm2 logs terrarium-rest-chat` shows visitor messages arriving, plus worker POSTs.
- Worker console logs confirm it connects and responds without authorization errors.

## 6. Rotating credentials

- **Visitor access code (`CHAT_PASSWORD`)** – edit `/var/www/html/terrarium-server/.env`, then `pm2 restart terrarium-rest-chat` so the relay enforces the new code. Share it only with trusted users.
- **Service token (`SERVICE_TOKEN`)** – update the same `.env`, restart the relay, then update `packages/terrarium-client/.env` on the LLM host to match before restarting the worker. This keeps `/api/chats/open`, `/api/chat/:chatId/agent`, and history endpoints limited to the trusted worker.
