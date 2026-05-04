import { Message } from "./types";

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

export const upsertMessage = (messages: Message[], message: Message) => {
  if (messages.some(existing => existing.id === message.id)) {
    return messages;
  }

  return sortMessages([...messages, message]);
};

export const getMessageById = (messages: Message[], messageId: string) => {
  return messages.find(message => message.id === messageId) || null;
};

export const editMessageContent = (messages: Message[], messageId: string, newContent: string) => {
  return messages.map(message =>
    message.id === messageId ? { ...message, content: newContent } : message
  );
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

  return {
    found: true,
    messages: [
      ...messages.slice(0, messageIndex),
      { ...messages[messageIndex], content: newContent },
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

export const completeAIMessage = (
  messages: Message[],
  messageId: string,
  updates: Pick<Message, "aiModel" | "usage" | "cost">
) => {
  return messages.map(message =>
    message.id === messageId
      ? {
          ...message,
          status: "complete" as const,
          aiModel: updates.aiModel ?? message.aiModel,
          usage: updates.usage ?? message.usage,
          cost: updates.cost ?? message.cost,
        }
      : message
  );
};
