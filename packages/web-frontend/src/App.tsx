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

  const messageIds = useRef<Set<string>>(new Set());

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
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to send message');
    }
  };

  const messageList = useMemo(() => {
    if (!messages.length) {
      return <p className="empty">No messages yet. Ask Terra something once the worker is online.</p>;
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
  }, [messages]);

  return (
    <main>
      <header>
        <h1>Terrarium Webchat</h1>
        <p>Use your private access code to open a session with Terra.</p>
      </header>

      <section className="panel">
        <form className="access-form" onSubmit={handleCreateChat}>
          <label>
            Access code
            <input
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="••••••"
            />
          </label>
          <button type="submit" disabled={creating || !accessCode.trim()}>
            {chat ? 'Regenerate chat' : 'Start chat'}
          </button>
        </form>
        {formError && <p className="error">{formError}</p>}
        {chat && (
          <p className="status">
            Chat <code>{chat.id}</code> ({chat.status})
          </p>
        )}
      </section>

      <section className="panel">
        <div className="log" aria-live="polite">
          {messageList}
        </div>
        <form className="composer" onSubmit={handleSendMessage}>
          <textarea
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            placeholder={chat ? 'Ask Terra about mbabbott.com…' : 'Start a chat to enable messaging'}
            disabled={!chat}
            rows={3}
          />
          <button type="submit" disabled={!chat || sending || !messageInput.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </section>
    </main>
  );
}
