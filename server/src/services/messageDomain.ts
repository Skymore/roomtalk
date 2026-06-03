import { AIModelOption, Message, MessageReplyReference, Room, RoomMemberEvent } from '../types';
import { getMessageAIModel } from './aiModels';

const MAX_DISPLAY_NAME_LENGTH = 48;
const MAX_REPLY_PREVIEW_LENGTH = 120;

export interface AvatarPayload {
  text: string;
  color: string;
}

const collapseInlineText = (value: string) => value
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function normalizeDisplayName(username?: string): string | undefined {
  if (typeof username !== 'string') return undefined;
  const normalized = collapseInlineText(username).slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return normalized || undefined;
}

export function createReplyReference(message: Message): MessageReplyReference {
  const textualPreview = message.messageType === 'image'
    ? '[Image attachment]'
    : message.messageType === 'voice'
      ? '[Voice message]'
      : collapseInlineText(message.content);
  const preview = textualPreview.slice(0, MAX_REPLY_PREVIEW_LENGTH).trim() || '[Empty message]';

  return {
    messageId: message.id,
    username: normalizeDisplayName(message.username),
    messageType: message.messageType,
    preview,
  };
}

export function createRoomRecord(input: {
  roomId: string;
  name: string;
  description?: string;
  creatorId: string;
  now?: Date;
}): Room {
  const timestamp = (input.now || new Date()).toISOString();
  return {
    id: input.roomId,
    name: input.name,
    description: input.description || '',
    createdAt: timestamp,
    lastActivityAt: timestamp,
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
  messageType?: 'text' | 'image' | 'voice';
  username?: string;
  avatar?: AvatarPayload;
  mimeType?: string;
  replyTo?: MessageReplyReference;
  clientMessageId?: string;
  now?: Date;
}): Message {
  return {
    id: input.id,
    clientId: input.clientId,
    content: input.content,
    roomId: input.roomId,
    timestamp: (input.now || new Date()).toISOString(),
    messageType: input.messageType || 'text',
    username: normalizeDisplayName(input.username),
    avatar: input.avatar,
    mimeType: input.mimeType,
    replyTo: input.replyTo,
    clientMessageId: input.clientMessageId,
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

const getDisplayNameForAI = (message: Pick<Message, 'clientId' | 'username'>) => (
  normalizeDisplayName(message.username)
  || (message.clientId === 'ai_assistant' ? 'AI Assistant' : 'Participant')
);

const getReplyDisplayNameForAI = (replyTo: MessageReplyReference) => (
  normalizeDisplayName(replyTo.username)
  || (replyTo.messageType === 'ai' ? 'AI Assistant' : 'Participant')
);

const formatHumanContextForAI = (message: Message, content: string) => {
  const lines = [`[Sender: ${getDisplayNameForAI(message)}]`];
  if (message.replyTo) {
    const preview = collapseInlineText(message.replyTo.preview).slice(0, MAX_REPLY_PREVIEW_LENGTH).trim() || '[Empty message]';
    lines.push(`[Replying to ${getReplyDisplayNameForAI(message.replyTo)}: ${preview}]`);
  }
  lines.push(content);
  return lines.join('\n');
};

export function buildAnthropicMessages(contextMessages: Message[]): AnthropicMessage[] {
  return contextMessages
    .map((message): AnthropicMessage | null => {
      const role = message.clientId === 'ai_assistant' ? 'assistant' as const : 'user' as const;

      if (message.messageType === 'image') {
        if (message.imageAsset) {
          return role === 'user'
            ? { role, content: formatHumanContextForAI(message, '[Image attachment]') }
            : null;
        }

        const dataUrl = message.content.startsWith('data:')
          ? message.content
          : `data:${message.mimeType || 'image/png'};base64,${message.content}`;
        const commaIdx = dataUrl.indexOf(',');
        const header = dataUrl.slice(0, commaIdx);
        const data = dataUrl.slice(commaIdx + 1);
        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
        if (!data) return null;
        const blocks: AnthropicContentBlock[] = [];
        if (role === 'user') {
          blocks.push({ type: 'text', text: formatHumanContextForAI(message, '[Image attachment]') });
        }
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
        return { role, content: blocks };
      }

      if (message.messageType === 'voice') {
        return role === 'user'
          ? { role, content: formatHumanContextForAI(message, '[Voice message]') }
          : null;
      }

      if (typeof message.content !== 'string' || !message.content.trim()) return null;
      return {
        role,
        content: role === 'user' ? formatHumanContextForAI(message, message.content) : message.content,
      };
    })
    .filter((m): m is AnthropicMessage => m !== null);
}

type AIProviderMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{
    type: 'text';
    text: string;
  } | {
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
        if (message.imageAsset) {
          return {
            role,
            content: role === 'user' ? formatHumanContextForAI(message, '[Image attachment]') : '[Image attachment]',
          };
        }

        const imageUrl = message.content.startsWith('data:')
          ? message.content
          : `data:${message.mimeType || 'image/png'};base64,${message.content}`;

        return {
          role,
          content: [
            ...(role === 'user'
              ? [{ type: 'text' as const, text: formatHumanContextForAI(message, '[Image attachment]') }]
              : []),
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

      if (message.messageType === 'voice') {
        return {
          role,
          content: role === 'user' ? formatHumanContextForAI(message, '[Voice message]') : '[Voice message]',
        };
      }

      if (typeof message.content !== 'string' || !message.content.trim()) {
        return { role, content: '' };
      }

      return {
        role,
        content: role === 'user' ? formatHumanContextForAI(message, message.content) : message.content,
      };
    }),
  ];

  return messagesForAPI.filter(message => {
    if (Array.isArray(message.content)) {
      return message.content.some(item => item.type === 'image_url' && item.image_url?.url);
    }

    return typeof message.content === 'string' && message.content.trim() !== '';
  });
}
