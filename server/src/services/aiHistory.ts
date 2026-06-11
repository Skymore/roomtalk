import { Message } from '../types';

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// How many of the most recent messages are sent to the model as context.
// Override in prod with AI_MAX_CONTEXT_MESSAGES without a code change.
export const MAX_CONTEXT_MESSAGES = parsePositiveInt(process.env.AI_MAX_CONTEXT_MESSAGES, 1000);
export const MAX_CONTEXT_TOKENS = parsePositiveInt(process.env.AI_MAX_CONTEXT_TOKENS, 32000);

const MESSAGE_CONTEXT_OVERHEAD_TOKENS = 16;
const CJK_CHARACTER_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

export interface AIHistorySelectionOptions {
  editedMessageId?: string;
  retryForMessageId?: string;
  maxContextMessages?: number;
  maxContextTokens?: number;
}

export interface AIHistorySelection {
  historyUsedForContext: Message[];
  contextMessages: Message[];
  contextTokenEstimate: number;
  truncationReason?: 'retry' | 'edit' | 'max-context';
}

const estimateTextTokens = (text: string): number => {
  const normalized = text.trim();
  if (!normalized) return 0;

  const cjkCharacterCount = normalized.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  const nonCjkText = normalized.replace(CJK_CHARACTER_PATTERN, '');
  return Math.max(1, cjkCharacterCount + Math.ceil(nonCjkText.length / 4));
};

const estimateMessageTokens = (message: Message): number => {
  const mediaLabel = message.messageType === 'media' ? `[${message.mediaAsset?.kind || 'media'} attachment]` : '';
  let total = MESSAGE_CONTEXT_OVERHEAD_TOKENS + estimateTextTokens(mediaLabel || message.content || '');

  if (message.username) {
    total += estimateTextTokens(message.username);
  }
  if (message.replyTo) {
    total += 8 + estimateTextTokens(message.replyTo.preview);
  }

  return Math.max(1, total);
};

const fitMessagesWithinTokenBudget = (messages: Message[], maxContextTokens: number) => {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
    return {
      contextMessages: messages,
      contextTokenEstimate: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    };
  }

  const selected: Message[] = [];
  let contextTokenEstimate = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimateMessageTokens(message);
    if (selected.length > 0 && contextTokenEstimate + messageTokens > maxContextTokens) {
      break;
    }

    selected.push(message);
    contextTokenEstimate += messageTokens;
  }

  return {
    contextMessages: selected.reverse(),
    contextTokenEstimate,
  };
};

export function selectAIHistory(
  fullHistory: Message[],
  options: AIHistorySelectionOptions = {}
): AIHistorySelection {
  const {
    editedMessageId,
    retryForMessageId,
    maxContextMessages = MAX_CONTEXT_MESSAGES,
    maxContextTokens = MAX_CONTEXT_TOKENS,
  } = options;
  let historyUsedForContext = fullHistory;
  let truncationReason: AIHistorySelection['truncationReason'];

  if (retryForMessageId) {
    const retryIndex = historyUsedForContext.findIndex(message => message.id === retryForMessageId);
    if (retryIndex !== -1) {
      historyUsedForContext = historyUsedForContext.slice(0, retryIndex);
      truncationReason = 'retry';
    }
  } else if (editedMessageId) {
    const editIndex = historyUsedForContext.findIndex(message => message.id === editedMessageId);
    if (editIndex !== -1) {
      historyUsedForContext = historyUsedForContext.slice(0, editIndex + 1);
      truncationReason = 'edit';
    }
  }

  const messageLimitedContext = historyUsedForContext.length > maxContextMessages
    ? historyUsedForContext.slice(-maxContextMessages)
    : historyUsedForContext;
  const { contextMessages, contextTokenEstimate } = fitMessagesWithinTokenBudget(messageLimitedContext, maxContextTokens);

  return {
    historyUsedForContext,
    contextMessages,
    contextTokenEstimate,
    truncationReason: truncationReason || (contextMessages.length < historyUsedForContext.length ? 'max-context' : undefined),
  };
}

export function buildFinalAIHistory(historyUsedForContext: Message[], finalAiMessage: Message): Message[] {
  return [...historyUsedForContext, finalAiMessage];
}
