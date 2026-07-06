import { Message } from '../types';
import { CodeAgentRunnerPriorMessage } from './codeAgentRunnerProtocol';

type CodeAgentPriorBlock = Exclude<CodeAgentRunnerPriorMessage['content'], string>[number];

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const appendAssistantBlock = (messages: CodeAgentRunnerPriorMessage[], block: CodeAgentPriorBlock) => {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    last.content.push(block);
    return;
  }

  messages.push({ role: 'assistant', content: [block] });
};

const appendToolResultBlock = (messages: CodeAgentRunnerPriorMessage[], block: CodeAgentPriorBlock) => {
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

export const buildCodeAgentPriorMessages = (messages: Message[]): CodeAgentRunnerPriorMessage[] => {
  const priorMessages: CodeAgentRunnerPriorMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
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
      const calls: Message[] = [];
      while (index < messages.length && messages[index].messageType === 'tool_call') {
        calls.push(messages[index]);
        index += 1;
      }

      const results: Message[] = [];
      while (index < messages.length && messages[index].messageType === 'tool_result') {
        results.push(messages[index]);
        index += 1;
      }
      index -= 1;

      const resultByCallId = new Map(
        results
          .filter(result => result.toolCallId)
          .map(result => [result.toolCallId as string, result])
      );
      const matchedCalls = calls.filter(call => (
        call.toolCallId &&
        call.toolName &&
        resultByCallId.has(call.toolCallId)
      ));
      if (matchedCalls.length === 0) {
        continue;
      }

      for (const call of matchedCalls) {
        appendAssistantBlock(priorMessages, {
          type: 'tool_use',
          id: call.toolCallId!,
          name: call.toolName!,
          input: call.toolArgs || {},
        });
      }
      for (const call of matchedCalls) {
        const result = resultByCallId.get(call.toolCallId!);
        if (!result) {
          continue;
        }
        const content = isNonEmptyText(result.content)
          ? result.content
          : result.toolOutputPreview || '';
        appendToolResultBlock(priorMessages, {
          type: 'tool_result',
          tool_use_id: call.toolCallId!,
          content,
          ...(result.isError || result.status === 'error' ? { is_error: true } : {}),
        });
      }
      continue;
    }
  }

  return priorMessages.filter(message => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0;
    }
    return message.content.length > 0;
  });
};
