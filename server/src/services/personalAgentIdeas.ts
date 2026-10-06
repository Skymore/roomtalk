import { randomUUID } from 'node:crypto';
import { PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentIdea, PersonalAgentIdeaSourceKind } from '../types';

export class PersonalAgentIdeaError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RangeError(`Invalid ${name}`);
  return value.trim();
};
export const personalIdeaPrompt = (value: unknown) => text(value, 'task instructions', 16000);
export const personalIdeaRevision = (value: unknown) => {
  const revision = text(value, 'expectedUpdatedAt', 100);
  if (!Number.isFinite(Date.parse(revision))) throw new RangeError('Invalid expectedUpdatedAt');
  return revision;
};

export class PersonalAgentIdeaService {
  constructor(private readonly store: RoomStore) {}

  async list(clientId: string, query: Record<string, unknown> = {}) {
    const limit = Number(query.limit ?? 50), offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Invalid suggestion page');
    const status = query.status ?? 'new';
    if (!['new', 'accepted', 'dismissed', 'all'].includes(String(status))) throw new RangeError('Invalid suggestion status');
    return this.store.readPersonalAgentIdeas!(clientId, { limit, offset,
      ...(status !== 'all' ? { status: status as PersonalAgentIdea['status'] } : {}),
      ...(query.id ? { id: text(query.id, 'suggestion id', 100) } : {}),
    });
  }

  async propose(clientId: string, body: Record<string, unknown>, claim?: { roomId: string; turnId: string }, automatic = false) {
    const kind = body.sourceKind;
    if (!['goal', 'memory', 'result', 'browser'].includes(String(kind))) throw new RangeError('Select a goal, memory, result or browser source');
    const source = await this.store.readPersonalAgentIdeaSource!(clientId, kind as PersonalAgentIdeaSourceKind, text(body.sourceId, 'source id', 100));
    if (!source) throw new PersonalAgentIdeaError('Source not found or already handled', 404);
    const now = new Date().toISOString();
    const saved = await this.store.savePersonalAgentIdea!({ id: randomUUID(), clientId, source, automatic,
      title: text(body.title, 'title', 100), reason: text(body.reason, 'reason', 2000),
      prompt: personalIdeaPrompt(body.prompt), status: 'new', createdAt: now, updatedAt: now,
    }, claim);
    if (!saved) throw new PersonalAgentIdeaConflictError('The source changed or this turn ended. Read the source again.');
    return { idea: saved };
  }

  async refresh(clientId: string) {
    // Only real goals without steps create automatic suggestions. Other ideas
    // come from the agent with a stored source, never from sample data.
    const goals = await this.store.readPersonalAgentGoals!(clientId);
    for (const goal of goals.filter(item => item.enabled && !item.completedAt && !item.lastRunRoomId && !item.milestones?.length)) {
      try { await this.propose(clientId, { sourceKind: 'goal', sourceId: goal.id, title: goal.title,
        reason: 'This goal has no milestones yet. A practical plan will give it a next step.',
        prompt: `Read the saved goal "${goal.title}" and create an actionable plan. Record clear steps as milestones for this goal.`,
      }, undefined, true); }
      catch (error) { if (!(error instanceof PersonalAgentIdeaConflictError) && !(error instanceof PersonalAgentIdeaError && error.statusCode === 404)) throw error; }
    }
    // Retire obsolete proposals; accepted and dismissed decisions remain intact.
    let offset = 0;
    while (true) {
      const found = await this.store.readPersonalAgentIdeas!(clientId, { status: 'new', limit: 100, offset });
      let retired = 0;
      for (const idea of found.ideas) {
        const current = await this.store.readPersonalAgentIdeaSource!(clientId, idea.source.kind, idea.source.id);
        if (!current || current.recordedAt !== idea.source.recordedAt || (idea.automatic && goals.find(goal => goal.id === idea.source.id)?.milestones?.length)) {
          if ((await this.store.dismissPersonalAgentIdea!(clientId, idea.id, idea.updatedAt))?.status === 'dismissed') retired++;
        }
      }
      offset += found.ideas.length - retired;
      if (offset >= found.total - retired || !found.ideas.length) break;
    }
    return this.list(clientId);
  }

  async dismiss(clientId: string, id: string, revision: unknown) {
    const idea = await this.store.dismissPersonalAgentIdea!(clientId, text(id, 'suggestion id', 100), personalIdeaRevision(revision));
    if (!idea) throw new PersonalAgentIdeaConflictError('The suggestion changed. Read it again.');
    return { idea };
  }
}
