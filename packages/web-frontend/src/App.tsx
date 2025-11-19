import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Chat = {
  id: string;
};

type Message = {
  id: string;
  chatId: string;
  sender: 'Visitor' | 'Terra' | 'System';
  content: string;
  createdAt: string;
};

type HealthResponse = {
  relay: string;
  workerReady: boolean;
  workerLastSeenAt: string | null;
};

const formatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
});
const HEALTH_POLL_INTERVAL_MS = 30_000;
const CONNECT_PROMPT = 'Send your first message to connect with Terra';

function describeRelayFailure(action: string, status: number | null): string {
  if (status === 401 || status === 403) {
    return 'That access code was rejected. Double-check it and try again.';
  }
  if (status === 404) {
    return `Terra’s relay hasn’t exposed that endpoint yet (HTTP 404) while trying to ${action}. The server may still be restarting.`;
  }
  if (status === 502 || status === 503) {
    return `Terra’s relay is restarting (HTTP ${status}) while trying to ${action}. The pm2 service should come back shortly.`;
  }
  if (status && status >= 500) {
    return `Terra’s relay hit an internal error (HTTP ${status}) while trying to ${action}. Give it a moment and try again.`;
  }
  if (status && status >= 400) {
    return `We hit an HTTP ${status} error while trying to ${action}.`;
  }
  return `We can’t ${action} right now because the relay is offline. We’ll keep retrying automatically.`;
}

const defaultHttpBase =
  typeof window !== 'undefined'
    ? new URL(import.meta.env.BASE_URL ?? '/', window.location.origin).toString()
    : 'http://localhost:5173/';

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

const API_BASE = ensureTrailingSlash(import.meta.env.VITE_API_BASE ?? defaultHttpBase);
const defaultWsBase = ensureTrailingSlash(API_BASE.replace(/^http/, 'ws'));
const WS_BASE = ensureTrailingSlash(import.meta.env.VITE_WS_BASE ?? defaultWsBase);

function buildUrl(path: string): string {
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalized, API_BASE).toString();
}

function buildWsUrl(path: string, params: Record<string, string>): string {
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(normalized, WS_BASE);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function generateChatId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 12);
}

export function App() {
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem('terrarium-access-code') ?? '');
  const [chat, setChat] = useState<Chat | null>(() => {
    const stored = sessionStorage.getItem('terrarium-chat-id');
    return stored ? { id: stored } : null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [awaitingTerra, setAwaitingTerra] = useState(false);
  const [lastAckAt, setLastAckAt] = useState<Date | null>(null);
  const [socketStatus, setSocketStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [llmStatus, setLlmStatus] = useState<'idle' | 'checking' | 'ready' | 'offline'>('idle');
  const [workerLastSeenAt, setWorkerLastSeenAt] = useState<Date | null>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    const stored = localStorage.getItem('terra-theme');
    return stored === 'dark';
  });

  const messageIds = useRef<Set<string>>(new Set());
  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const systemNoticeCounterRef = useRef(0);
  const noticeKeysRef = useRef<Set<string>>(new Set());
  const terraHasResponded = useMemo(() => messages.some((msg) => msg.sender === 'Terra'), [messages]);
  const terraReady = terraHasResponded || llmStatus === 'ready';
  const statusDotState = terraReady ? 'online' : llmStatus === 'checking' ? 'pending' : 'offline';
  const statusDotText = (() => {
    if (terraReady) {
      return 'Terra is listening';
    }
    if (llmStatus === 'checking') {
      return 'Checking Terra status…';
    }
    if (llmStatus === 'offline') {
      return CONNECT_PROMPT;
    }
    return 'Enter the access code';
  })();

  const handleAddMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (messageIds.current.has(msg.id)) {
        return prev;
      }
      messageIds.current.add(msg.id);
      return [...prev, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, []);

  const pushSystemNotice = useCallback(
    (content: string) => {
      const notice: Message = {
        id: `system-${systemNoticeCounterRef.current++}`,
        chatId: chat?.id ?? 'system',
        sender: 'System',
        content,
        createdAt: new Date().toISOString()
      };
      handleAddMessage(notice);
    },
    [chat, handleAddMessage]
  );

  const ensureSystemNotice = useCallback(
    (key: string, content: string) => {
      if (noticeKeysRef.current.has(key)) return;
      noticeKeysRef.current.add(key);
      pushSystemNotice(content);
    },
    [pushSystemNotice]
  );

  const clearSystemNoticeKey = useCallback((key: string) => {
    noticeKeysRef.current.delete(key);
  }, []);

  const clearAllSystemNoticeKeys = useCallback(() => {
    noticeKeysRef.current.clear();
  }, []);

  const handleRelayFailure = useCallback(
    (key: string, action: string, status: number | null, options?: { suppressFormError?: boolean }) => {
      const notice = describeRelayFailure(action, status);
      ensureSystemNotice(key, notice);
      if (!options?.suppressFormError) {
        setFormError(notice);
      }
    },
    [ensureSystemNotice, setFormError]
  );

  const resetChat = useCallback(() => {
    setChat(null);
    setMessages([]);
    messageIds.current.clear();
    setAwaitingTerra(false);
    setLastAckAt(null);
    setLlmStatus('idle');
    setWorkerLastSeenAt(null);
    setFormError(null);
    clearAllSystemNoticeKeys();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, [clearAllSystemNoticeKeys]);

  useEffect(() => {
    if (awaitingTerra && terraHasResponded) {
      setAwaitingTerra(false);
    }
    if (terraHasResponded) {
      setLlmStatus('ready');
    }
  }, [awaitingTerra, terraHasResponded]);

  useEffect(() => {
    sessionStorage.setItem('terrarium-access-code', accessCode);
  }, [accessCode]);

  useEffect(() => {
    document.body.classList.toggle('dark-theme', isDarkTheme);
    localStorage.setItem('terra-theme', isDarkTheme ? 'dark' : 'light');
  }, [isDarkTheme]);

  const toggleTheme = useCallback(() => {
    setIsDarkTheme((prev) => !prev);
  }, []);

  useEffect(() => {
    if (chat?.id) {
      sessionStorage.setItem('terrarium-chat-id', chat.id);
    } else {
      sessionStorage.removeItem('terrarium-chat-id');
    }
  }, [chat]);

  const fetchHistory = useCallback(async () => {
    if (!chat?.id || !accessCode.trim()) {
      clearSystemNoticeKey('history');
      return;
    }
    let lastStatus: number | null = null;
    try {
      const historyUrl = new URL(buildUrl(`/api/chat/${chat.id}/messages`));
      historyUrl.searchParams.set('accessCode', accessCode);
      const response = await fetch(historyUrl.toString());
      lastStatus = response.status;
      if (!response.ok) throw new Error('Unable to load history');
      const data: Message[] = await response.json();
      messageIds.current = new Set(data.map((msg) => msg.id));
      setMessages(data);
      setFormError(null);
      clearSystemNoticeKey('history');
    } catch (error) {
      console.error('Unable to load history', error);
      handleRelayFailure('history', 'load chat history', lastStatus);
    }
  }, [chat, accessCode, clearSystemNoticeKey, handleRelayFailure]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    if (!chat?.id || !accessCode.trim()) {
      setLlmStatus('idle');
      setWorkerLastSeenAt(null);
      clearSystemNoticeKey('health');
      return;
    }

    let cancelled = false;
    const runHealthCheck = async () => {
      setLlmStatus((prev) => (prev === 'ready' ? prev : 'checking'));
      let lastStatus: number | null = null;
      try {
        const url = new URL(buildUrl('/api/health'));
        url.searchParams.set('accessCode', accessCode);
        const response = await fetch(url.toString());
        lastStatus = response.status;
        if (!response.ok) throw new Error('Unable to reach Terra');
        const payload: HealthResponse = await response.json();
        if (cancelled) return;
        setWorkerLastSeenAt(payload.workerLastSeenAt ? new Date(payload.workerLastSeenAt) : null);
        setLlmStatus(payload.workerReady ? 'ready' : 'offline');
        clearSystemNoticeKey('health');
      } catch (error) {
        if (cancelled) return;
        console.error('Health check failed', error);
        setWorkerLastSeenAt(null);
        setLlmStatus((prev) => (prev === 'ready' ? prev : 'offline'));
        handleRelayFailure('health', 'check Terra’s status', lastStatus, { suppressFormError: true });
      }
    };

    runHealthCheck();
    const intervalId = setInterval(runHealthCheck, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [chat, accessCode, clearSystemNoticeKey, handleRelayFailure]);

  useEffect(() => {
    if (!chat?.id || !accessCode.trim()) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setSocketStatus('idle');
      return;
    }

    const wsUrl = buildWsUrl('/api/chat', { chatId: chat.id, accessCode });
    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;
    setSocketStatus('connecting');

    socket.onopen = () => {
      setSocketStatus('connected');
      clearSystemNoticeKey('socket');
    };
    socket.onerror = () => {
      setSocketStatus('error');
      handleRelayFailure('socket', 'stream live updates', null, { suppressFormError: true });
    };
    socket.onclose = (event) => {
      setSocketStatus('idle');
      if (event.code !== 1000) {
        handleRelayFailure('socket', 'keep the WebSocket connected', null, { suppressFormError: true });
      }
    };
    socket.onmessage = (event) => {
      try {
        const payload: Message = JSON.parse(event.data as string);
        handleAddMessage(payload);
      } catch (error) {
        console.error('Invalid message payload', error);
      }
    };

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [chat, accessCode, handleAddMessage, clearSystemNoticeKey, handleRelayFailure]);

  useEffect(() => {
    if (!messageContainerRef.current) return;
    messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
  }, [messages]);

  const autoResizeTextarea = useCallback(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(200, textareaRef.current.scrollHeight)}px`;
  }, []);

  useEffect(() => {
    autoResizeTextarea();
  }, [messageInput, autoResizeTextarea]);

  const handleCreateChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessCode.trim()) {
      setFormError('Access code required');
      return;
    }
    setFormError(null);
    setMessages([]);
    messageIds.current.clear();
    setAwaitingTerra(false);
    setLlmStatus('checking');
    setWorkerLastSeenAt(null);
    clearAllSystemNoticeKeys();
    setChat({ id: generateChatId() });
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chat || !messageInput.trim()) {
      return;
    }
    let lastStatus: number | null = null;
    try {
      const response = await fetch(buildUrl(`/api/chat/${chat.id}/messages`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: messageInput.trim(), accessCode })
      });
      lastStatus = response.status;
      if (!response.ok) {
        throw new Error('Unable to send message');
      }
      const message: Message = await response.json();
      handleAddMessage(message);
      setMessageInput('');
      setAwaitingTerra(true);
      setLastAckAt(new Date(message.createdAt));
      setFormError(null);
      clearSystemNoticeKey('send');
    } catch (error) {
      console.error('Unable to send message', error);
      handleRelayFailure('send', 'send your message', lastStatus);
    }
  };

  const messageList = useMemo(() => {
    if (!messages.length) {
      return <p className="empty">No messages yet. Send your first message to connect.</p>;
    }
    return messages.map((msg) => {
      const variant = msg.sender === 'Visitor' ? 'visitor' : msg.sender === 'System' ? 'system' : 'terra';
      return (
        <div key={msg.id} className={`message message--${variant}`}>
          {msg.sender !== 'System' && (
            <div className="message__meta">
              <span>{msg.sender}</span>
              <time>{formatter.format(new Date(msg.createdAt))}</time>
            </div>
          )}
          <p>{msg.content}</p>
        </div>
      );
    });
  }, [messages]);

  const composerPlaceholder = useMemo(() => {
    if (!messages.length) {
      return CONNECT_PROMPT;
    }
    if (terraReady) {
      return 'Tell Terra what you need…';
    }
    if (llmStatus === 'offline') {
      return 'Terra is booting—type your request and we will hand it to her once she reconnects…';
    }
    return 'Checking Terra’s connection…';
  }, [messages.length, terraReady, llmStatus]);

  const ackLabel = useMemo(() => {
    if (!lastAckAt) return null;
    return `Message sent at ${formatter.format(lastAckAt)}.`;
  }, [lastAckAt]);
  const heartbeatLabel = useMemo(() => {
    if (!workerLastSeenAt) return null;
    return `Terra checked in at ${formatter.format(workerLastSeenAt)}.`;
  }, [workerLastSeenAt]);

  return (
    <>
      <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
        {isDarkTheme ? '☀️ Light' : '🌙 Dark'}
      </button>
      <div className="page">
        <header className="hero">
        <div>
          <p className="eyebrow">mbabbott.com / Terra</p>
          <h1>Terrarium webchat.</h1>
          <p className="subheading">
            I call my DGX spark host a digital 'terrarium' for a large language model, which I call 'Terra'.
            Terra does many things, and one of those things is chat with you here to convince you I am cool.
            If you don't know the secret password, DM me on{" "}
            <a
              href="https://www.linkedin.com/in/matthew-abbott-88390065/"
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn
            </a>
            ,{" "}
            <a
              href="https://twitter.com/Ttobbattam"
              target="_blank"
              rel="noopener noreferrer"
            >
              Twitter
            </a>
            , or just{" "}
            <a
              href="https://mbabbott.com/resume.pdf"
              target="_blank"
              rel="noopener noreferrer"
            >
              email me
            </a>
            .
          </p>
          <p className="coming-soon">Coming soon: link(s) to about pages for my 'terrarium' projects.</p>
        </div>
        <div className={`status-dot status-dot--${statusDotState}`}>{statusDotText}</div>
      </header>

      <section className="terrarium-intro">
        <h2>What is Terra?</h2>
        <p>
          Terra is specifically an instance of GLM-4.5-Air-AWQ-4bit.
          Someday, Terra will have more tools she can use from this endpoint (that will let her know more about the digital 'terrarium')
          Also a more sophisticated system prompt. And also also in my loftiest ambitions, I'll also do some fine-tuning at some point.
        </p>
      </section>

      <section className="access-panel">
        <form className="access-form" onSubmit={handleCreateChat}>
          <label>
            Access code
            <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="••••••" />
          </label>
          <button type="submit" disabled={!accessCode.trim()}>
            {chat ? 'Start a new chat' : 'Start a chat'}
          </button>
        </form>
        {formError && <p className="error">{formError}</p>}
      </section>

      <section className="chat-panel">
        {!chat && <div className="chat-placeholder">Enter your access code to open a chat with Terra.</div>}
        {chat && (
          <>
            <div className="chat-meta">
              <span>Chat ID: {chat.id.slice(0, 8)}</span>
              <span className={`socket-indicator socket-indicator--${socketStatus}`}>{socketStatus}</span>
              <button className="reset-btn" type="button" onClick={resetChat}>
                Reset chat
              </button>
            </div>
            <div className="log" ref={messageContainerRef} aria-live="polite">
              {messageList}
              {awaitingTerra && (
                <div className="message message--system">
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>Terra is thinking…</p>
                </div>
              )}
            </div>
            <form className="composer" onSubmit={handleSendMessage}>
              <textarea
                ref={textareaRef}
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                placeholder={composerPlaceholder}
                disabled={!chat}
                rows={1}
                onInput={autoResizeTextarea}
              />
              <button type="submit" disabled={!chat || !messageInput.trim()}>
                Send
              </button>
            </form>
            <div className="status-row">
              {ackLabel && <span>{ackLabel}</span>}
              {heartbeatLabel && <span>{heartbeatLabel}</span>}
              {!terraReady && llmStatus === 'offline' && (
                <span>Terra is waking up. Messages queue here until she reconnects.</span>
              )}
              {!terraReady && llmStatus === 'checking' && <span>Verifying Terra’s connection…</span>}
            </div>
          </>
        )}
      </section>
      </div>
    </>
  );
}
