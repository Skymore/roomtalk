import { apiPath } from './apiBase';

export type CodexConnectionStatusValue = 'pending' | 'connected' | 'reauth_required' | 'disconnected';

export interface CodexConnectionStatus {
  clientId: string;
  provider: 'codex';
  status: CodexConnectionStatusValue;
  authVersion: number;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  locked: boolean;
  lastError?: string;
}

export interface CodexDeviceAuthInfo {
  url: string;
  code: string;
  expiresAt?: string;
}

export interface CodexDeviceAuthStartResult {
  clientId: string;
  provider: 'codex';
  status: 'pending';
  deviceAuth: CodexDeviceAuthInfo;
}

export interface CodexDeviceAuthCancelResult {
  clientId: string;
  provider: 'codex';
  cancelled: boolean;
  status: CodexConnectionStatus;
}

const clientHeaders = (clientId: string): Record<string, string> => {
  const headers: Record<string, string> = { 'X-Client-Id': clientId };
  const token = localStorage.getItem('clientAuthToken')?.trim();
  if (token) {
    headers['X-Client-Auth-Token'] = token;
  }
  return headers;
};

const parseApiError = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json();
    if (typeof payload?.error === 'string') {
      return payload.error;
    }
  } catch {
    // Ignore non-JSON error bodies.
  }
  return fallback;
};

export const getCodexConnectionStatus = async (clientId: string): Promise<CodexConnectionStatus> => {
  const response = await fetch(apiPath('/api/codex/connection'), {
    cache: 'no-store',
    headers: clientHeaders(clientId),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to load Codex connection status'));
  }
  return response.json() as Promise<CodexConnectionStatus>;
};

export const startCodexDeviceAuth = async (clientId: string): Promise<CodexDeviceAuthStartResult> => {
  const response = await fetch(apiPath('/api/codex/connection/device-auth'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...clientHeaders(clientId),
    },
    body: JSON.stringify({ clientId }),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to start Codex login'));
  }
  return response.json() as Promise<CodexDeviceAuthStartResult>;
};

export const cancelCodexDeviceAuth = async (clientId: string): Promise<CodexDeviceAuthCancelResult> => {
  const response = await fetch(apiPath('/api/codex/connection/device-auth'), {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...clientHeaders(clientId),
    },
    body: JSON.stringify({ clientId }),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to cancel Codex login'));
  }
  return response.json() as Promise<CodexDeviceAuthCancelResult>;
};

export const disconnectCodexConnection = async (clientId: string): Promise<CodexConnectionStatus> => {
  const response = await fetch(apiPath('/api/codex/connection'), {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...clientHeaders(clientId),
    },
    body: JSON.stringify({ clientId }),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response, 'Failed to disconnect Codex'));
  }
  return response.json() as Promise<CodexConnectionStatus>;
};
