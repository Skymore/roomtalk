import { randomUUID } from 'node:crypto';
import { PersonalAgentMemoryConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentMemory } from '../types';

export { PersonalAgentMemoryConflictError as PersonalAgentMemoryConflict } from '../repositories/store';
const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RangeError(`Invalid ${field}`);
  return value.trim();
};
export const readPersonalMemories = (store: RoomStore, clientId: string, query: Record<string, unknown>) => {
  const kind = query.kind;
  if (kind && !['preference', 'fact', 'topic'].includes(String(kind))) throw new RangeError('Invalid memory kind');
  const limit = Number(query.limit ?? 50);
  const offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Invalid memory page');
  const search = query.query === undefined ? undefined : text(query.query, 'query', 500);
  const id = query.id === undefined ? undefined : text(query.id, 'id', 100);
  return store.readPersonalAgentMemories!(clientId, { id, query: search, kind: kind ? String(kind) : undefined, limit, offset });
};
export const savePersonalMemory = async (store: RoomStore, clientId: string, body: Record<string, unknown>, source: {
  label: string; roomId?: string; turnId?: string;
}): Promise<PersonalAgentMemory> => {
  const kind = body.kind;
  if (kind !== 'preference' && kind !== 'fact' && kind !== 'topic') throw new RangeError('Invalid memory kind');
  const id = body.id === undefined ? randomUUID() : text(body.id, 'id', 100);
  const expected = body.id === undefined ? undefined : text(body.expectedUpdatedAt, 'expectedUpdatedAt', 40);
  if (expected && !Number.isFinite(Date.parse(expected))) throw new RangeError('Invalid expectedUpdatedAt');
  const now = new Date().toISOString();
  const memory = await store.savePersonalAgentMemory!({
    id, clientId, kind, title: text(body.title, 'title', 200), content: text(body.content, 'content', 8000),
    source: source.label, sourceRoomId: source.roomId, sourceTurnId: source.turnId, createdAt: now, updatedAt: now,
  }, expected);
  if (!memory) throw new PersonalAgentMemoryConflictError('This memory changed. Read it again before saving.');
  return memory;
};
export const forgetPersonalMemory = async (store: RoomStore, clientId: string, id: unknown, expectedUpdatedAt: unknown) => {
  const expected = text(expectedUpdatedAt, 'expectedUpdatedAt', 40);
  if (!Number.isFinite(Date.parse(expected))) throw new RangeError('Invalid expectedUpdatedAt');
  if (!await store.deletePersonalAgentMemory!(clientId, text(id, 'id', 100), expected)) {
    throw new PersonalAgentMemoryConflictError('This memory changed or was removed. Read it again before forgetting.');
  }
  return { success: true };
};

export const mergePersonalMemories = async (store: RoomStore, clientId: string, body: Record<string, unknown>, source: {
  label: string; roomId?: string; turnId?: string;
}) => {
  if (!Array.isArray(body.entries) || body.entries.length < 2 || body.entries.length > 20) throw new RangeError('Select 2 to 20 memories to merge');
  const entries = body.entries.map(value => {
    if (!value || typeof value !== 'object') throw new RangeError('Invalid memory revision');
    const updatedAt = text(value.updatedAt, 'updatedAt', 40);
    if (!Number.isFinite(Date.parse(updatedAt))) throw new RangeError('Invalid updatedAt');
    return { id: text(value.id, 'id', 100), updatedAt };
  });
  const id = text(body.id, 'id', 100);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || !entries.some(entry => entry.id === id)) throw new RangeError('Provide distinct memories including the retained id');
  if (body.kind !== 'preference' && body.kind !== 'fact' && body.kind !== 'topic') throw new RangeError('Invalid memory kind');
  const now = new Date().toISOString();
  const memory = await store.mergePersonalAgentMemories!({
    id, clientId, kind: body.kind, title: text(body.title, 'title', 200), content: text(body.content, 'content', 8000),
    source: source.label, sourceRoomId: source.roomId, sourceTurnId: source.turnId, createdAt: now, updatedAt: now,
  }, entries);
  if (!memory) throw new PersonalAgentMemoryConflictError('A selected memory changed or was removed. Read all selected memories again before merging.');
  return { memory };
};
