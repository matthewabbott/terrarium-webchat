import 'dotenv/config';
import { createServer } from 'http';
import pino from 'pino';
import { createSchema, createYoga, createPubSub } from 'graphql-yoga';
import { buildChatModule, type PubSubLike } from './chatModule.js';
import { InMemoryChatStore } from './store.js';
import { loadEnv, type Env } from './env.js';

type AppContext = {
  store: InMemoryChatStore;
  env: Env;
  pubSub: PubSubLike;
  requestHeaders: Headers;
};

const env = loadEnv();
const logger = pino({ name: 'terrarium-webchat-vps', level: env.LOG_LEVEL });
const store = new InMemoryChatStore({ ttlHours: env.CHAT_TTL_HOURS });
const pubSub = createPubSub();

const chatModule = buildChatModule();
const schema = createSchema<AppContext>({
  typeDefs: chatModule.typeDefs,
  resolvers: chatModule.resolvers as never
});

const yoga = createYoga<AppContext>({
  schema,
  context: ({ request }) => ({
    store,
    env,
    pubSub: pubSub as PubSubLike,
    requestHeaders: request.headers
  }),
  logging: {
    debug: (...args) => logger.debug(args),
    info: (...args) => logger.info(args),
    warn: (...args) => logger.warn(args),
    error: (...args) => logger.error(args)
  }
});

const server = createServer(yoga);
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'GraphQL relay ready');
});
