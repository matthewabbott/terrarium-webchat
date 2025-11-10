# @terrarium/webchat-frontend

Vite + React scaffold for the mbabbott.com chat widget. It currently exposes a simple access-code form wired to the GraphQL relay. Build out the conversation view, password gating UX, and BYO-model flow here.

## Scripts
- `npm run dev` – start Vite dev server
- `npm run build` – type-check + bundle
- `npm run preview` – serve the production build locally
- `npm run lint` – type-check only
- `npm run test` – placeholder for component tests

## Next steps
- Swap the mock relay URL to the shared VPS endpoint once it imports `buildChatModule()`
- Add richer chat affordances (typing indicator, streaming) after the terrarium worker can post agent messages
