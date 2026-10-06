import { apiPath } from './apiBase';
import type { Room } from './types';

export interface PersonalAgentProfile {
  clientId: string;
  name: string;
  avatar: string;
  instructions: string;
  memory: string;
  mainRoomId: string;
  createdAt: string;
  updatedAt: string;
}

export type PersonalAgentSchedule = 'manual' | 'daily' | 'weekly';

export interface PersonalAgentGoal {
  id: string;
  clientId: string;
  title: string;
  prompt: string;
  schedule: PersonalAgentSchedule;
  time: string;
  timezone: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunRoomId?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentSnapshot {
  profile: PersonalAgentProfile;
  rooms: Room[];
  goals: PersonalAgentGoal[];
}

export type PersonalAgentGoalInput = Pick<PersonalAgentGoal, 'title' | 'prompt' | 'schedule' | 'time' | 'timezone'>;

const request = async <T>(clientId: string, path: string, method = 'GET', data?: Record<string, unknown>): Promise<T> => {
  const token = localStorage.getItem('clientAuthToken')?.trim();
  const response = await fetch(apiPath(`/api/personal-agent${path}`), {
    method,
    cache: 'no-store',
    headers: {
      'X-Client-Id': clientId,
      ...(token ? { 'X-Client-Auth-Token': token } : {}),
      ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method !== 'GET' ? { body: JSON.stringify({ clientId, ...data }) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(typeof payload?.error === 'string' ? payload.error : `Personal agent request failed (${response.status})`), { status: response.status });
  return payload as T;
};

export const getPersonalAgent = (clientId: string) => request<PersonalAgentSnapshot>(clientId, `?clientId=${encodeURIComponent(clientId)}`);

export const updatePersonalAgentProfile = (
  clientId: string,
  profile: Pick<PersonalAgentProfile, 'name' | 'avatar' | 'instructions' | 'memory'>,
  expectedUpdatedAt?: string,
) => request<{ profile: PersonalAgentProfile }>(clientId, '/profile', 'PUT', { ...profile, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });

export const createPersonalAgentThread = (clientId: string, name: string) => request<{ room: Room }>(clientId, '/threads', 'POST', { name });

export const updatePersonalAgentThread = (clientId: string, id: string, updates: { name?: string; archived?: boolean }) =>
  request<{ room: Room }>(clientId, `/threads/${encodeURIComponent(id)}`, 'PATCH', updates);

export const createPersonalAgentGoal = (clientId: string, goal: PersonalAgentGoalInput) => request<{ goal: PersonalAgentGoal }>(clientId, '/goals', 'POST', goal);

export const updatePersonalAgentGoal = (
  clientId: string,
  id: string,
  goal: Partial<PersonalAgentGoalInput> & { enabled?: boolean },
) => request<{ goal: PersonalAgentGoal }>(clientId, `/goals/${encodeURIComponent(id)}`, 'PATCH', goal);

export const deletePersonalAgentGoal = (clientId: string, id: string) => request<{ success: true }>(clientId, `/goals/${encodeURIComponent(id)}`, 'DELETE');

export const runPersonalAgentGoal = (clientId: string, id: string) => request<{ room: Room }>(clientId, `/goals/${encodeURIComponent(id)}/run`, 'POST');

export interface PersonalAgentMemory {
  id: string;
  clientId: string;
  kind: 'preference' | 'fact' | 'topic';
  title: string;
  content: string;
  source: string;
  sourceRoomId?: string;
  sourceTurnId?: string;
  createdAt: string;
  updatedAt: string;
}
export const readPersonalAgentMemories = (clientId: string, query = '', offset = 0) =>
  request<{ memories: PersonalAgentMemory[]; total: number }>(clientId, `/memories?${new URLSearchParams({ ...(query.trim() ? { query: query.trim() } : {}), offset: String(offset), limit: '50' })}`);
export const savePersonalAgentMemory = (clientId: string, entry: Pick<PersonalAgentMemory, 'kind' | 'title' | 'content'>, existing?: PersonalAgentMemory) =>
  request<{ memory: PersonalAgentMemory }>(clientId, existing ? `/memories/${encodeURIComponent(existing.id)}` : '/memories', existing ? 'PATCH' : 'POST', { ...entry, ...(existing ? { expectedUpdatedAt: existing.updatedAt } : {}) });
export const forgetPersonalAgentMemory = (clientId: string, entry: PersonalAgentMemory) =>
  request<{ success: true }>(clientId, `/memories/${encodeURIComponent(entry.id)}`, 'DELETE', { expectedUpdatedAt: entry.updatedAt });
