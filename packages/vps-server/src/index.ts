import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const CHAT_PASSWORD = process.env.CHAT_PASSWORD ?? 'terra-access';
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? 'super-secret-service-token';
const PORT = Number(process.env.PORT ?? 4100);
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '');

interface Message {
  id: string;
  chatId: string;
  sender: 'Visitor' | 'Terra';
  content: string;
  createdAt: string;
}

const chats = new Map<string, Message[]>();
const connections = new Map<string, Set<WebSocket>>();

const app = express();
app.use(express.json());

const apiRouter = express.Router();

function ensureChat(chatId: string): Message[] {
  if (!chats.has(chatId)) {
    chats.set(chatId, []);
  }
  return chats.get(chatId)!;
}

function broadcast(chatId: string, message: Message) {
  const sockets = connections.get(chatId);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

apiRouter.post('/chat/:chatId/messages', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const { content, accessCode } = req.body as { content?: string; accessCode?: string };
  if (accessCode !== CHAT_PASSWORD) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Message content required' });
  }

  const message: Message = {
    id: randomUUID(),
    chatId,
    sender: 'Visitor',
    content,
    createdAt: new Date().toISOString()
  };
  ensureChat(chatId).push(message);
  broadcast(chatId, message);
  res.json(message);
});

apiRouter.get('/chat/:chatId/messages', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const accessCode = (req.query.accessCode as string | undefined) ?? undefined;
  const token = req.headers['x-service-token'];
  if (token !== SERVICE_TOKEN && accessCode !== CHAT_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(ensureChat(chatId));
});

apiRouter.post('/chat/:chatId/agent', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const token = req.headers['x-service-token'];
  if (token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { content } = req.body as { content?: string };
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Message content required' });
  }
  const message: Message = {
    id: randomUUID(),
    chatId,
    sender: 'Terra',
    content,
    createdAt: new Date().toISOString()
  };
  ensureChat(chatId).push(message);
  broadcast(chatId, message);
  res.json(message);
});

apiRouter.get('/chats/open', (req: Request, res: Response) => {
  const token = req.headers['x-service-token'];
  if (token !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ chatIds: Array.from(chats.keys()) });
});

const mountPoints = new Set<string>([BASE_PATH ? `${BASE_PATH}/api` : '/api']);
for (const mount of mountPoints) {
  app.use(mount, apiRouter);
}

const server = createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const wsPaths = new Set<string>(Array.from(mountPoints, (mount) => `${mount}/chat`));

server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url ?? '', 'http://localhost');
    if (!wsPaths.has(pathname ?? '')) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

wsServer.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '', 'http://localhost');
  const chatId = url.searchParams.get('chatId');
  const accessCode = url.searchParams.get('accessCode');
  if (!chatId || accessCode !== CHAT_PASSWORD) {
    socket.close(1008, 'Unauthorized');
    return;
  }
  const set = connections.get(chatId) ?? new Set<WebSocket>();
  set.add(socket);
  connections.set(chatId, set);

  socket.on('close', () => {
    set.delete(socket);
    if (set.size === 0) {
      connections.delete(chatId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`REST chat relay listening on ${PORT}`);
});
