# @terrarium/webchat-frontend

Vite + React scaffold for the mbabbott.com chat widget. The UI now talks directly to the REST relay instead of the old GraphQL stack—focus new work on the access-code flow, chat interface, and BYO-model entry points.

The hero section surfaces `/api/health` data as a “chain” so visitors can see whether the relay, worker, terrarium-agent API, and vLLM inference server are online before they send their first message.

## Scripts
- `npm run dev` – start Vite dev server (reads `.env`)
- `npm run build` – type-check + bundle
- `npm run preview` – serve the production build locally
- `npm run lint` – type-check only
- `npm run test` – placeholder for component tests

## Running against the local relay
1. Copy `.env.example` to `.env` and tweak `VITE_API_BASE` / `VITE_WS_BASE` if the relay isn’t on `http://localhost:4000`.
2. Ensure the REST relay + worker are running (see `packages/vps-server` and `packages/terrarium-client` docs).
3. From repo root: `npm run dev --workspace packages/web-frontend` and open the printed URL.
4. Enter the access code from `packages/vps-server/.env` (e.g., `letmein`), then chat normally—Terra replies arrive over the `/api/chat` WebSocket.

## Next steps
- Mirror the prod VPS endpoints in `.env.example.local` so the static build can be rsynced without edits.
- Add richer chat affordances (typing indicator, streaming UI, transcripts) once the terrarium worker can post agent messages.
