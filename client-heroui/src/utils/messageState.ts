import { A2UIPayload, Message } from "./types";

export const sortMessages = (messages: Message[]) => {
  return [...messages].sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();

    const safeTimeA = Number.isFinite(timeA) ? timeA : 0;
    const safeTimeB = Number.isFinite(timeB) ? timeB : 0;

    if (safeTimeA !== safeTimeB) {
      return safeTimeA - safeTimeB;
    }

    const aIsStreamingAi = a.clientId === "ai_assistant" && a.status === "streaming";
    const bIsStreamingAi = b.clientId === "ai_assistant" && b.status === "streaming";

    if (aIsStreamingAi !== bIsStreamingAi) {
      return aIsStreamingAi ? 1 : -1;
    }

    return a.id.localeCompare(b.id);
  });
};

export const markMessageSent = (message: Message): Message => ({
  ...message,
  deliveryStatus: message.deliveryStatus === "failed" ? "failed" : "sent",
  deliveryError: undefined,
});

export const upsertMessage = (messages: Message[], message: Message) => {
  const serverMessage = message.clientMessageId ? markMessageSent(message) : message;

  if (serverMessage.clientMessageId) {
    const clientMessageIndex = messages.findIndex(existing =>
      existing.clientMessageId === serverMessage.clientMessageId
    );

    if (clientMessageIndex !== -1) {
      const next = [...messages];
      const optimisticAction = messages[clientMessageIndex].deliveryAction;
      next[clientMessageIndex] = serverMessage.deliveryAction || !optimisticAction
        ? serverMessage
        : { ...serverMessage, deliveryAction: optimisticAction };
      return sortMessages(next);
    }
  }

  const idIndex = messages.findIndex(existing => existing.id === serverMessage.id);
  if (idIndex !== -1) {
    const next = [...messages];
    next[idIndex] = serverMessage;
    return sortMessages(next);
  }

  return sortMessages([...messages, serverMessage]);
};

export const addOptimisticMessage = (messages: Message[], optimisticMessage: Message) => {
  if (messages.some(message => message.id === optimisticMessage.id)) {
    return messages;
  }

  if (
    optimisticMessage.clientMessageId &&
    messages.some(message => message.clientMessageId === optimisticMessage.clientMessageId)
  ) {
    return messages;
  }

  return sortMessages([...messages, optimisticMessage]);
};

export const replaceOptimisticMessage = (
  messages: Message[],
  clientMessageId: string,
  savedMessage: Message
) => {
  return upsertMessage(messages, { ...savedMessage, clientMessageId });
};

export const markOptimisticMessageFailed = (
  messages: Message[],
  clientMessageId: string,
  deliveryError?: string
) => {
  return messages.map(message =>
    message.clientMessageId === clientMessageId && message.deliveryStatus === "pending"
      ? { ...message, deliveryStatus: "failed" as const, deliveryError }
      : message
  );
};

export const getMessageById = (messages: Message[], messageId: string) => {
  return messages.find(message => message.id === messageId) || null;
};

export const editMessageContent = (messages: Message[], messageId: string, newContent: string) => {
  return messages.map(message => {
    if (message.id !== messageId) {
      return message;
    }

    const { uiPayload: _uiPayload, ...rest } = message;
    return { ...rest, content: newContent };
  });
};

export const replaceMessage = (messages: Message[], updatedMessage: Message) => {
  return messages.map(message =>
    message.id === updatedMessage.id ? updatedMessage : message
  );
};

export const deleteMessageById = (messages: Message[], messageId: string) => {
  return messages.filter(message => message.id !== messageId);
};

export const editMessageAndTruncateAfter = (
  messages: Message[],
  messageId: string,
  newContent: string
): { found: boolean; messages: Message[] } => {
  const messageIndex = messages.findIndex(message => message.id === messageId);
  if (messageIndex === -1) {
    return { found: false, messages };
  }

  const { uiPayload: _uiPayload, ...editedMessage } = messages[messageIndex];
  return {
    found: true,
    messages: [
      ...messages.slice(0, messageIndex),
      { ...editedMessage, content: newContent },
    ],
  };
};

export const truncateBeforeMessage = (
  messages: Message[],
  messageId: string
): { found: boolean; messages: Message[] } => {
  const messageIndex = messages.findIndex(message => message.id === messageId);
  if (messageIndex === -1) {
    return { found: false, messages };
  }

  return { found: true, messages: messages.slice(0, messageIndex) };
};

export const appendAIChunk = (messages: Message[], messageId: string, chunk: string) => {
  return messages.map(message =>
    message.id === messageId
      ? { ...message, content: (message.content || "") + chunk, status: "streaming" as const }
      : message
  );
};

const mergeA2UIPayloads = (current: A2UIPayload | undefined, incoming: A2UIPayload): A2UIPayload => {
  if (!current || current.format !== incoming.format || current.version !== incoming.version) {
    return incoming;
  }

  return {
    ...current,
    messages: [...current.messages, ...incoming.messages],
  };
};

export const appendA2UIPayload = (messages: Message[], messageId: string, uiPayload?: A2UIPayload) => {
  if (!uiPayload) return messages;

  return messages.map(message =>
    message.id === messageId
      ? {
          ...message,
          uiPayload: mergeA2UIPayloads(message.uiPayload, uiPayload),
        }
      : message
  );
};

export const completeAIMessage = (
  messages: Message[],
  messageId: string,
  updates: Pick<Message, "aiModel" | "usage" | "cost" | "uiPayload"> & { content?: string }
) => {
  return messages.map(message =>
    message.id === messageId
      ? {
          ...message,
          content: updates.content ?? message.content,
          status: "complete" as const,
          aiModel: updates.aiModel ?? message.aiModel,
          usage: updates.usage ?? message.usage,
          cost: updates.cost ?? message.cost,
          uiPayload: updates.uiPayload ?? message.uiPayload,
        }
      : message
  );
};
