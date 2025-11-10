# @terrarium/webchat-vps-server

GraphQL relay that lives on the VPS. It gates visitor access, emits chat subscriptions, and accepts outbound messages from the terrarium worker. The schema is exported via `buildChatModule()` so dice-roller (or any other server) can stitch the same chat types into its existing Yoga instance.

## Scripts
- `npm run dev` – start Yoga with tsx + hot reload
- `npm run build` – compile to `dist/`
- `npm run start` – run compiled server
- `npm run lint` – type-check only
- `npm run test` – placeholder for resolver tests

## Reuse in dice-roller
Import the built module and merge it with the dice-roller schema:

```ts
import { buildChatModule } from '@terrarium/webchat-vps-server/chatModule';

const chatModule = buildChatModule();
const schema = createSchema({
  typeDefs: [existingTypeDefs, chatModule.typeDefs],
  resolvers: [existingResolvers, chatModule.resolvers],
});
```

Provide the same context props (`store`, `env`, `pubSub`, `requestHeaders`) when wiring it into the existing Yoga instance.

### Worker endpoints
- `openChats` / `messages(chatId)` – require the `x-service-token` header; used by the terrarium worker to poll conversation state.
- `chatOpened` subscription – emits a `Chat` whenever a visitor starts a new session (also service-token gated).
- `postAgentMessage` – worker-only mutation for publishing Terra's replies (service token enforced).
