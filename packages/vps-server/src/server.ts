import 'dotenv/config';
import { createServer } from 'http';
import pino from 'pino';
import { createSchema, createYoga, createPubSub } from 'graphql-yoga';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';
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

const wsServer = new WebSocketServer({
  server,
  path: yoga.graphqlEndpoint
});

type EnvelopedExecution = {
  execute: ReturnType<typeof createYoga>['getEnveloped'] extends (...args: any[]) => infer R ? R extends { execute: infer E } ? E : never : never;
  subscribe: ReturnType<typeof createYoga>['getEnveloped'] extends (...args: any[]) => infer R ? R extends { subscribe: infer S } ? S : never : never;
};

useServer(
  {
    execute: (args) => (args.rootValue as EnvelopedExecution).execute(args as never),
    subscribe: (args) => (args.rootValue as EnvelopedExecution).subscribe(args as never),
    onSubscribe: async (ctx, _messageId, payload) => {
      try {
        const { schema, execute, subscribe, parse, validate, contextFactory } = yoga.getEnveloped({
          ...ctx,
          req: ctx.extra.request,
          socket: ctx.extra.socket,
          params: payload
        });

        const document = parse(payload.query ?? '');
        const validationErrors = validate(schema, document);
        if (validationErrors.length > 0) {
          return validationErrors;
        }

        const contextValue = await contextFactory();

        return {
          schema,
          operationName: payload.operationName,
          document,
          variableValues: payload.variables,
          contextValue,
          rootValue: {
            execute,
            subscribe
          }
        };
      } catch (error) {
        logger.error({ err: error }, 'subscription setup failed');
        throw error;
      }
    }
  },
  wsServer
);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'GraphQL relay ready');
});
