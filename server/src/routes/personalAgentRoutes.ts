import { Express, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal, PersonalAgentProfile, Room } from '../types';
import { nextPersonalAgentGoalRunAt } from '../services/personalAgentSchedule';

export interface PersonalAgentRouteOptions {
  store: RoomStore;
  logger: Logger;
  getClientId: (req: Request) => string | null;
  authorizeClientRequest: (req: Request, res: Response, clientId: string, endpoint: string) => Promise<boolean>;
  startGoal?: (goal: PersonalAgentGoal) => Promise<{ room: Room } | { roomId: string }>;
}

const textField = (value: unknown, name: string, maxLength: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new RangeError(`Invalid ${name}`);
  }
  return allowEmpty ? value : value.trim();
};

const parseGoal = (body: Record<string, unknown>, existing?: PersonalAgentGoal): PersonalAgentGoal => {
  const now = new Date();
  const schedule = body.schedule ?? existing?.schedule ?? 'manual';
  if (schedule !== 'manual' && schedule !== 'daily' && schedule !== 'weekly') throw new RangeError('Invalid schedule');
  const time = body.time ?? existing?.time ?? '09:00';
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError('Invalid time');
  const timezone = textField(body.timezone ?? existing?.timezone ?? 'UTC', 'timezone', 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new RangeError('Invalid timezone'); }
  const enabled = body.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new RangeError('Invalid enabled value');
  const goal: PersonalAgentGoal = {
    ...(existing || {}), id: existing?.id || uuidv4(), clientId: existing?.clientId || '',
    title: textField(body.title ?? existing?.title, 'title', 100),
    prompt: textField(body.prompt ?? existing?.prompt, 'prompt', 16000),
    schedule, time, timezone, enabled,
    createdAt: existing?.createdAt || now.toISOString(), updatedAt: now.toISOString(),
  };
  const scheduleChanged = !existing || existing.schedule !== schedule || existing.time !== time
    || existing.timezone !== timezone || existing.enabled !== enabled;
  if (scheduleChanged) goal.nextRunAt = enabled ? nextPersonalAgentGoalRunAt(goal, now) : undefined;
  return goal;
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
      if (error instanceof PersonalAgentGoalConflictError) return res.status(409).json({ error: error.message });
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

  app.put('/api/personal-agent/profile', withProfile(async (req, res, profile) => {
    const updates: Partial<Pick<PersonalAgentProfile, 'name' | 'avatar' | 'instructions' | 'memory'>> = {};
    for (const [key, limit] of [['name', 100], ['avatar', 64], ['instructions', 8000], ['memory', 16000]] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = textField(req.body[key], key, limit, key === 'instructions' || key === 'memory');
      }
    }
    const updated = await store.updatePersonalAgentProfile!(profile.clientId, updates);
    return res.json({ profile: updated });
  }));

  app.post('/api/personal-agent/threads', withProfile(async (req, res, profile) => {
    const room = await store.createPersonalAgentThread!(profile.clientId, textField(req.body?.name, 'name', 100));
    return res.status(201).json({ room });
  }));

  app.post('/api/personal-agent/goals', withProfile(async (req, res, profile) => {
    const goal = parseGoal(req.body || {});
    goal.clientId = profile.clientId;
    return res.status(201).json({ goal: await store.savePersonalAgentGoal!(goal) });
  }));

  app.patch('/api/personal-agent/goals/:id', withProfile(async (req, res, profile) => {
    const existing = (await store.readPersonalAgentGoals!(profile.clientId)).find(goal => goal.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Goal not found' });
    return res.json({ goal: await store.savePersonalAgentGoal!(parseGoal(req.body || {}, existing), existing.updatedAt) });
  }));

  app.delete('/api/personal-agent/goals/:id', withProfile(async (req, res, profile) => {
    const deleted = await store.deletePersonalAgentGoal!(profile.clientId, req.params.id);
    return deleted ? res.json({ success: true }) : res.status(404).json({ error: 'Goal not found' });
  }));

  app.post('/api/personal-agent/goals/:id/run', withProfile(async (req, res, profile) => {
    const goal = (await store.readPersonalAgentGoals!(profile.clientId)).find(item => item.id === req.params.id);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (!options.startGoal) return res.status(503).json({ error: 'Personal agent execution is unavailable' });
    return res.status(202).json(await options.startGoal(goal));
  }));
}
