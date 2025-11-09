import { randomUUID } from 'crypto';

export type ChatMode = 'terra' | 'external';
export type ChatStatus = 'open' | 'closed' | 'error';

export interface ChatRecord {
  id: string;
  mode: ChatMode;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  sender: string;
  content: string;
  createdAt: string;
}

export interface StoreOptions {
  ttlHours: number;
}

export class InMemoryChatStore {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly ttlMs: number;

  constructor(options: StoreOptions) {
    this.ttlMs = options.ttlHours * 60 * 60 * 1000;
  }

  createChat(mode: ChatMode): ChatRecord {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: randomUUID(),
      mode,
      status: 'open',
      createdAt: now,
      updatedAt: now
    };
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    this.prune();
    return chat;
  }

  getChat(id: string): ChatRecord | undefined {
    const chat = this.chats.get(id);
    if (!chat) return undefined;
    if (this.isExpired(chat)) {
      this.deleteChat(id);
      return undefined;
    }
    return chat;
  }

  appendMessage(chatId: string, sender: string, content: string): MessageRecord {
    const chat = this.getChat(chatId);
    if (!chat) {
      throw new Error('Chat not found or expired');
    }
    const message: MessageRecord = {
      id: randomUUID(),
      chatId,
      sender,
      content,
      createdAt: new Date().toISOString()
    };
    const list = this.messages.get(chatId);
    if (!list) {
      throw new Error('Message buffer missing for chat');
    }
    list.push(message);
    chat.updatedAt = message.createdAt;
    return message;
  }

  closeChat(chatId: string, status: ChatStatus = 'closed'): ChatRecord | undefined {
    const chat = this.getChat(chatId);
    if (!chat) return undefined;
    chat.status = status;
    chat.updatedAt = new Date().toISOString();
    return chat;
  }

  listMessages(chatId: string): MessageRecord[] {
    return [...(this.messages.get(chatId) ?? [])];
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, chat] of this.chats.entries()) {
      if (now - Date.parse(chat.updatedAt) > this.ttlMs) {
        this.deleteChat(id);
      }
    }
  }

  private isExpired(chat: ChatRecord): boolean {
    return Date.now() - Date.parse(chat.updatedAt) > this.ttlMs;
  }

  private deleteChat(chatId: string): void {
    this.chats.delete(chatId);
    this.messages.delete(chatId);
  }
}
