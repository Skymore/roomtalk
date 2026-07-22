import { randomUUID } from 'crypto';

export const resolveRuntimeInstanceId = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.ROOMTALK_INSTANCE_ID?.trim();
  if (configured) return configured;

  const host = env.HOSTNAME?.trim() || 'local';
  return `${host}:${process.pid}:${randomUUID()}`;
};
