# Deployment Playbook

This guide explains how to run the terrarium webchat stack across the VPS (GraphQL relay + website assets) and the local LLM host (outbound worker). It mirrors the existing dice-roller deployment flow so you can reuse PM2, nginx, and `/var/www/html` conventions.

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

## 2. Deploy the GraphQL relay

1. **Staging directory** – create a sibling of the dice server so permissions stay consistent:
   ```bash
   sudo mkdir -p /var/www/html/terrarium-server
   sudo chown $USER:$USER /var/www/html/terrarium-server
   ```
2. **Copy build + package files**:
   ```bash
   rsync -av --delete packages/vps-server/dist/ /var/www/html/terrarium-server/dist/
   rsync -av packages/vps-server/package.json /var/www/html/terrarium-server/
   ```
3. **Install prod deps** (within `/var/www/html/terrarium-server`):
   ```bash
   cd /var/www/html/terrarium-server
   npm install --omit=dev
   sudo chown -R www-data:www-data node_modules package-lock.json
   ```
4. **Environment** – copy `.env.example` (`packages/vps-server/.env.example`) to `/var/www/html/terrarium-server/.env` and fill in:
   - `CHAT_PASSWORD` – visitor access code
   - `SERVICE_TOKEN` – shared secret with the worker
   - `PORT` – default `4000`, or change if dice-roller already owns it
5. **PM2 service**:
   ```bash
   cd /var/www/html/terrarium-server
   pm2 start dist/server.js --name terrarium-chat --env .env
   pm2 save
   ```
6. **nginx route** – add to `/etc/nginx/sites-available/default`:
   ```nginx
   location /terrarium/graphql {
       proxy_pass http://localhost:4000/graphql;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }
   ```
   Reload nginx: `sudo systemctl reload nginx`.

> If you prefer to reuse the existing dice Yoga instance, import `buildChatModule` from `packages/vps-server/dist/chatModule.js` inside `dice-roller/server.ts`, merge its schema, and keep PM2 pointed at `dice-server`. The remainder of this guide still applies because the public endpoint stays `/terrarium/graphql`.

## 3. Deploy the chat widget to mbabbott.com

1. Copy the Vite build into the site mirror:
   ```bash
   rsync -av --delete packages/web-frontend/dist/ ~/mbabbott-webpage/var/www/html/terrarium-chat/
   ```
2. Reference the bundle from your homepage (e.g., add `<script type="module" src="/terrarium-chat/assets/index.js"></script>` and a div to mount the widget). The UI reads these env vars at build time:
   - `VITE_GRAPHQL_URL=https://mbabbott.com/terrarium/graphql`
   - `VITE_GRAPHQL_WS_URL=wss://mbabbott.com/terrarium/graphql`
   Define them in `packages/web-frontend/.env` before running the build.
3. Deploy to nginx root:
   ```bash
   sudo cp -r ~/mbabbott-webpage/var/www/html/* /var/www/html/
   sudo chown -R www-data:www-data /var/www/html/
   ```

## 4. Local LLM host (terrarium worker)

On the Terra machine (outbound-only box):

```bash
cd ~/terrarium-webchat/packages/terrarium-client
cp .env.example .env  # edit values below
poetry install
```

`.env` values:
- `GRAPHQL_URL=https://mbabbott.com/terrarium/graphql`
- `SERVICE_TOKEN=<matches VPS .env>`
- `AGENT_API_URL=http://127.0.0.1:8080/v1/chat/completions` (or your terrarium-agent URL)
- Optional `AGENT_MODEL`, `POLL_INTERVAL_SECONDS`

Run the worker (consider wrapping with systemd/pm2):

```bash
poetry run python -m src.main
```

The worker polls `_health`, `openChats`, and `messages`, then posts replies via `postAgentMessage`. Keep outbound HTTPS open to the VPS; no inbound ports are required.

## 5. Verification checklist

- `curl https://mbabbott.com/terrarium/graphql -d '{"query":"{_health}"}'` returns `{"data":{"_health":"ok"}}`.
- Vite widget loads on mbabbott.com and prompts for the access code.
- `pm2 logs terrarium-chat` shows visitor messages arriving.
- Worker console logs confirm it connects and responds.

Once everything is green, snapshot both `/var/www/html/terrarium-server` and `~/mbabbott-webpage` so redeploys stay reproducible.
