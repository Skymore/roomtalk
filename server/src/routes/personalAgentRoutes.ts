import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal, PersonalAgentProfile, Room } from '../types';
import { PersonalAgentMemoryConflict, readPersonalMemories, savePersonalMemory, forgetPersonalMemory } from '../services/personalAgentMemory';
import { savePersonalAgentGoal } from '../services/personalAgentGoals';

export interface PersonalAgentRouteOptions {
  store: RoomStore;
  logger: Logger;
  getClientId: (req: Request) => string | null;
  authorizeClientRequest: (req: Request, res: Response, clientId: string, endpoint: string) => Promise<boolean>;
  cancelGoal?: (goal: PersonalAgentGoal, expectedUpdatedAt?: string) => Promise<PersonalAgentGoal>;
  startGoal?: (goal: PersonalAgentGoal) => Promise<{ room: Room } | { roomId: string }>;
}

const textField = (value: unknown, name: string, maxLength: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new RangeError(`Invalid ${name}`);
  }
  return allowEmpty ? value : value.trim();
};


export function registerPersonalAgentRoutes(app: Express, options: PersonalAgentRouteOptions) {
  const { store } = options;
  const withProfile = (handler: (req: Request, res: Response, profile: PersonalAgentProfile) => Promise<unknown>) => async (req: Request, res: Response) => {
    const clientId = options.getClientId(req);
    if (!clientId || !req.header('x-client-auth-token')) return res.status(401).json({ error: 'Sign in to use your personal agent' });
    if (!await options.authorizeClientRequest(req, res, clientId, `${req.method} ${req.path}`)) return;
    try {
      const account = await store.getAccountByClientId(clientId);
      if (!account || account.primaryClientId !== clientId) return res.status(401).json({ error: 'Sign in to use your personal agent' });
      if (!store.ensurePersonalAgentProfile) return res.status(503).json({ error: 'Personal agents are unavailable' });
      return await handler(req, res, await store.ensurePersonalAgentProfile(clientId));
    } catch (error) {
      if (error instanceof PersonalAgentGoalConflictError || error instanceof PersonalAgentMemoryConflict) return res.status(409).json({ error: error.message });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      options.logger.error('Personal agent request failed', { error, clientId, endpoint: req.path });
      return res.status(500).json({ error: 'Unable to update your personal agent' });
    }
  };

  app.get('/api/personal-agent', withProfile(async (_req, res, profile) => {
    const [rooms, goals] = await Promise.all([
      store.readPersonalAgentRooms!(profile.clientId), store.readPersonalAgentGoals!(profile.clientId),
    ]);
    return res.json({ profile, rooms, goals });
  }));

  app.get('/api/personal-agent/memories', withProfile(async (req, res, profile) =>
    res.json(await readPersonalMemories(store, profile.clientId, req.query))));
  app.post('/api/personal-agent/memories', withProfile(async (req, res, profile) =>
    res.status(201).json({ memory: await savePersonalMemory(store, profile.clientId, { ...req.body, id: undefined }, { label: 'Added by you' }) })));
  app.patch('/api/personal-agent/memories/:id', withProfile(async (req, res, profile) =>
    res.json({ memory: await savePersonalMemory(store, profile.clientId, { ...req.body, id: req.params.id }, { label: 'Edited by you' }) })));
  app.delete('/api/personal-agent/memories/:id', withProfile(async (req, res, profile) =>
    res.json(await forgetPersonalMemory(store, profile.clientId, req.params.id, req.body?.expectedUpdatedAt))));

  app.put('/api/personal-agent/profile', withProfile(async (req, res, profile) => {
    const updates: Partial<Pick<PersonalAgentProfile, 'name' | 'avatar' | 'instructions' | 'memory'>> = {};
    for (const [key, limit] of [['name', 100], ['avatar', 64], ['instructions', 8000], ['memory', 16000]] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = textField(req.body[key], key, limit, key === 'instructions' || key === 'memory');
      }
    }
    const expectedUpdatedAt = req.body?.expectedUpdatedAt;
    if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)))) throw new RangeError('Invalid expectedUpdatedAt');
    const updated = await store.updatePersonalAgentProfile!(profile.clientId, updates, expectedUpdatedAt);
    if (!updated) throw new PersonalAgentMemoryConflict('Your preferences changed. Refresh before saving.');
    return res.json({ profile: updated });
  }));

  app.post('/api/personal-agent/threads', withProfile(async (req, res, profile) => {
    const room = await store.createPersonalAgentThread!(profile.clientId, textField(req.body?.name, 'name', 100));
    return res.status(201).json({ room });
  }));

  app.patch('/api/personal-agent/threads/:id', withProfile(async (req, res, profile) => {
    if (req.params.id === profile.mainRoomId) return res.status(400).json({ error: 'Your main conversation is always available' });
    const updates: { name?: string; archived?: boolean } = {};
    if (req.body?.name !== undefined) updates.name = textField(req.body.name, 'name', 100);
    if (req.body?.archived !== undefined) {
      if (typeof req.body.archived !== 'boolean') throw new RangeError('Invalid archived value');
      updates.archived = req.body.archived;
    }
    if (!Object.keys(updates).length) throw new RangeError('Provide a conversation name or archived value');
    const room = await store.updatePersonalAgentThread!(profile.clientId, req.params.id, updates);
    return room ? res.json({ room }) : res.status(404).json({ error: 'Conversation not found' });
  }));

  app.post('/api/personal-agent/goals', withProfile(async (req, res, profile) => {
    return res.status(201).json({ goal: await savePersonalAgentGoal(store, profile.clientId, req.body || {}) });
  }));

  app.patch('/api/personal-agent/goals/:id', withProfile(async (req, res, profile) => {
    const existing = (await store.readPersonalAgentGoals!(profile.clientId)).find(goal => goal.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Goal not found' });
    return res.json({ goal: await savePersonalAgentGoal(store, profile.clientId, req.body || {}, existing) });
  }));

  app.post('/api/personal-agent/goals/:id/cancel', withProfile(async (req, res, profile) => {
    const goal = (await store.readPersonalAgentGoals!(profile.clientId)).find(item => item.id === req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (!options.cancelGoal) return res.status(503).json({ error: 'Personal agent cancellation is unavailable' });
    return res.json({ goal: await options.cancelGoal(goal, req.body?.expectedUpdatedAt), cancellationRequested: true });
  }));

  app.delete('/api/personal-agent/goals/:id', withProfile(async (req, res, profile) => {
    const goal = (await store.readPersonalAgentGoals!(profile.clientId)).find(item => item.id === req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (req.body?.expectedUpdatedAt !== undefined && req.body.expectedUpdatedAt !== goal.updatedAt) {
      throw new PersonalAgentGoalConflictError('Goal changed. Refresh before deleting.');
    }
    const paused = options.cancelGoal ? await options.cancelGoal(goal, goal.updatedAt) : goal;
    if (!await store.deletePersonalAgentGoal!(profile.clientId, goal.id, paused.updatedAt)) throw new PersonalAgentGoalConflictError('Goal changed before deletion. Refresh and try again.');
    return res.json({ success: true });
  }));

  app.post('/api/personal-agent/goals/:id/run', withProfile(async (req, res, profile) => {
    const goal = (await store.readPersonalAgentGoals!(profile.clientId)).find(item => item.id === req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (!options.startGoal) return res.status(503).json({ error: 'Personal agent execution is unavailable' });
    return res.status(202).json(await options.startGoal(goal));
  }));
}
