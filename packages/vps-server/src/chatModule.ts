import { GraphQLScalarType, Kind } from 'graphql';
import type { Env } from './env';
import type { InMemoryChatStore, MessageRecord } from './store';

export const MESSAGE_TOPIC = 'MESSAGE_STREAM';

export interface PubSubLike<TPayload> {
  publish: (event: string, payload: TPayload) => Promise<void> | void;
  subscribe: (event: string) => AsyncIterable<TPayload>;
}

export interface YogaContext {
  store: InMemoryChatStore;
  env: Env;
  pubSub: PubSubLike<MessageRecord>;
  requestHeaders: Headers;
}

export function buildChatModule() {
  return {
    typeDefs: /* GraphQL */ `
      scalar DateTime

      enum ChatMode {
        terra
        external
      }

      enum ChatStatus {
        open
        closed
        error
      }

      type Chat {
        id: ID!
        mode: ChatMode!
        status: ChatStatus!
        createdAt: DateTime!
        updatedAt: DateTime!
      }

      type Message {
        id: ID!
        chatId: ID!
        sender: String!
        content: String!
        createdAt: DateTime!
      }

      type Query {
        _health: String!
        chat(id: ID!, accessCode: String!): Chat
      }

      type Mutation {
        createChat(accessCode: String!, mode: ChatMode!): Chat!
        sendVisitorMessage(chatId: ID!, content: String!, accessCode: String!): Message!
        postAgentMessage(chatId: ID!, content: String!): Message!
        closeChat(chatId: ID!, accessCode: String!): Chat
      }

      type Subscription {
        messageStream(chatId: ID!, accessCode: String!): Message!
      }
    `,
    resolvers: {
      DateTime: new GraphQLScalarType({
        name: 'DateTime',
        description: 'ISO-8601 timestamp string',
        serialize(value: unknown) {
          if (typeof value === 'string') return value;
          if (value instanceof Date) return value.toISOString();
          throw new TypeError('DateTime must serialize from string or Date');
        },
        parseValue(value: unknown) {
          if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
            return value;
          }
          throw new TypeError('DateTime must be an ISO string');
        },
        parseLiteral(ast) {
          if (ast.kind === Kind.STRING && !Number.isNaN(Date.parse(ast.value))) {
            return ast.value;
          }
          return null;
        }
      }),
      Query: {
        _health: () => 'ok',
        chat: (_root: unknown, args: { id: string; accessCode: string }, ctx: YogaContext) => {
          ensureAccess(args.accessCode, ctx.env);
          return ctx.store.getChat(args.id) ?? null;
        }
      },
      Mutation: {
        createChat: (_root: unknown, args: { accessCode: string; mode: 'terra' | 'external' }, ctx: YogaContext) => {
          ensureAccess(args.accessCode, ctx.env);
          return ctx.store.createChat(args.mode);
        },
        sendVisitorMessage: (
          _root: unknown,
          args: { chatId: string; content: string; accessCode: string },
          ctx: YogaContext
        ) => {
          ensureAccess(args.accessCode, ctx.env);
          const message = ctx.store.appendMessage(args.chatId, 'Visitor', args.content);
          ctx.pubSub.publish(MESSAGE_TOPIC, message);
          return message;
        },
        postAgentMessage: (_root: unknown, args: { chatId: string; content: string }, ctx: YogaContext) => {
          ensureServiceToken(ctx.requestHeaders, ctx.env);
          const message = ctx.store.appendMessage(args.chatId, 'Terra', args.content);
          ctx.pubSub.publish(MESSAGE_TOPIC, message);
          return message;
        },
        closeChat: (_root: unknown, args: { chatId: string; accessCode: string }, ctx: YogaContext) => {
          ensureAccess(args.accessCode, ctx.env);
          return ctx.store.closeChat(args.chatId) ?? null;
        }
      },
      Subscription: {
        messageStream: {
          subscribe: async (
            _root: unknown,
            args: { chatId: string; accessCode: string },
            ctx: YogaContext
          ) => {
            ensureAccess(args.accessCode, ctx.env);
            const iterator = ctx.pubSub.subscribe(MESSAGE_TOPIC);
            return filterMessages(iterator, args.chatId);
          },
          resolve: (payload: MessageRecord) => payload
        }
      }
    }
  };
}

function ensureAccess(accessCode: string, env: Env): void {
  if (accessCode !== env.CHAT_PASSWORD) {
    throw new Error('Access denied');
  }
}

function ensureServiceToken(headers: Headers, env: Env): void {
  const token = headers.get('x-service-token');
  if (!token || token !== env.SERVICE_TOKEN) {
    throw new Error('Unauthorized');
  }
}

async function* filterMessages(iterator: AsyncIterable<MessageRecord>, chatId: string) {
  for await (const payload of iterator) {
    if (payload.chatId === chatId) {
      yield payload;
    }
  }
}
