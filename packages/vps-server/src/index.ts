import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { appendFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { format as formatDate } from 'date-fns';

type LogLevel = 'info' | 'warn' | 'error';

const env = process.env;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireString(value: string | undefined, fallback: string, name: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!fallback) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return fallback;
}

const CONFIG = {
  chatPassword: requireString(env.CHAT_PASSWORD, 'terra-access', 'CHAT_PASSWORD'),
  serviceToken: requireString(env.SERVICE_TOKEN, 'super-secret-service-token', 'SERVICE_TOKEN'),
  hmacEnabled: parseBool(env.HMAC_ENABLED, false),
  hmacSecret: env.HMAC_SECRET ?? '',
  hmacMaxSkewSeconds: parseNumber(env.HMAC_MAX_SKEW_SECONDS, 300),
  port: parseNumber(env.PORT, 4100),
  basePath: (env.BASE_PATH ?? '').replace(/\/$/, ''),
  workerStaleThresholdMs: parseNumber(env.WORKER_STALE_THRESHOLD_MS, 60_000),
  logChatEvents: parseBool(env.LOG_CHAT_EVENTS, true),
  logDir: (env.LOG_DIR ?? path.join(process.cwd(), 'chat-logs')) as string,
  logAssistantChunks: parseBool(env.LOG_ASSISTANT_CHUNKS, false),
  bodyLimit: env.BODY_SIZE_LIMIT ?? '256kb',
  maxMessageLength: parseNumber(env.MAX_MESSAGE_LENGTH, 4000),
  rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMaxPerIp: parseNumber(env.RATE_LIMIT_MAX_PER_IP, 60),
  rateLimitMaxPerChat: parseNumber(env.RATE_LIMIT_MAX_PER_CHAT, 120),
} as const;

const LOG_QUEUE_MAX = 1000;
const LOG_QUEUE_BATCH_SIZE = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SOCKET_BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;
const LOG_MAX_BYTES = parseNumber(env.LOG_MAX_BYTES, 1_000_000_000);

if (CONFIG.logChatEvents) {
  mkdirSync(CONFIG.logDir, { recursive: true });
}

interface Message {
  id: string;
  chatId: string;
  sender: 'Visitor' | 'Terra';
  content: string;
  createdAt: string;
}

type StatusLevel = 'online' | 'degraded' | 'offline' | 'unknown';

interface ComponentStatus {
  status: StatusLevel;
  detail?: string | null;
  checkedAt?: string | null;
  latencyMs?: number | null;
}

interface WorkerStatusPayload {
  agentApi: ComponentStatus;
  llm: ComponentStatus;
}

type ChainNode = ComponentStatus & { id: string; label: string };

type WorkerEvent = {
  type: 'chat_activity';
  chatId: string;
  messageId: string;
  emittedAt: string;
};

type WorkerStateValue = 'idle' | 'queued' | 'processing' | 'responded' | 'error';

interface WorkerStatePayload {
  state: WorkerStateValue;
  detail: string | null;
  updatedAt: string;
}

type AssistantChunkPayload = {
  type: 'assistantChunk';
  chatId: string;
  content: string;
  done?: boolean;
  emittedAt: string;
};

const chats = new Map<string, Message[]>();
const connections = new Map<string, Set<WebSocket>>();
let lastWorkerSeenAt: number | null = null;
let workerStatus: WorkerStatusPayload | null = null;
const workerSockets = new Set<WebSocket>();
const chatWorkerStates = new Map<string, WorkerStatePayload>();

const app = express();
app.use(express.json({ limit: CONFIG.bodyLimit }));

const metrics = {
  httpRequests: 0,
  httpErrorResponses: 0,
  httpLatencyMsTotal: 0,
  logQueueDropped: 0
};

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    metrics.httpRequests += 1;
    metrics.httpLatencyMsTotal += Date.now() - start;
    if (res.statusCode >= 500) {
      metrics.httpErrorResponses += 1;
    }
  });
  next();
});

type RateBucket = { count: number; resetAt: number };
const rateBucketsByIp = new Map<string, RateBucket>();
const rateBucketsByChat = new Map<string, RateBucket>();

function getBucket(map: Map<string, RateBucket>, key: string): RateBucket {
  const now = Date.now();
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 0, resetAt: now + CONFIG.rateLimitWindowMs };
    map.set(key, bucket);
    return bucket;
  }
  return existing;
}

function rateLimitVisitor(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? 'unknown';
  const chatId = req.params.chatId ?? 'unknown';

  const ipBucket = getBucket(rateBucketsByIp, ip);
  if (ipBucket.count >= CONFIG.rateLimitMaxPerIp) {
    return res.status(429).json({ error: 'Rate limit exceeded (ip)' });
  }
  ipBucket.count += 1;

  const chatBucket = getBucket(rateBucketsByChat, chatId);
  if (chatBucket.count >= CONFIG.rateLimitMaxPerChat) {
    return res.status(429).json({ error: 'Rate limit exceeded (chat)' });
  }
  chatBucket.count += 1;

  next();
}

const apiRouter = express.Router();

type PendingLog = { target: string; line: string };
const logQueue: PendingLog[] = [];
let flushPromise: Promise<void> | null = null;
const NONCE_CACHE = new Map<string, number>();
const NONCE_TTL_MS = 5 * 60 * 1000;

function verifyHmac(req: Request, bodyString: string): boolean {
  if (!CONFIG.hmacEnabled) return true;
  const signature = req.headers['x-signature'];
  const tsHeader = req.headers['x-signature-ts'];
  if (!signature || !tsHeader || typeof signature !== 'string' || typeof tsHeader !== 'string') {
    return false;
  }
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > CONFIG.hmacMaxSkewSeconds) return false;
  const nonce = (req.headers['x-signature-nonce'] as string | undefined) ?? '';
  const nonceKey = nonce ? `${nonce}:${tsHeader}` : '';
  if (nonceKey) {
    const expires = Date.now() + NONCE_TTL_MS;
    if (NONCE_CACHE.has(nonceKey)) return false;
    NONCE_CACHE.set(nonceKey, expires);
  }
  // purge expired nonces occasionally
  if (NONCE_CACHE.size > 500) {
    const nowMs = Date.now();
    for (const [k, v] of NONCE_CACHE.entries()) {
      if (v < nowMs) NONCE_CACHE.delete(k);
    }
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const parsedUrl = new URL(req.originalUrl, `http://localhost`);
  const payload = [method, parsedUrl.pathname, tsHeader, bodyString].join('\n');
  const expected = createHmac('sha256', CONFIG.hmacSecret).update(payload).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function scheduleLogFlush() {
  if (flushPromise) return;
  flushPromise = flushLogs()
    .catch((error) => {
      console.error('Failed to flush chat logs', error);
    })
    .finally(() => {
      flushPromise = null;
      if (logQueue.length > 0) {
        scheduleLogFlush();
      }
    });
}

async function flushLogs() {
  const batch = logQueue.splice(0, LOG_QUEUE_BATCH_SIZE);
  const grouped = new Map<string, string[]>();
  for (const entry of batch) {
    const existing = grouped.get(entry.target) ?? [];
    existing.push(entry.line);
    grouped.set(entry.target, existing);
  }
  for (const [target, lines] of grouped) {
    await appendFile(target, lines.join(''), 'utf8');
  }
  await pruneLogs();
}

async function pruneLogs() {
  try {
    const files = (await readdir(CONFIG.logDir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((name) => path.join(CONFIG.logDir, name));
    const stats = await Promise.all(
      files.map(async (f) => {
        const s = await stat(f);
        return { file: f, mtime: s.mtimeMs, size: s.size };
      })
    );
    let total = stats.reduce((sum, s) => sum + s.size, 0);
    const sorted = stats.sort((a, b) => a.mtime - b.mtime);
    while (total > LOG_MAX_BYTES && sorted.length) {
      const victim = sorted.shift()!;
      await unlink(victim.file).catch(() => {});
      total -= victim.size;
    }
  } catch (error) {
    console.error('Failed to prune chat logs', error);
  }
}

function logEvent(chatId: string, type: string, payload: Record<string, unknown>) {
  if (!CONFIG.logChatEvents) return;
  const scrubbed = { ...payload };
  const secretKeys = ['accessCode', 'access_code', 'x-service-token', 'x-signature', 'authorization'];
  for (const key of secretKeys) {
    if (key in scrubbed) {
      scrubbed[key] = '[redacted]';
    }
  }
  const entry = {
    timestamp: new Date().toISOString(),
    chatId,
    type,
    ...scrubbed,
  };
  const datePrefix = formatDate(new Date(), 'yyyyMMdd');
  const target = path.join(CONFIG.logDir, `${datePrefix}-${chatId}.jsonl`);
  const line = `${JSON.stringify(entry)}\n`;
  if (logQueue.length >= LOG_QUEUE_MAX) {
    metrics.logQueueDropped += 1;
    return;
  }
  logQueue.push({ target, line });
  scheduleLogFlush();
}

function recordWorkerHeartbeat() {
  lastWorkerSeenAt = Date.now();
}

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
    if (socket.readyState !== WebSocket.OPEN) {
      sockets.delete(socket);
      continue;
    }
    if (socket.bufferedAmount > SOCKET_BACKPRESSURE_THRESHOLD_BYTES) {
      socket.terminate();
      sockets.delete(socket);
      continue;
    }
    socket.send(JSON.stringify(message));
  }
}

function notifyWorkers(event: WorkerEvent) {
  const payload = JSON.stringify(event);
  for (const socket of workerSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    } else {
      workerSockets.delete(socket);
    }
  }
}

function getWorkerState(chatId: string): WorkerStatePayload {
  return (
    chatWorkerStates.get(chatId) ?? {
      state: 'idle',
      detail: null,
      updatedAt: new Date(0).toISOString()
    }
  );
}

function setWorkerState(chatId: string, state: WorkerStateValue, detail?: string | null) {
  const payload: WorkerStatePayload = {
    state,
    detail: detail ?? null,
    updatedAt: new Date().toISOString()
  };
  chatWorkerStates.set(chatId, payload);
  broadcastWorkerState(chatId, payload);
}

function broadcastWorkerState(chatId: string, payload: WorkerStatePayload) {
  const sockets = connections.get(chatId);
  if (!sockets) return;
  const message = JSON.stringify({
    type: 'workerState',
    chatId,
    state: payload.state,
    detail: payload.detail,
    updatedAt: payload.updatedAt
  });
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      sockets.delete(socket);
      continue;
    }
    if (socket.bufferedAmount > SOCKET_BACKPRESSURE_THRESHOLD_BYTES) {
      socket.terminate();
      sockets.delete(socket);
      continue;
    }
    socket.send(message);
  }
}

function broadcastAssistantChunk(chatId: string, content: string, done: boolean) {
  const sockets = connections.get(chatId);
  if (!sockets) return;
  const payload: AssistantChunkPayload = {
    type: 'assistantChunk',
    chatId,
    content,
    done,
    emittedAt: new Date().toISOString()
  };
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      sockets.delete(socket);
      continue;
    }
    if (socket.bufferedAmount > SOCKET_BACKPRESSURE_THRESHOLD_BYTES) {
      socket.terminate();
      sockets.delete(socket);
      continue;
    }
    socket.send(serialized);
  }
}

apiRouter.post('/chat/:chatId/messages', rateLimitVisitor, (req: Request, res: Response) => {
  const { chatId } = req.params;
  const { content, accessCode } = req.body as { content?: string; accessCode?: string };
  if (accessCode !== CONFIG.chatPassword) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Message content required' });
  }
  if (content.length > CONFIG.maxMessageLength) {
    return res.status(413).json({ error: 'Message too long' });
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
  notifyWorkers({
    type: 'chat_activity',
    chatId,
    messageId: message.id,
    emittedAt: new Date().toISOString()
  });
  setWorkerState(chatId, 'queued');
  logEvent(chatId, 'visitor_message', { id: message.id, content, createdAt: message.createdAt });
  res.json(message);
});

apiRouter.get('/chat/:chatId/messages', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const accessCode = (req.query.accessCode as string | undefined) ?? undefined;
  const token = req.headers['x-service-token'];
  if (token === CONFIG.serviceToken) {
    if (!verifyHmac(req, '')) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    recordWorkerHeartbeat();
  } else if (accessCode !== CONFIG.chatPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(ensureChat(chatId));
});

apiRouter.post('/chat/:chatId/agent', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
   const bodyString = JSON.stringify(req.body ?? {});
   if (!verifyHmac(req, bodyString)) {
     return res.status(401).json({ error: 'Invalid signature' });
   }
  recordWorkerHeartbeat();
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
  logEvent(chatId, 'assistant_message', { id: message.id, content, createdAt: message.createdAt });
  res.json(message);
});

apiRouter.post('/chat/:chatId/agent-chunk', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const bodyString = JSON.stringify(req.body ?? {});
  if (!verifyHmac(req, bodyString)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  recordWorkerHeartbeat();
  const { content, done } = req.body as { content?: string; done?: boolean };
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'Chunk content required' });
  }
  broadcastAssistantChunk(chatId, content, Boolean(done));
  if (content && CONFIG.logAssistantChunks && CONFIG.logChatEvents) {
    logEvent(chatId, 'assistant_chunk', { content, done: Boolean(done) });
  }
  res.json({ ok: true });
});

apiRouter.get('/chats/open', (req: Request, res: Response) => {
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!verifyHmac(req, '')) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  recordWorkerHeartbeat();
  res.json({ chatIds: Array.from(chats.keys()) });
});

const validStatus: StatusLevel[] = ['online', 'degraded', 'offline', 'unknown'];

function normalizeComponentStatus(input: unknown, fallbackDetail: string): ComponentStatus {
  const payload = (typeof input === 'object' && input !== null ? input : {}) as Partial<ComponentStatus>;
  const status = validStatus.includes((payload.status as StatusLevel) ?? 'unknown')
    ? (payload.status as StatusLevel)
    : 'unknown';
  const detail =
    typeof payload.detail === 'string' || payload.detail === null
      ? payload.detail
      : status === 'unknown'
        ? fallbackDetail
        : null;
  const checkedAt = typeof payload.checkedAt === 'string' ? payload.checkedAt : null;
  const latencyMs = typeof payload.latencyMs === 'number' ? payload.latencyMs : null;
  return { status, detail, checkedAt, latencyMs };
}

apiRouter.post('/worker/status', (req: Request, res: Response) => {
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const bodyString = JSON.stringify(req.body ?? {});
  if (!verifyHmac(req, bodyString)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const body = req.body as WorkerStatusPayload;
  workerStatus = {
    agentApi: normalizeComponentStatus(body?.agentApi, 'Awaiting agent health data'),
    llm: normalizeComponentStatus(body?.llm, 'Awaiting LLM health data'),
  };
  recordWorkerHeartbeat();
  return res.json({ ok: true });
});

const workerStateValues: WorkerStateValue[] = ['idle', 'queued', 'processing', 'responded', 'error'];

apiRouter.post('/chat/:chatId/worker-state', (req: Request, res: Response) => {
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const bodyString = JSON.stringify(req.body ?? {});
  if (!verifyHmac(req, bodyString)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  const { chatId } = req.params;
  const { state, detail } = req.body as { state?: WorkerStateValue; detail?: string | null };
  if (!state || !workerStateValues.includes(state)) {
    return res.status(400).json({ error: 'Invalid worker state' });
  }
  setWorkerState(chatId, state, typeof detail === 'string' ? detail : null);
  logEvent(chatId, 'worker_state', { state, detail: typeof detail === 'string' ? detail : null });
  return res.json({ ok: true });
});

apiRouter.get('/chat/:chatId/worker-state', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const accessCode = (req.query.accessCode as string | undefined) ?? undefined;
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken && accessCode !== CONFIG.chatPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(getWorkerState(chatId));
});

apiRouter.get('/health', (req: Request, res: Response) => {
  const accessCode = (req.query.accessCode as string | undefined) ?? undefined;
  if (accessCode !== CONFIG.chatPassword) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  const workerReady =
    lastWorkerSeenAt !== null ? Date.now() - lastWorkerSeenAt <= CONFIG.workerStaleThresholdMs : false;
  const workerLastSeenIso = lastWorkerSeenAt ? new Date(lastWorkerSeenAt).toISOString() : null;
  const nowIso = new Date().toISOString();
  const workerDetail = workerReady
      ? null
      : workerLastSeenIso
        ? 'Worker heartbeat expired'
        : 'Worker has not checked in yet';
  const workerOfflineDetail = workerLastSeenIso
    ? `Worker offline; last heartbeat at ${workerLastSeenIso}`
    : 'Worker offline; no heartbeat received yet';
  const agentStatus =
    workerReady && workerStatus?.agentApi
      ? workerStatus.agentApi
      : {
          status: workerReady ? 'unknown' : 'offline',
          detail: workerReady ? 'Awaiting agent health data' : workerOfflineDetail,
          checkedAt: workerReady ? null : workerLastSeenIso,
          latencyMs: null
        };
  const llmStatus =
    workerReady && workerStatus?.llm
      ? workerStatus.llm
      : {
          status: workerReady ? 'unknown' : 'offline',
          detail: workerReady ? 'Awaiting LLM health data' : workerOfflineDetail,
          checkedAt: workerReady ? null : workerLastSeenIso,
          latencyMs: null
        };
  const statusChain: ChainNode[] = [
    { id: 'frontend', label: 'Frontend', status: 'online', detail: null, checkedAt: nowIso },
    { id: 'relay', label: 'Relay', status: 'online', detail: null, checkedAt: nowIso },
    {
      id: 'worker',
      label: 'Webchat worker',
      status: workerReady ? 'online' : 'offline',
      detail: workerDetail,
      checkedAt: workerLastSeenIso,
    },
    { id: 'agent', label: 'terrarium-agent', ...normalizeComponentStatus(agentStatus, 'Awaiting agent health data') },
    { id: 'llm', label: 'vLLM', ...normalizeComponentStatus(llmStatus, 'Awaiting LLM health data') },
  ];
  res.json({
    relay: 'ok',
    workerReady,
    workerLastSeenAt: workerLastSeenIso,
    workerStatus,
    chain: statusChain,
  });
});

apiRouter.get('/metrics', (req: Request, res: Response) => {
  const token = req.headers['x-service-token'];
  if (token !== CONFIG.serviceToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let chatConnectionsCount = 0;
  for (const set of connections.values()) {
    chatConnectionsCount += set.size;
  }
  const httpAvgLatencyMs =
    metrics.httpRequests > 0 ? Math.round((metrics.httpLatencyMsTotal / metrics.httpRequests) * 100) / 100 : 0;
  res.json({
    http: {
      requests: metrics.httpRequests,
      errors: metrics.httpErrorResponses,
      avgLatencyMs: httpAvgLatencyMs
    },
    ws: {
      chatConnections: chatConnectionsCount,
      workerConnections: workerSockets.size
    },
    logs: {
      queueLength: logQueue.length,
      dropped: metrics.logQueueDropped
    }
  });
});

const mountPoints = new Set<string>(['/api']);
if (CONFIG.basePath) {
  mountPoints.add(`${CONFIG.basePath}/api`);
}
for (const mount of mountPoints) {
  app.use(mount, apiRouter);
}

const server = createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
const chatWsPaths = new Set<string>(Array.from(mountPoints, (mount) => `${mount}/chat`));
const workerWsPaths = new Set<string>(Array.from(mountPoints, (mount) => `${mount}/worker/updates`));
const wsPaths = new Set<string>([...chatWsPaths, ...workerWsPaths]);
type HeartbeatSocket = WebSocket & { isAlive?: boolean };

const heartbeatTimer = setInterval(() => {
  wsServer.clients.forEach((socket: HeartbeatSocket) => {
    if (socket.isAlive === false) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
    if (socket.bufferedAmount > SOCKET_BACKPRESSURE_THRESHOLD_BYTES) {
      socket.terminate();
    }
  });
}, HEARTBEAT_INTERVAL_MS);

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
  const tracked = socket as HeartbeatSocket;
  tracked.isAlive = true;
  tracked.on('pong', () => {
    tracked.isAlive = true;
  });

  const url = new URL(request.url ?? '', 'http://localhost');
  const pathname = url.pathname ?? '';

  if (workerWsPaths.has(pathname)) {
    const token = request.headers['x-service-token'];
    if (token !== CONFIG.serviceToken) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    workerSockets.add(socket);
    socket.on('close', () => {
      workerSockets.delete(socket);
    });
    return;
  }

  if (!chatWsPaths.has(pathname)) {
    socket.close(1008, 'Unknown path');
    return;
  }

  const chatId = url.searchParams.get('chatId');
  const accessCode = url.searchParams.get('accessCode');
  if (!chatId || accessCode !== CONFIG.chatPassword) {
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

server.listen(CONFIG.port, () => {
  console.log(`REST chat relay listening on ${CONFIG.port}`);
});
