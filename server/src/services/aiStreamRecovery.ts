import { createHash } from 'crypto';
import { Message } from '../types';

export interface InterruptedStreamingMessageRecoveryOptions {
  aiStreamOwnerId?: string;
}

export type AIStreamTrackedMessage = Message & {
  aiStreamOwnerId?: string;
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

export const withAIStreamRecoveryMetadata = (message: Message, aiStreamOwnerId?: string): AIStreamTrackedMessage => {
  if (!aiStreamOwnerId) {
    return message;
  }

  return {
    ...message,
    aiStreamOwnerId,
  };
};

export const getAIStreamOwnerId = (message: Message): string | undefined =>
  (message as AIStreamTrackedMessage).aiStreamOwnerId;

export const stripAIStreamRecoveryMetadata = (message: Message): Message => {
  const { aiStreamOwnerId: _aiStreamOwnerId, ...publicMessage } = message as AIStreamTrackedMessage;
  return publicMessage;
};
