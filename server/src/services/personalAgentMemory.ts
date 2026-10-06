import { randomUUID } from 'node:crypto';
import { RoomStore } from '../repositories/store';
import { PersonalAgentMemory } from '../types';

export class PersonalAgentMemoryConflict extends Error {}
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
  return store.readPersonalAgentMemories!(clientId, { query: search, kind: kind ? String(kind) : undefined, limit, offset });
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
  if (!memory) throw new PersonalAgentMemoryConflict('This memory changed. Read it again before saving.');
  return memory;
};
export const forgetPersonalMemory = async (store: RoomStore, clientId: string, id: unknown, expectedUpdatedAt: unknown) => {
  const expected = text(expectedUpdatedAt, 'expectedUpdatedAt', 40);
  if (!Number.isFinite(Date.parse(expected))) throw new RangeError('Invalid expectedUpdatedAt');
  if (!await store.deletePersonalAgentMemory!(clientId, text(id, 'id', 100), expected)) {
    throw new PersonalAgentMemoryConflict('This memory changed or was removed. Read it again before forgetting.');
  }
  return { success: true };
};
