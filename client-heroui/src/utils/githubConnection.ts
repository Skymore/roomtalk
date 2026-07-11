import { apiPath } from './apiBase';

export interface GitHubConnectionStatus {
  clientId: string;
  provider: 'github';
  status: 'connected' | 'reauth_required' | 'disconnected';
  authVersion: number;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
  account?: {
    id: number;
    login: string;
    name?: string;
    avatarUrl?: string;
  };
}

const clientHeaders = (clientId: string): Record<string, string> => {
  const headers: Record<string, string> = { 'X-Client-Id': clientId };
  const token = localStorage.getItem('clientAuthToken')?.trim();
  if (token) headers['X-Client-Auth-Token'] = token;
  return headers;
};

const parseApiError = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json();
    return typeof payload?.error === 'string' ? payload.error : fallback;
  } catch {
    return fallback;
  }
};

export const getGitHubConnectionStatus = async (clientId: string): Promise<GitHubConnectionStatus> => {
  const response = await fetch(apiPath('/api/github/connection'), {
    cache: 'no-store',
    headers: clientHeaders(clientId),
  });
  if (!response.ok) throw new Error(await parseApiError(response, 'Failed to load GitHub connection status'));
  return response.json() as Promise<GitHubConnectionStatus>;
};

export const connectGitHub = async (clientId: string, token: string): Promise<GitHubConnectionStatus> => {
  const response = await fetch(apiPath('/api/github/connection'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...clientHeaders(clientId) },
    body: JSON.stringify({ clientId, token }),
  });
  if (!response.ok) throw new Error(await parseApiError(response, 'Failed to connect GitHub'));
  return response.json() as Promise<GitHubConnectionStatus>;
};

export const disconnectGitHub = async (clientId: string): Promise<GitHubConnectionStatus> => {
  const response = await fetch(apiPath('/api/github/connection'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...clientHeaders(clientId) },
    body: JSON.stringify({ clientId }),
  });
  if (!response.ok) throw new Error(await parseApiError(response, 'Failed to disconnect GitHub'));
  return response.json() as Promise<GitHubConnectionStatus>;
};
