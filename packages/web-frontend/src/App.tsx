import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gql, useMutation, useSubscription } from '@apollo/client';

const CREATE_CHAT = gql`
  mutation CreateChat($accessCode: String!, $mode: ChatMode!) {
    createChat(accessCode: $accessCode, mode: $mode) {
      id
      mode
      status
      createdAt
      updatedAt
    }
  }
`;

const SEND_VISITOR_MESSAGE = gql`
  mutation SendVisitorMessage($chatId: ID!, $content: String!, $accessCode: String!) {
    sendVisitorMessage(chatId: $chatId, content: $content, accessCode: $accessCode) {
      id
      chatId
      sender
      content
      createdAt
    }
  }
`;

const MESSAGE_STREAM = gql`
  subscription MessageStream($chatId: ID!, $accessCode: String!) {
    messageStream(chatId: $chatId, accessCode: $accessCode) {
      id
      chatId
      sender
      content
      createdAt
    }
  }
`;

type Chat = {
  id: string;
  mode: 'terra' | 'external';
  status: 'open' | 'closed' | 'error';
  createdAt: string;
  updatedAt: string;
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

export function App() {
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem('terrarium-access-code') ?? '');
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [terraConnected, setTerraConnected] = useState(false);
  const [awaitingTerra, setAwaitingTerra] = useState(false);
  const [lastAckAt, setLastAckAt] = useState<Date | null>(null);

  const messageIds = useRef<Set<string>>(new Set());
  const messageContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [createChatMutation, { loading: creating }] = useMutation(CREATE_CHAT);
  const [sendMessageMutation, { loading: sending }] = useMutation(SEND_VISITOR_MESSAGE);

  const subscriptionEnabled = Boolean(chat && accessCode.trim());

  const { data: subscriptionData } = useSubscription(MESSAGE_STREAM, {
    variables: { chatId: chat?.id ?? '', accessCode },
    skip: !subscriptionEnabled
  });

  const handleAddMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (messageIds.current.has(msg.id)) {
        return prev;
      }
      messageIds.current.add(msg.id);
      return [...prev, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, []);

  useEffect(() => {
    if (subscriptionData?.messageStream) {
      handleAddMessage(subscriptionData.messageStream);
    }
  }, [subscriptionData, handleAddMessage]);

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

  const resetChat = () => {
    setChat(null);
    setMessages([]);
    messageIds.current.clear();
  };

  const handleCreateChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessCode.trim()) {
      setFormError('Access code required');
      return;
    }
    setFormError(null);
    try {
      const result = await createChatMutation({
        variables: { accessCode, mode: 'terra' }
      });
      if (result.data?.createChat) {
        resetChat();
        setChat(result.data.createChat);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chat || !messageInput.trim()) {
      return;
    }
    try {
      const result = await sendMessageMutation({
        variables: { chatId: chat.id, content: messageInput.trim(), accessCode }
      });
      if (result.data?.sendVisitorMessage) {
        handleAddMessage(result.data.sendVisitorMessage);
        setMessageInput('');
        setAwaitingTerra(true);
        setLastAckAt(new Date(result.data.sendVisitorMessage.createdAt));
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to send message');
    }
  };

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
          <h1>Ask Terra anything.</h1>
          <p className="subheading">
            Terra is Matthew&apos;s website concierge. Enter your access code to start a private chat.
          </p>
        </div>
        <div className={`status-dot ${terraConnected ? 'status-dot--online' : 'status-dot--offline'}`}>
          {terraConnected ? 'Online' : 'Waiting'}
        </div>
      </header>

      {!chat && (
        <section className="access-panel">
          <form className="access-form" onSubmit={handleCreateChat}>
            <label>
              Access code
              <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="••••••" />
            </label>
            <button type="submit" disabled={creating || !accessCode.trim()}>
              {creating ? 'Opening…' : 'Start chat'}
            </button>
          </form>
          {formError && <p className="error">{formError}</p>}
        </section>
      )}

      <section className="chat-panel">
        {!chat && <div className="chat-placeholder">Start a chat to unlock Terra&apos;s responses.</div>}
        {chat && (
          <>
            <div className="chat-meta">
              <span>Chat ID: {chat.id.slice(0, 8)}</span>
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
                placeholder="Type a message…"
                disabled={!chat}
                rows={1}
                onInput={autoResizeTextarea}
              />
              <button type="submit" disabled={!chat || sending || !messageInput.trim()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
            <div className="status-row">
              {ackLabel && <span>{ackLabel}</span>}
              {!terraConnected && <span>Terra will answer when the worker connects.</span>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
