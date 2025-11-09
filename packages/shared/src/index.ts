export type ChatMode = 'terra' | 'external';

export interface ChatMetadata {
  id: string;
  mode: ChatMode;
  createdAt: string;
  status: 'open' | 'closed' | 'error';
}

export interface MessagePayload {
  id: string;
  chatId: string;
  sender: 'Visitor' | 'Terra' | 'System';
  content: string;
  createdAt: string;
}

export const GRAPHQL_DEFAULT_PORT = 4000;
export const GRAPHQL_WS_PATH = '/graphql';

export interface ServiceConfig {
  graphqlUrl: string;
  serviceToken?: string;
}
