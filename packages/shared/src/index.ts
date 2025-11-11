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

export const REST_DEFAULT_PORT = 4000;
export const REST_API_BASE_PATH = '/api';

export interface ServiceConfig {
  apiBaseUrl: string;
  serviceToken?: string;
}
