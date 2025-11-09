import 'dotenv/config';
import { createSchema, createYoga } from 'graphql-yoga';
import { createServer } from 'http';
import pino from 'pino';
import { v4 as uuid } from 'uuid';

interface Message {
  id: string;
  chatId: string;
  sender: string;
  content: string;
  createdAt: string;
}

const messages = new Map<string, Message[]>();
const logger = pino({ name: 'webchat-vps', level: process.env.LOG_LEVEL ?? 'info' });

const schema = createSchema({
  typeDefs: /* GraphQL */ `
    type Message {
      id: ID!
      chatId: ID!
      sender: String!
      content: String!
      createdAt: String!
    }

    type Query {
      _health: String!
    }

    type Mutation {
      createChat(accessCode: String!, mode: String!): ID!
      sendVisitorMessage(chatId: ID!, content: String!, accessCode: String!): Message!
    }

    type Subscription {
      messageStream(chatId: ID!): Message!
    }
  `,
  resolvers: {
    Query: {
      _health: () => 'ok'
    },
    Mutation: {
      createChat: (_root, args: { accessCode: string; mode: string }) => {
        if (!validateAccessCode(args.accessCode)) {
          throw new Error('Access denied');
        }
        const id = uuid();
        messages.set(id, []);
        logger.info({ id, mode: args.mode }, 'Created chat');
        return id;
      },
      sendVisitorMessage: (_root, args: { chatId: string; content: string; accessCode: string }, ctx) => {
        if (!validateAccessCode(args.accessCode)) {
          throw new Error('Access denied');
        }
        const entry: Message = {
          id: uuid(),
          chatId: args.chatId,
          sender: 'Visitor',
          content: args.content,
          createdAt: new Date().toISOString()
        };
        const existing = messages.get(args.chatId);
        if (!existing) {
          throw new Error('Unknown chat');
        }
        existing.push(entry);
        ctx.pubSub.publish('MESSAGE_STREAM', entry);
        return entry;
      }
    },
    Subscription: {
      messageStream: {
        subscribe: (_root, args: { chatId: string }, ctx) => {
          return ctx.pubSub.subscribe('MESSAGE_STREAM', (payload: Message) => payload.chatId === args.chatId);
        },
        resolve: (payload: Message) => payload
      }
    }
  }
});

function validateAccessCode(code: string): boolean {
  const expected = process.env.CHAT_PASSWORD;
  return Boolean(expected) && code === expected;
}

const yoga = createYoga({
  schema,
  logging: {
    debug: (...args) => logger.debug(args),
    warn: (...args) => logger.warn(args),
    info: (...args) => logger.info(args),
    error: (...args) => logger.error(args)
  }
});

const server = createServer(yoga);
const port = Number(process.env.PORT ?? 4000);

server.listen(port, () => {
  logger.info({ port }, 'GraphQL relay ready');
});
