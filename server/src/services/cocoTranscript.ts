import { Message } from '../types';
import { CocoRunnerPriorMessage } from './cocoRunnerProtocol';

type CocoPriorBlock = Exclude<CocoRunnerPriorMessage['content'], string>[number];

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const appendAssistantBlock = (messages: CocoRunnerPriorMessage[], block: CocoPriorBlock) => {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    last.content.push(block);
    return;
  }

  messages.push({ role: 'assistant', content: [block] });
};

const appendToolResultBlock = (messages: CocoRunnerPriorMessage[], block: CocoPriorBlock) => {
  const last = messages[messages.length - 1];
  if (
    last?.role === 'user' &&
    Array.isArray(last.content) &&
    last.content.every(item => item.type === 'tool_result')
  ) {
    last.content.push(block);
    return;
  }

  messages.push({ role: 'user', content: [block] });
};

export const buildCocoPriorMessages = (messages: Message[]): CocoRunnerPriorMessage[] => {
  const priorMessages: CocoRunnerPriorMessage[] = [];
  const completedToolCallIds = new Set(
    messages
      .filter(message => message.messageType === 'tool_result' && message.toolCallId)
      .map(message => message.toolCallId as string)
  );
  const emittedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.messageType === 'text') {
      if (isNonEmptyText(message.content)) {
        priorMessages.push({ role: 'user', content: message.content.trim() });
      }
      continue;
    }

    if (message.messageType === 'ai') {
      if (message.status === 'streaming' || message.status === 'error') {
        continue;
      }
      if (isNonEmptyText(message.content)) {
        appendAssistantBlock(priorMessages, { type: 'text', text: message.content });
      }
      continue;
    }

    if (message.messageType === 'tool_call') {
      if (!message.toolCallId || !message.toolName) {
        continue;
      }
      if (!completedToolCallIds.has(message.toolCallId)) {
        continue;
      }
      appendAssistantBlock(priorMessages, {
        type: 'tool_use',
        id: message.toolCallId,
        name: message.toolName,
        input: message.toolArgs || {},
      });
      emittedToolCallIds.add(message.toolCallId);
      continue;
    }

    if (message.messageType === 'tool_result') {
      if (!message.toolCallId) {
        continue;
      }
      if (!emittedToolCallIds.has(message.toolCallId)) {
        continue;
      }
      const content = isNonEmptyText(message.content)
        ? message.content
        : message.toolOutputPreview || '';
      appendToolResultBlock(priorMessages, {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content,
        ...(message.isError || message.status === 'error' ? { is_error: true } : {}),
      });
    }
  }

  return priorMessages.filter(message => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0;
    }
    return message.content.length > 0;
  });
};
