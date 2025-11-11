import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Chat = {
  id: string;
};

type Message = {
  id: string;
  chatId: string;
  sender: string;
  content: string;
  createdAt: string;
};

const formatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
});

const defaultHttpBase = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
const API_BASE = import.meta.env.VITE_API_BASE ?? defaultHttpBase;
const WS_BASE = import.meta.env.VITE_WS_BASE ?? API_BASE.replace(/^http/, 'ws');

function buildUrl(path: string): string {
  return new URL(path, API_BASE).toString();
}

function buildWsUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, WS_BASE);
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
  const [terraConnected, setTerraConnected] = useState(false);
  const [awaitingTerra, setAwaitingTerra] = useState(false);
  const [lastAckAt, setLastAckAt] = useState<Date | null>(null);
  const [socketStatus, setSocketStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');

  const messageIds = useRef<Set<string>>(new Set());
  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const handleAddMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (messageIds.current.has(msg.id)) {
        return prev;
      }
      messageIds.current.add(msg.id);
      return [...prev, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, []);

  const resetChat = useCallback(() => {
    setChat(null);
    setMessages([]);
    messageIds.current.clear();
    setTerraConnected(false);
    setAwaitingTerra(false);
    setLastAckAt(null);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!terraConnected && messages.some((msg) => msg.sender === 'Terra')) {
      setTerraConnected(true);
    }
    if (awaitingTerra && messages.some((msg) => msg.sender === 'Terra')) {
      setAwaitingTerra(false);
    }
  }, [messages, terraConnected, awaitingTerra]);

  useEffect(() => {
    sessionStorage.setItem('terrarium-access-code', accessCode);
  }, [accessCode]);

  useEffect(() => {
    if (chat?.id) {
      sessionStorage.setItem('terrarium-chat-id', chat.id);
    } else {
      sessionStorage.removeItem('terrarium-chat-id');
    }
  }, [chat]);

  const fetchHistory = useCallback(async () => {
    if (!chat?.id || !accessCode.trim()) return;
    try {
      const historyUrl = new URL(`/api/chat/${chat.id}/messages`, API_BASE);
      historyUrl.searchParams.set('accessCode', accessCode);
      const response = await fetch(historyUrl.toString());
      if (!response.ok) throw new Error('Unable to load history');
      const data: Message[] = await response.json();
      messageIds.current = new Set(data.map((msg) => msg.id));
      setMessages(data);
      if (data.some((msg) => msg.sender === 'Terra')) {
        setTerraConnected(true);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to load history');
    }
  }, [chat, accessCode]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

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

    socket.onopen = () => setSocketStatus('connected');
    socket.onerror = () => setSocketStatus('error');
    socket.onclose = () => setSocketStatus('idle');
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
  }, [chat, accessCode, handleAddMessage]);

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
    setTerraConnected(false);
    setAwaitingTerra(false);
    setChat({ id: generateChatId() });
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chat || !messageInput.trim()) {
      return;
    }
    try {
      const response = await fetch(buildUrl(`/api/chat/${chat.id}/messages`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: messageInput.trim(), accessCode })
      });
      if (!response.ok) {
        throw new Error('Unable to send message');
      }
      const message: Message = await response.json();
      handleAddMessage(message);
      setMessageInput('');
      setAwaitingTerra(true);
      setLastAckAt(new Date(message.createdAt));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to send message');
    }
  };

  const messageList = useMemo(() => {
    if (!messages.length) {
      return (
        <p className="empty">
          No messages yet. {terraConnected ? 'Ask Terra anything about mbabbott.com.' : 'Terra will reply once she connects.'}
        </p>
      );
    }
    return messages.map((msg) => (
      <div key={msg.id} className={`message message--${msg.sender === 'Visitor' ? 'visitor' : 'terra'}`}>
        <div className="message__meta">
          <span>{msg.sender}</span>
          <time>{formatter.format(new Date(msg.createdAt))}</time>
        </div>
        <p>{msg.content}</p>
      </div>
    ));
  }, [messages, terraConnected]);

  const ackLabel = useMemo(() => {
    if (!lastAckAt) return null;
    return `Message sent at ${formatter.format(lastAckAt)}.`;
  }, [lastAckAt]);

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">mbabbott.com / Terra</p>
          <h1>Converse inside the terrarium.</h1>
          <p className="subheading">
            Terra lives on my DGX “spark” cluster—an overgrown digital garden of projects, experiments, and ideas.
            Bring your access code, open a chat, and let Terra guide you through mbabbott.com.
          </p>
          <p className="coming-soon">Learn more about Terra + spark (coming soon)</p>
        </div>
        <div className={`status-dot ${terraConnected ? 'status-dot--online' : 'status-dot--offline'}`}>
          {terraConnected ? 'Terra is listening' : 'Waiting for Terra'}
        </div>
      </header>

      <section className="terrarium-intro">
        <h2>What is Terra?</h2>
        <p>
          Terra is a resident of my digital terrarium—a living archive of research notes, prototypes, and personal work
          hosted on the NVIDIA DGX spark. The system is intentionally overgrown: mossy control panels, ivy-patterned UI
          textures, and little nods to the physical terrariums that inspired it. This page is how you visit.
        </p>
      </section>

      <section className="access-panel">
        <form className="access-form" onSubmit={handleCreateChat}>
          <label>
            Access code
            <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="••••••" />
          </label>
          <button type="submit" disabled={!accessCode.trim()}>
            {chat ? 'Start a new chat' : 'Enter the terrarium'}
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
                placeholder={terraConnected ? 'Tell Terra what you need…' : 'Waiting for Terra to connect…'}
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
              {!terraConnected && <span>Messages queue here until Terra reconnects.</span>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
