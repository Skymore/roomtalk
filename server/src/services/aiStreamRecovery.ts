import { createHash } from 'crypto';
import { Message } from '../types';

export interface InterruptedStreamingMessageRecoveryOptions {
  aiStreamOwnerId?: string;
}

export type AIStreamTrackedMessage = Message & {
  aiStreamOwnerId?: string;
  aiStreamFence?: number;
};

export const resolveAIStreamOwnerId = (env: NodeJS.ProcessEnv = process.env, runtimeInstanceId?: string): string => {
  const ownerNamespace = env.AI_STREAM_OWNER_ID || env.ROOMTALK_STREAM_OWNER_ID || 'roomtalk-ai-stream';
  const instanceIdentity = runtimeInstanceId
    || env.FLY_MACHINE_ID
    || env.HOSTNAME
    || `process:${process.pid}`;
  const rawOwnerId = `${ownerNamespace}:${instanceIdentity}`;

  return createHash('sha256').update(rawOwnerId).digest('hex').slice(0, 32);
};

export const withAIStreamRecoveryMetadata = (
  message: Message,
  aiStreamOwnerId?: string,
  aiStreamFence = 0,
): AIStreamTrackedMessage => {
  if (!aiStreamOwnerId) {
    return message;
  }

  return {
    ...message,
    aiStreamOwnerId,
    aiStreamFence,
  };
};

export const getAIStreamOwnerId = (message: Message): string | undefined =>
  (message as AIStreamTrackedMessage).aiStreamOwnerId;

export const getAIStreamFence = (message: Message): number => {
  const fence = (message as AIStreamTrackedMessage).aiStreamFence;
  return Number.isSafeInteger(fence) && Number(fence) >= 0 ? Number(fence) : 0;
};

export const stripAIStreamRecoveryMetadata = (message: Message): Message => {
  const {
    aiStreamOwnerId: _aiStreamOwnerId,
    aiStreamFence: _aiStreamFence,
    ...publicMessage
  } = message as AIStreamTrackedMessage;
  return publicMessage;
};
