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

export type PersonalAgentSchedule = 'manual' | 'once' | 'daily' | 'weekly';

export interface PersonalAgentGoal {
  id: string;
  clientId: string;
  title: string;
  prompt: string;
  schedule: PersonalAgentSchedule;
  time: string;
  timezone: string;
  weekday?: number;
  runAt?: string;
  enabled: boolean;
  milestones?: { id: string; title: string; done: boolean }[];
  completedAt?: string;
  lastRun?: { status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled' | 'not_running';
    completedAt?: string; finalMessageId?: string; phaseMessage?: string };
  lastRunAt?: string;
  lastRunRoomId?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentIdea {
  id: string;
  title: string;
  reason: string;
  prompt: string;
  automatic: boolean;
  source: { kind: 'goal' | 'memory' | 'result' | 'browser'; id: string; title: string; excerpt: string; recordedAt: string; roomId?: string; turnId?: string; url?: string };
  status: 'new' | 'accepted' | 'dismissed';
  acceptedRoomId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentSnapshot {
  profile: PersonalAgentProfile;
  rooms: Room[];
  goals: PersonalAgentGoal[];
  ideas: PersonalAgentIdea[];
}

export type PersonalAgentGoalInput = Pick<PersonalAgentGoal, 'title' | 'prompt' | 'schedule' | 'time' | 'timezone' | 'weekday' | 'runAt' | 'milestones'>;

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

export const createPersonalAgentThread = (clientId: string, name: string, memoryId?: string) => request<{ room: Room }>(clientId, '/threads', 'POST', { name, ...(memoryId ? { memoryId } : {}) });

export const updatePersonalAgentThread = (clientId: string, id: string, updates: { name?: string; archived?: boolean }) =>
  request<{ room: Room }>(clientId, `/threads/${encodeURIComponent(id)}`, 'PATCH', updates);

export const createPersonalAgentGoal = (clientId: string, goal: PersonalAgentGoalInput) => request<{ goal: PersonalAgentGoal }>(clientId, '/goals', 'POST', goal);

export const updatePersonalAgentGoal = (
  clientId: string,
  id: string,
  goal: Partial<PersonalAgentGoalInput> & { enabled?: boolean; completed?: boolean },
  expectedUpdatedAt?: string,
) => request<{ goal: PersonalAgentGoal }>(clientId, `/goals/${encodeURIComponent(id)}`, 'PATCH', { ...goal, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });

export const deletePersonalAgentGoal = (clientId: string, id: string, expectedUpdatedAt?: string) => request<{ success: true }>(clientId, `/goals/${encodeURIComponent(id)}`, 'DELETE', { expectedUpdatedAt });

export const cancelPersonalAgentGoal = (clientId: string, id: string, expectedUpdatedAt: string) => request<{ goal: PersonalAgentGoal; cancellationRequested: true }>(clientId, `/goals/${encodeURIComponent(id)}/cancel`, 'POST', { expectedUpdatedAt });

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
  provenance?: { label: string; roomId?: string; turnId?: string; recordedAt: string }[];
  createdAt: string;
  updatedAt: string;
}
export const readPersonalAgentMemories = (clientId: string, query = '', offset = 0) =>
  request<{ memories: PersonalAgentMemory[]; total: number }>(clientId, `/memories?${new URLSearchParams({ ...(query.trim() ? { query: query.trim() } : {}), offset: String(offset), limit: '50' })}`);
export const savePersonalAgentMemory = (clientId: string, entry: Pick<PersonalAgentMemory, 'kind' | 'title' | 'content'>, existing?: PersonalAgentMemory) =>
  request<{ memory: PersonalAgentMemory }>(clientId, existing ? `/memories/${encodeURIComponent(existing.id)}` : '/memories', existing ? 'PATCH' : 'POST', { ...entry, ...(existing ? { expectedUpdatedAt: existing.updatedAt } : {}) });
export const forgetPersonalAgentMemory = (clientId: string, entry: PersonalAgentMemory) =>
  request<{ success: true }>(clientId, `/memories/${encodeURIComponent(entry.id)}`, 'DELETE', { expectedUpdatedAt: entry.updatedAt });
export const mergePersonalAgentMemories = (clientId: string, entry: Pick<PersonalAgentMemory, 'kind' | 'title' | 'content'>, selected: PersonalAgentMemory[]) =>
  request<{ memory: PersonalAgentMemory }>(clientId, '/memories/merge', 'POST', { ...entry, id: selected[0].id, entries: selected.map(({ id, updatedAt }) => ({ id, updatedAt })) });


export interface PersonalAgentResult {
  id: string;
  roomId: string;
  turnId: string;
  kind: 'plan' | 'document' | 'web';
  title: string;
  summary: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}
export const readPersonalAgentResults = (clientId: string, roomId: string, turnId: string, offset = 0) =>
  request<{ results: PersonalAgentResult[]; total: number }>(clientId, `/results?${new URLSearchParams({ roomId, turnId, offset: String(offset), limit: '50' })}`);
export const readPersonalAgentResultFile = async (clientId: string, id: string): Promise<Blob> => {
  const token = localStorage.getItem('clientAuthToken')?.trim();
  const response = await fetch(apiPath(`/api/personal-agent/results/${encodeURIComponent(id)}/content?clientId=${encodeURIComponent(clientId)}`), {
    cache: 'no-store', headers: { 'X-Client-Id': clientId, ...(token ? { 'X-Client-Auth-Token': token } : {}) },
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Unable to open result (${response.status})`);
  }
  return response.blob();
};

export interface PersonalBrowserObservation {
  id: string; roomId: string; turnId: string; url: string; title: string; createdAt: string;
}
export interface PersonalBrowserControl { id: string; fence: number }
export interface PersonalBrowserFrame {
  session: { id: string; roomId: string; url: string; title: string; updatedAt: string };
  screenshot?: string; viewport?: { width: number; height: number }; closed: boolean;
}
export const readPersonalBrowserObservations = (clientId: string, roomId: string, turnId: string, offset = 0) =>
  request<{ observations: PersonalBrowserObservation[]; total: number }>(clientId, `/browser-observations?roomId=${encodeURIComponent(roomId)}&turnId=${encodeURIComponent(turnId)}&limit=10&offset=${offset}`);
export const takePersonalBrowserControl = (clientId: string, roomId: string) =>
  request<{ control: PersonalBrowserControl }>(clientId, `/browser/${encodeURIComponent(roomId)}/take-control`, 'POST');
export const releasePersonalBrowserControl = (clientId: string, roomId: string, control: PersonalBrowserControl) =>
  request<{ released: boolean }>(clientId, `/browser/${encodeURIComponent(roomId)}/release-control`, 'POST', { control });
export const actInPersonalBrowser = (clientId: string, roomId: string, control: PersonalBrowserControl, action: Record<string, unknown>) =>
  request<PersonalBrowserFrame>(clientId, `/browser/${encodeURIComponent(roomId)}/control`, 'PATCH', { control, ...action });
export const readPersonalBrowserImage = async (clientId: string, id: string): Promise<Blob> => {
  const token = localStorage.getItem('clientAuthToken')?.trim();
  const response = await fetch(apiPath(`/api/personal-agent/browser-observations/${encodeURIComponent(id)}/image`), {
    cache: 'no-store', headers: { 'X-Client-Id': clientId, ...(token ? { 'X-Client-Auth-Token': token } : {}) },
  });
  if (!response.ok) { const payload = await response.json(); throw new Error(payload?.error || 'Browser image unavailable'); }
  return response.blob();
};

export const refreshPersonalAgentIdeas = (clientId: string) => request<{ ideas: PersonalAgentIdea[]; total: number }>(clientId, '/ideas/refresh', 'POST');
export const acceptPersonalAgentIdea = (clientId: string, idea: PersonalAgentIdea, prompt: string) =>
  request<{ idea: PersonalAgentIdea; room: Room }>(clientId, `/ideas/${encodeURIComponent(idea.id)}`, 'PATCH', { action: 'accept', prompt, expectedUpdatedAt: idea.updatedAt });
export const dismissPersonalAgentIdea = (clientId: string, idea: PersonalAgentIdea) =>
  request<{ idea: PersonalAgentIdea }>(clientId, `/ideas/${encodeURIComponent(idea.id)}`, 'PATCH', { action: 'dismiss', expectedUpdatedAt: idea.updatedAt });

export const readPersonalAgentIdeas = (clientId: string, offset = 0) => request<{ ideas: PersonalAgentIdea[]; total: number }>(clientId, `/ideas?status=new&limit=50&offset=${offset}`);
