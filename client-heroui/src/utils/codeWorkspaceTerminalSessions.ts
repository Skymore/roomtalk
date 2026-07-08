import {
  onCodeWorkspaceTerminalEvent,
  requestCloseCodeWorkspaceTerminalSession,
  requestCodeWorkspaceTerminalSessions,
  requestInputCodeWorkspaceTerminalSession,
  requestOpenCodeWorkspaceTerminalSession,
  requestResizeCodeWorkspaceTerminalSession,
  type CodeWorkspaceTerminalEvent,
} from './socket';

export type CodeWorkspaceTerminalStatus = 'running' | 'closed' | 'exited';

export interface CodeWorkspaceTerminalSession {
  roomId: string;
  terminalId: string;
  status: CodeWorkspaceTerminalStatus;
  cols: number;
  rows: number;
  pid?: number;
  output: string;
  updatedAt: string;
}

export type CodeWorkspaceTerminalSessionEvent = Omit<CodeWorkspaceTerminalEvent, 'snapshot'> & {
  snapshot?: CodeWorkspaceTerminalSession;
};

const coerceTerminalStatus = (value: unknown): CodeWorkspaceTerminalStatus => (
  value === 'closed' || value === 'exited' ? value : 'running'
);

export const validateCodeWorkspaceTerminalSession = (
  value: unknown,
): CodeWorkspaceTerminalSession => {
  if (!value || typeof value !== 'object') {
    throw new Error('Workspace terminal session response is invalid');
  }
  const session = value as Partial<CodeWorkspaceTerminalSession>;
  if (typeof session.roomId !== 'string' || typeof session.terminalId !== 'string') {
    throw new Error('Workspace terminal session response is invalid');
  }
  const cols = Number((value as { cols?: unknown }).cols);
  const rows = Number((value as { rows?: unknown }).rows);
  const pid = Number((value as { pid?: unknown }).pid);
  return {
    roomId: session.roomId,
    terminalId: session.terminalId,
    status: coerceTerminalStatus(session.status),
    cols: Number.isFinite(cols) ? Math.trunc(cols) : 80,
    rows: Number.isFinite(rows) ? Math.trunc(rows) : 24,
    ...(Number.isFinite(pid) ? { pid: Math.trunc(pid) } : {}),
    output: typeof session.output === 'string' ? session.output : '',
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date(0).toISOString(),
  };
};

export const openCodeWorkspaceTerminalSession = async (payload: {
  roomId: string;
  terminalId?: string;
  cols?: number;
  rows?: number;
}): Promise<CodeWorkspaceTerminalSession> => (
  validateCodeWorkspaceTerminalSession(await requestOpenCodeWorkspaceTerminalSession(payload))
);

export const inputCodeWorkspaceTerminalSession = requestInputCodeWorkspaceTerminalSession;

export const resizeCodeWorkspaceTerminalSession = async (payload: {
  roomId: string;
  terminalId: string;
  cols: number;
  rows: number;
}): Promise<CodeWorkspaceTerminalSession> => (
  validateCodeWorkspaceTerminalSession(await requestResizeCodeWorkspaceTerminalSession(payload))
);

export const closeCodeWorkspaceTerminalSession = async (payload: {
  roomId: string;
  terminalId: string;
}): Promise<CodeWorkspaceTerminalSession | null> => {
  const session = await requestCloseCodeWorkspaceTerminalSession(payload);
  return session ? validateCodeWorkspaceTerminalSession(session) : null;
};

export const listCodeWorkspaceTerminalSessions = async (
  roomId: string,
): Promise<CodeWorkspaceTerminalSession[]> => (
  (await requestCodeWorkspaceTerminalSessions(roomId)).map(validateCodeWorkspaceTerminalSession)
);

export const subscribeCodeWorkspaceTerminalEvents = (
  roomId: string,
  callback: (event: CodeWorkspaceTerminalSessionEvent) => void,
) => onCodeWorkspaceTerminalEvent((event) => {
  if (event.roomId !== roomId) {
    return;
  }
  callback({
    ...event,
    snapshot: event.snapshot ? validateCodeWorkspaceTerminalSession(event.snapshot) : undefined,
  });
});
