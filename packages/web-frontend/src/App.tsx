import { useState } from 'react';
import { gql, useMutation } from '@apollo/client';

const CREATE_CHAT = gql`
  mutation CreateChat($accessCode: String!, $mode: String!) {
    createChat(accessCode: $accessCode, mode: $mode)
  }
`;

export function App() {
  const [accessCode, setAccessCode] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [createChatMutation, { loading, error }] = useMutation(CREATE_CHAT);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await createChatMutation({ variables: { accessCode, mode: 'terra' } });
    if (result.data?.createChat) {
      setChatId(result.data.createChat);
    }
  };

  return (
    <main>
      <h1>Terrarium Webchat</h1>
      <p className="intro">
        Enter the access code to start a gated chat with Terra. This scaffold only wires up the
        mutation; subscriptions and the full UI will land later.
      </p>
      <form onSubmit={handleSubmit}>
        <label>
          Access Code
          <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="••••••" />
        </label>
        <button type="submit" disabled={loading || !accessCode}>
          {chatId ? 'Chat ID issued' : 'Request Chat'}
        </button>
      </form>
      {chatId && <p className="status">Chat ready: {chatId}</p>}
      {error && <p className="error">{error.message}</p>}
    </main>
  );
}
