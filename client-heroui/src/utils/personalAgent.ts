import { apiPath } from './apiBase';
import type { Room } from './types';

export interface PersonalAgentProfile {
  clientId: string;
  name: string;
  avatar: string;
  tone?: 'warm' | 'concise' | 'thoughtful';
  instructions: string;
  memory: string;
  mainRoomId: string;
  showUpdates?: boolean;
  pushEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PersonalAgentSchedule = 'manual' | 'once' | 'daily' | 'weekly';

export interface PersonalAgentGoal {
  id: string;
  clientId: string;
  title: string;
  prompt: string;
  category?: string;
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
  source: { kind: 'goal' | 'memory' | 'result' | 'browser' | 'mail'; id: string; title: string; excerpt: string; recordedAt: string; roomId?: string; turnId?: string; url?: string };
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

export type PersonalAgentGoalInput = Pick<PersonalAgentGoal, 'title' | 'prompt' | 'schedule' | 'time' | 'timezone' | 'weekday' | 'runAt' | 'milestones' | 'category'>;

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
  profile: Pick<PersonalAgentProfile, 'name' | 'avatar' | 'instructions' | 'memory' | 'showUpdates' | 'pushEnabled' | 'tone'>,
  expectedUpdatedAt?: string,
) => request<{ profile: PersonalAgentProfile }>(clientId, '/profile', 'PUT', { ...profile, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });

export const createPersonalAgentThread = (clientId: string, name: string, memoryId?: string) => request<{ room: Room }>(clientId, '/threads', 'POST', { name, ...(memoryId ? { memoryId } : {}) });

export const generatePersonalAgentChatTitle = (clientId: string, id: string) =>
  request<{ room: Room }>(clientId, `/threads/${encodeURIComponent(id)}/title`, 'POST', {});

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
  kind: 'plan' | 'document' | 'web' | 'comparison' | 'finance';
  data?: Record<string, unknown>;
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
  id: string; roomId: string; turnId: string; sessionId?:string;browserRoomId?:string;url: string; title: string; createdAt: string;
}
export interface PersonalBrowserControl { id: string; fence: number }
export interface PersonalBrowserFrame {
  downloads?: {id:string; name:string; byteSize:number; url:string}[];
  file?: PersonalAgentFile;
  session: {id:string;roomId:string;url:string;title:string;updatedAt:string;status?:'active'|'closed'|'error';previewUrl?:string};
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
export const readPersonalBrowserPreview=async(clientId:string,url:string):Promise<Blob>=>{
  const token=localStorage.getItem('clientAuthToken')?.trim();
  const response=await fetch(apiPath(url),{cache:'no-store',headers:{'X-Client-Id':clientId,...(token?{'X-Client-Auth-Token':token}:{})}});
  if(!response.ok)throw new Error('Preview unavailable. Open the browser to reconnect.');
  return response.blob();
};
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

export const readPersonalAgentIdeas = (clientId: string, offset = 0) => request<{ ideas: PersonalAgentIdea[]; total: number }>(clientId, `/ideas?status=all&limit=50&offset=${offset}`);

export interface PersonalAgentWatch {
  id: string; roomId: string; title: string; url: string;
  condition: 'change' | 'contains' | 'price_below'; value: string; intervalMinutes: number;
  status: 'active' | 'paused' | 'stopped'; checks: number; failures: number;
  nextCheckAt?: string; lastCheckedAt?: string; lastUrl?: string; lastTitle?: string; lastExcerpt?: string;
  error?: string; createdAt: string; updatedAt: string;
}
export interface PersonalAgentNotification {
  id: string; kind: 'task_complete' | 'task_error' | 'task_input' | 'task_review' | 'watch_match' | 'watch_error'; title: string; body: string;
  roomId?: string; watchId?: string; source?: {url: string; title: string; excerpt: string; checkedAt: string};
  readAt?: string; createdAt: string;
}
export const readPersonalAgentWatches = (clientId: string, offset = 0) => request<{watches: PersonalAgentWatch[]; total: number}>(clientId, `/watches?limit=50&offset=${offset}`);
export const createPersonalAgentWatch = (clientId: string, body: Pick<PersonalAgentWatch,'title'|'url'|'condition'|'value'|'intervalMinutes'>) => request<{watch: PersonalAgentWatch}>(clientId, '/watches', 'POST', body);
export const controlPersonalAgentWatch = (clientId: string, watch: PersonalAgentWatch, action: 'pause'|'resume'|'check'|'stop') => request<{watch: PersonalAgentWatch}>(clientId, `/watches/${encodeURIComponent(watch.id)}`, 'PATCH', {action});
export const removePersonalAgentWatch = (clientId: string, id: string) => request<{removed: boolean}>(clientId, `/watches/${encodeURIComponent(id)}`, 'DELETE');
export const readPersonalAgentNotifications = (clientId: string, unread = false, offset = 0) => request<{notifications: PersonalAgentNotification[]; total: number; unread: number}>(clientId, `/notifications?unread=${unread}&limit=50&offset=${offset}`);
export const markPersonalAgentNotificationRead = (clientId: string, id: string) => request<{notification: PersonalAgentNotification}>(clientId, `/notifications/${encodeURIComponent(id)}/read`, 'POST');

export interface PersonalAgentFile {
  id: string; name: string; byteSize: number; pageCount: number;
  fields: { name: string; value: string; type: 'text' | 'checkbox' | 'unsupported' }[];
  source: string; parentId?: string; createdAt: string;
}
export const readPersonalAgentFiles = (clientId: string, offset = 0,id?:string) =>
  request<{ files: PersonalAgentFile[]; total: number }>(clientId, `/files?limit=50&offset=${offset}${id?`&id=${encodeURIComponent(id)}`:''}`);
export const fillPersonalAgentFile = (clientId: string,id: string,fields: Record<string,string | boolean>) =>
  request<{ file: PersonalAgentFile }>(clientId, `/files/${encodeURIComponent(id)}/fill`,'POST',{ fields });
export const importPersonalAgentFile = async (clientId: string,file: File): Promise<{ file: PersonalAgentFile }> => {
  const response = await fetch(apiPath(`/api/personal-agent/files?name=${encodeURIComponent(file.name)}`), {
    method: 'POST',headers: { 'Content-Type': 'application/pdf','X-Client-Id': clientId,'X-Client-Auth-Token': localStorage.getItem('clientAuthToken') || '' },body: file,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Unable to import PDF');
  return payload;
};
export const readPersonalAgentFile = async (clientId: string,id: string): Promise<Blob> => {
  const response = await fetch(apiPath(`/api/personal-agent/files/${encodeURIComponent(id)}/content`), {
    cache: 'no-store',headers: { 'X-Client-Id': clientId,'X-Client-Auth-Token': localStorage.getItem('clientAuthToken') || '' },
  });
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.error || 'Unable to read PDF'); }
  return response.blob();
};

export interface PersonalAgentInputRequest {
  id:string; roomId:string; turnId:string; question:string; fields:{name:string;type:'text'|'checkbox'}[];
  fileId?:string; answer?:{text:string;fields:Record<string,string|boolean>}; createdAt:string; answeredAt?:string;
}
export interface PersonalAgentTaskDetail {
  task?:{prompt:string;kind:'plan'|'document'|'finance'|'agent'|'monitor'};
  watch?:PersonalAgentWatch;
  files?:PersonalAgentFile[];browsers?:PersonalBrowserFrame['session'][];
  room:Room; turns:import('./types').RoomAgentTurn[]; messages:import('./types').Message[]; hasMore:boolean; requests:PersonalAgentInputRequest[];actions:PersonalGoogleAction[];
}
export const delegatePersonalAgentTask=(clientId:string,input:{kind:'plan'|'document'|'finance'|'agent';prompt:string;title?:string;goalId?:string;input:{csv?:string;messageId?:string}})=>request<{room:Room}>(clientId,'/tasks','POST',input);
export const readPersonalAgentTask = (clientId:string,roomId:string,beforeMessageId?:string) => request<PersonalAgentTaskDetail>(clientId,`/tasks/${encodeURIComponent(roomId)}${beforeMessageId?`?beforeMessageId=${encodeURIComponent(beforeMessageId)}`:''}`);
export const controlPersonalAgentTask=(clientId:string,roomId:string,action:'pause'|'resume'|'cancel'|'retry')=>request<{room:Room}>(clientId,`/tasks/${encodeURIComponent(roomId)}/control`,'POST',{action});
export const answerPersonalAgentTaskInput = (clientId:string,roomId:string,id:string,answer:NonNullable<PersonalAgentInputRequest['answer']>) => request<{request:PersonalAgentInputRequest}>(clientId,`/tasks/${encodeURIComponent(roomId)}/inputs/${encodeURIComponent(id)}`,'POST',answer);

export interface PersonalMail {
  id: string; threadId: string; from: string; sender: string; to: string[]; subject: string;
  body: string; date: string; unread: boolean; label: string; attachments: string[];
}
export interface PersonalCalendarEvent {
  id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean;
  timeZone: string; location: string; description: string; attendees: string[];
}
export interface PersonalEmailDraft {
  id?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string;
  attachmentIds: string[]; threadId?: string; replyToMessageId?: string; updatedAt?: string;
}
export interface PersonalGoogleAction {
  id: string; title: string; kind: 'email.send' | 'calendar.create' | 'calendar.update' | 'calendar.delete';
  data: Record<string,unknown>; account: string; status: string; createdAt:string;updatedAt: string;
  sourceRoomId?:string;sourceTurnId?:string;
  target?: PersonalCalendarEvent; result?: string; error?: string; expiresAt: string;
}
export interface PersonalGoogleStatus {
  configured: boolean; connected: boolean; account?: string; canSend: boolean; canEditCalendar: boolean;
}
export interface PersonalCalendarChoice { id: string; name: string; timeZone: string; accessRole: string; }
export const personalGoogleRequest = <T>(clientId: string,path: string,method = 'GET',data?: Record<string,unknown>) => request<T>(clientId,path,method,data);

export { request as requestPersonalAgent };
