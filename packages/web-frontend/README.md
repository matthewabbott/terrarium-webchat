# @terrarium/webchat-frontend

Vite + React scaffold for the mbabbott.com chat widget. It currently exposes a simple access-code form wired to the GraphQL relay. Build out the conversation view, password gating UX, and BYO-model flow here.

## Scripts
- `npm run dev` – start Vite dev server (reads `.env`)
- `npm run build` – type-check + bundle
- `npm run preview` – serve the production build locally
- `npm run lint` – type-check only
- `npm run test` – placeholder for component tests

## Running against the local relay
1. Copy `.env.example` to `.env` and update `VITE_GRAPHQL_URL` / `VITE_GRAPHQL_WS_URL` if the relay isn’t on `localhost:4000`.
2. Ensure the GraphQL relay + worker are running (see `packages/vps-server` and `packages/terrarium-client` docs).
3. From repo root: `npm run dev --workspace packages/web-frontend` and open the printed URL.
4. Enter the access code from `packages/vps-server/.env` (e.g., `letmein`), then chat normally—Terra replies stream through the `messageStream` subscription.

## Next steps
- Swap the Vite env values to the production VPS endpoint once dice-roller imports `buildChatModule()`
- Add richer chat affordances (typing indicator, streaming UI, transcripts) after the terrarium worker can post agent messages
