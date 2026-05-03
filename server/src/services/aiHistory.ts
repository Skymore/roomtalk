import { Message } from '../types';

export const MAX_CONTEXT_MESSAGES = 40;

export interface AIHistorySelectionOptions {
  editedMessageId?: string;
  retryForMessageId?: string;
  maxContextMessages?: number;
}

export interface AIHistorySelection {
  historyUsedForContext: Message[];
  contextMessages: Message[];
  truncationReason?: 'retry' | 'edit' | 'max-context';
}

export function selectAIHistory(
  fullHistory: Message[],
  options: AIHistorySelectionOptions = {}
): AIHistorySelection {
  const { editedMessageId, retryForMessageId, maxContextMessages = MAX_CONTEXT_MESSAGES } = options;
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

  const contextMessages = historyUsedForContext.length > maxContextMessages
    ? historyUsedForContext.slice(-maxContextMessages)
    : historyUsedForContext;

  return {
    historyUsedForContext,
    contextMessages,
    truncationReason: truncationReason || (contextMessages.length < historyUsedForContext.length ? 'max-context' : undefined),
  };
}

export function buildFinalAIHistory(historyUsedForContext: Message[], finalAiMessage: Message): Message[] {
  return [...historyUsedForContext, finalAiMessage];
}
