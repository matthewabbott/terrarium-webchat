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

function toHeaders(input: Headers | Record<string, string | string[] | undefined> | undefined | null): Headers {
  if (input instanceof Headers) {
    return input;
  }
  const headers = new Headers();
  if (!input) {
    return headers;
  }
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (typeof entry === 'string') headers.append(key, entry);
      });
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

const yoga = createYoga<AppContext>({
  schema,
  maskedErrors: false,
  context: ({ request }) => ({
    store,
    env,
    pubSub: pubSub as PubSubLike,
    requestHeaders: toHeaders(
      (request as unknown as { headers: Headers | Record<string, string | string[] | undefined> }).headers
    )
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

wsServer.on('connection', (socket, request) => {
  logger.info({ event: 'ws-connection', url: request.url, headers: request.headers }, 'WebSocket connection received');
  socket.on('close', (code, reason) => {
    logger.info({ event: 'ws-close', code, reason: reason.toString() }, 'WebSocket connection closed');
  });
  socket.on('error', (error) => {
    logger.error({ event: 'ws-socket-error', error }, 'WebSocket socket error');
  });
});

wsServer.on('error', (error) => {
  logger.error({ event: 'ws-server-error', error }, 'WebSocket server error');
});

type ExecutionRoot = {
  execute: typeof import('graphql').execute;
  subscribe: typeof import('graphql').subscribe;
};

useServer(
  {
    execute: (args) => (args.rootValue as ExecutionRoot).execute(args as never),
    subscribe: (args) => (args.rootValue as ExecutionRoot).subscribe(args as never),
    onSubscribe: async (ctx, _messageId, payload) => {
      logger.info({ event: 'ws-onSubscribe', payload, connectionParams: ctx.connectionParams }, 'Received subscription request');
      try {
        const { schema, execute, subscribe, parse, validate, contextFactory } = yoga.getEnveloped({
          ...ctx,
          req: ctx.extra.request,
          request: ctx.extra.request,
          socket: ctx.extra.socket,
          params: payload
        });

        const document = parse(payload.query ?? '');
        const validationErrors = validate(schema, document);
        if (validationErrors.length > 0) {
          return validationErrors;
        }

        try {
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
          logger.error({ event: 'ws-context-error', error, headers: ctx.extra.request.headers }, 'Failed to build subscription context');
          throw error;
        }
      } catch (error) {
        logger.error({ event: 'ws-onSubscribe-error', error, payload }, 'Subscription setup failed');
        throw error;
      }
    },
    onError: (_ctx, _messageId, errors) => {
      logger.error({ event: 'ws-subscription-error', errors }, 'Subscription error');
    },
    onComplete: (_ctx, _messageId) => {
      logger.debug({ event: 'ws-subscription-complete', messageId: _messageId }, 'Subscription completed');
    }
  },
  wsServer
);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'GraphQL relay ready');
});
