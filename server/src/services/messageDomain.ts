import { AIModelOption, Message, Room, RoomMemberEvent } from '../types';
import { getMessageAIModel } from './aiModels';

export interface AvatarPayload {
  text: string;
  color: string;
}

export function createRoomRecord(input: {
  roomId: string;
  name: string;
  description?: string;
  creatorId: string;
  now?: Date;
}): Room {
  return {
    id: input.roomId,
    name: input.name,
    description: input.description || '',
    createdAt: (input.now || new Date()).toISOString(),
    creatorId: input.creatorId,
  };
}

export function createRoomMemberEvent(input: {
  roomId: string;
  userId: string;
  count: number;
  action: 'join' | 'leave';
  now?: Date;
}): RoomMemberEvent {
  return {
    roomId: input.roomId,
    user: { id: input.userId },
    count: input.count,
    action: input.action,
    timestamp: (input.now || new Date()).toISOString(),
  };
}

export function createUserMessage(input: {
  id: string;
  clientId: string;
  roomId: string;
  content: string;
  messageType?: 'text' | 'image';
  username?: string;
  avatar?: AvatarPayload;
  mimeType?: string;
  now?: Date;
}): Message {
  return {
    id: input.id,
    clientId: input.clientId,
    content: input.content,
    roomId: input.roomId,
    timestamp: (input.now || new Date()).toISOString(),
    messageType: input.messageType || 'text',
    username: input.username,
    avatar: input.avatar,
    mimeType: input.mimeType,
  };
}

export function createAIPlaceholderMessage(input: {
  id: string;
  roomId: string;
  roleName?: string;
  model: AIModelOption;
  now?: Date;
}): Message {
  return {
    id: input.id,
    clientId: 'ai_assistant',
    content: '',
    roomId: input.roomId,
    timestamp: (input.now || new Date()).toISOString(),
    messageType: 'ai',
    username: input.roleName || 'AI Assistant',
    avatar: { text: 'AI', color: 'secondary' },
    status: 'streaming',
    aiModel: getMessageAIModel(input.model),
  };
}

export function applyMessageEdit(messages: Message[], messageId: string, newContent: string, now = new Date()) {
  const messageIndex = messages.findIndex(message => message.id === messageId);

  if (messageIndex === -1) {
    return { found: false as const, messages, updatedMessage: undefined };
  }

  const updatedMessage: Message = {
    ...messages[messageIndex],
    content: newContent,
    timestamp: now.toISOString(),
  };

  const updatedMessages = [...messages];
  updatedMessages[messageIndex] = updatedMessage;

  return { found: true as const, messages: updatedMessages, updatedMessage };
}

export function deleteMessageFromHistory(messages: Message[], messageId: string) {
  const found = messages.some(message => message.id === messageId);

  if (!found) {
    return { found: false as const, messages };
  }

  return {
    found: true as const,
    messages: messages.filter(message => message.id !== messageId),
  };
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

export function buildAnthropicMessages(contextMessages: Message[]): AnthropicMessage[] {
  return contextMessages
    .map((message): AnthropicMessage | null => {
      const role = message.clientId === 'ai_assistant' ? 'assistant' as const : 'user' as const;

      if (message.messageType === 'image') {
        const dataUrl = message.content.startsWith('data:')
          ? message.content
          : `data:${message.mimeType || 'image/png'};base64,${message.content}`;
        const commaIdx = dataUrl.indexOf(',');
        const header = dataUrl.slice(0, commaIdx);
        const data = dataUrl.slice(commaIdx + 1);
        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
        if (!data) return null;
        return { role, content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }] };
      }

      if (typeof message.content !== 'string' || !message.content.trim()) return null;
      return { role, content: message.content };
    })
    .filter((m): m is AnthropicMessage => m !== null);
}

type AIProviderMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{
    type: 'image_url';
    image_url: {
      url: string;
      detail: 'auto';
    };
  }>;
};

export function buildAIProviderMessages(systemPrompt: string, contextMessages: Message[]): AIProviderMessage[] {
  const messagesForAPI: AIProviderMessage[] = [
    { role: 'system', content: systemPrompt },
    ...contextMessages.map(message => {
      const role: AIProviderMessage['role'] = message.clientId === 'ai_assistant' ? 'assistant' : 'user';

      if (message.messageType === 'image') {
        const imageUrl = message.content.startsWith('data:')
          ? message.content
          : `data:${message.mimeType || 'image/png'};base64,${message.content}`;

        return {
          role,
          content: [
            {
              type: 'image_url' as const,
              image_url: {
                url: imageUrl,
                detail: 'auto' as const,
              },
            },
          ],
        };
      }

      return {
        role,
        content: message.content,
      };
    }),
  ];

  return messagesForAPI.filter(message => {
    if (Array.isArray(message.content)) {
      return message.content.length > 0 && message.content.every(item => item.type === 'image_url' && item.image_url?.url);
    }

    return typeof message.content === 'string' && message.content.trim() !== '';
  });
}
