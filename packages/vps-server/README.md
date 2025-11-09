# @terrarium/webchat-vps-server

GraphQL relay that lives on the VPS. It gates visitor access, emits chat subscriptions, and accepts outbound messages from the terrarium worker. This scaffold uses GraphQL Yoga with a simple in-memory store; replace it with durable persistence before production.

## Scripts
- `npm run dev` – start Yoga with tsx + hot reload
- `npm run build` – compile to `dist/`
- `npm run start` – run compiled server
- `npm run lint` – type-check only
- `npm run test` – placeholder for resolver tests
