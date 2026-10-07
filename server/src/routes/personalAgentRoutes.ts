import {OpenBotAdapter} from '../services/personalAgentOpenBot';
import { PersonalAgentComputerService,PersonalComputerError } from '../services/personalAgentComputer';
import { z } from 'openmuse-zod';
import { PersonalAgentGoogleService } from '../services/personalAgentGoogle';
import { PersonalGoogleError } from '../services/personalAgentGoogleAuth';
import { GoogleApiError, RecurringEventError } from '../services/personalAgentGoogleClient';
import { PersonalAgentTaskService,PersonalAgentTaskError } from '../services/personalAgentTasks';
import { PersonalAgentFileService, PersonalAgentFileError } from '../services/personalAgentFiles';
import { PdfError } from '../services/personalAgentPdf';
import { PersonalAgentTrackingError, PersonalAgentTrackingService } from '../services/personalAgentTracking';
import { PersonalAgentNotificationService } from '../services/personalAgentNotifications';
import { PersonalAgentChatTitleService } from '../services/personalAgentChatTitles';
import { PersonalAgentIdeaService, PersonalAgentIdeaError, personalIdeaPrompt, personalIdeaRevision } from '../services/personalAgentIdeas';
import { PersonalAgentBrowserError, PersonalAgentBrowserService } from '../services/personalAgentBrowser';
import { PersonalAgentResultService } from '../services/personalAgentResults';
import express, { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { PersonalAgentGoalConflictError, PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentGoal, PersonalAgentProfile, Room } from '../types';
import { PersonalAgentMemoryConflict, readPersonalMemories, savePersonalMemory, forgetPersonalMemory, mergePersonalMemories } from '../services/personalAgentMemory';
import { savePersonalAgentGoal } from '../services/personalAgentGoals';

export interface PersonalAgentRouteOptions {
  store: RoomStore;
  results?: PersonalAgentResultService;
  files?: PersonalAgentFileService;
  google?: PersonalAgentGoogleService;
  computer?: PersonalAgentComputerService;
  tasks?: PersonalAgentTaskService;
  browser?: PersonalAgentBrowserService;
  chatTitles?: PersonalAgentChatTitleService;
  ideas?: PersonalAgentIdeaService;
  tracking?: PersonalAgentTrackingService;
  notifications?: PersonalAgentNotificationService;
  acceptIdea?: (clientId: string, id: string, prompt: string, expectedUpdatedAt: string) => Promise<{ idea: import('../types').PersonalAgentIdea; room: Room }>;
  logger: Logger;
  getClientId: (req: Request) => string | null;
  authorizeClientRequest: (req: Request, res: Response, clientId: string, endpoint: string) => Promise<boolean>;
  reviewDecided?:()=>Promise<void>;
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
      if (error instanceof PersonalComputerError)return res.status(error.status).json({error:error.message});
      if (error instanceof z.ZodError) return res.status(422).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if (error instanceof PersonalGoogleError || error instanceof GoogleApiError || error instanceof RecurringEventError) return res.status(error.status).json({error:error.message});
      if (error instanceof PersonalAgentTaskError) return res.status(error.statusCode).json({error:error.message});
      if (error instanceof PdfError) return res.status(error.status).json({ error: error.message });
      if (error instanceof PersonalAgentFileError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof PersonalAgentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof PersonalAgentIdeaError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof PersonalAgentIdeaConflictError) return res.status(409).json({ error: error.message });
      if (error instanceof PersonalAgentGoalConflictError) return res.status(409).json({ error: error.message });
      if (error instanceof PersonalAgentMemoryConflict) return res.status(409).json({ error: error.message, code: error.existingMemory ? 'personal_memory_duplicate' : 'personal_memory_conflict', ...(error.existingMemory ? { existingMemory: error.existingMemory } : {}) });
      if (error instanceof PersonalAgentBrowserError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      options.logger.error('Personal agent request failed', { error, clientId, endpoint: req.path });
      return res.status(500).json({ error: 'Unable to update your personal agent' });
    }
  };

  app.get('/api/personal-agent', withProfile(async (_req, res, profile) => {
    const [rooms, goals, ideas] = await Promise.all([
      store.readPersonalAgentRooms!(profile.clientId), store.readPersonalAgentGoals!(profile.clientId),
      options.ideas?.refresh(profile.clientId).then(()=>options.ideas!.list(profile.clientId,{status:'all'})),
    ]);
    return res.json({ profile, rooms, goals, ideas: ideas?.ideas || [] });
  }));

  app.get('/api/personal-agent/google/callback', async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if (req.query.error) return res.status(400).type('html').send('<h1>Google connection cancelled</h1><p>Return to RoomTalk.</p>');
    try {
      if (!options.google) throw new PersonalGoogleError('Google is unavailable',503);
      if (typeof req.query.state !== 'string' || typeof req.query.code !== 'string') throw new PersonalGoogleError('Google callback is incomplete',400);
      await options.google.auth.callback(req.query.state,req.query.code);
      return res.type('html').send('<h1>Google is connected</h1><p>Return to RoomTalk and refresh your personal assistant.</p>');
    } catch (error) {
      return res.status(error instanceof PersonalGoogleError ? error.status : 502).type('text').send(error instanceof PersonalGoogleError ? error.message : 'Google could not complete sign-in. Connect again.');
    }
  });
  const google = () => {if (!options.google) throw new PersonalGoogleError('Google is unavailable',503); return options.google;};
  app.get('/api/personal-agent/openbot',withProfile(async(_req,res)=>res.json(await new OpenBotAdapter().probe())));
  app.get('/api/personal-agent/google',withProfile(async (_req,res,profile)=>res.json(await google().auth.status(profile.clientId))));
  app.post('/api/personal-agent/google/connect',withProfile(async (req,res,profile)=>res.json(await google().auth.connect(profile.clientId,req.body?.capability === 'write'))));
  app.post('/api/personal-agent/google/disconnect',withProfile(async (_req,res,profile)=>{await google().auth.disconnect(profile.clientId);return res.json({disconnected:true});}));
  app.get('/api/personal-agent/mail',withProfile(async (req,res,profile)=>res.json(await google().mail(profile.clientId,typeof req.query.q === 'string' ? req.query.q : undefined))));
  app.get('/api/personal-agent/mail/threads/:id',withProfile(async (req,res,profile)=>res.json(await google().thread(profile.clientId,req.params.id))));
  app.post('/api/personal-agent/mail/attachments',withProfile(async (req,res,profile)=>res.status(201).json(await google().importAttachment(profile.clientId,textField(req.body?.reference,'attachment reference',4000)))));
  app.get('/api/personal-agent/calendars',withProfile(async (_req,res,profile)=>res.json(await google().calendars(profile.clientId))));
  app.get('/api/personal-agent/calendar/events',withProfile(async (req,res,profile)=>res.json(await google().events(profile.clientId,req.query))));
  app.get('/api/personal-agent/drafts',withProfile(async (_req,res,profile)=>res.json(await google().drafts(profile.clientId))));
  app.post('/api/personal-agent/drafts',withProfile(async (req,res,profile)=>res.status(201).json(await google().saveDraft(profile.clientId,req.body))));
  app.get('/api/personal-agent/activity',withProfile(async(_req,res,profile)=>res.json(await google().activity(profile.clientId))));
  app.get('/api/personal-agent/actions',withProfile(async (_req,res,profile)=>res.json(await google().actions(profile.clientId))));
  app.post('/api/personal-agent/actions',withProfile(async (req,res,profile)=>res.status(201).json(await google().propose(profile.clientId,req.body))));
  app.post('/api/personal-agent/actions/:id/decide',withProfile(async (req,res,profile)=>{
    const input = z.object({expectedUpdatedAt:z.string(),decision:z.enum(['approve','deny'])}).parse(req.body);
    const result=await google().decide(profile.clientId,req.params.id,input.expectedUpdatedAt,input.decision);
    await options.reviewDecided?.().catch(error=>options.logger.warn('Reviewed action saved; task wake will recover on the scheduler tick',{error}));return res.json(result);
  }));

  app.get('/api/personal-agent/computer',withProfile(async(req,res,profile)=>{
    res.setHeader('Cache-Control','private, no-store');
    if(!options.computer)return res.status(503).json({error:'Computer service is unavailable'});
    return res.json(await options.computer.read(profile.clientId,req.query));
  }));
  app.post('/api/personal-agent/computer',withProfile(async(req,res,profile)=>{
    res.setHeader('Cache-Control','private, no-store');
    if(!options.computer)return res.status(503).json({error:'Computer service is unavailable'});
    return res.json(await options.computer.write(profile.clientId,req.body));
  }));

  app.post('/api/personal-agent/tasks',withProfile(async(req,res,profile)=>{
    if(!options.tasks)return res.status(503).json({error:'Task execution is unavailable'});
    return res.status(201).json(await options.tasks.delegate(profile.clientId,req.body));
  }));

  app.get('/api/personal-agent/tasks/:roomId',withProfile(async(req,res,profile)=>{
    if(!options.tasks)return res.status(503).json({error:'Tasks are unavailable'});
    return res.json(await options.tasks.detail(profile.clientId,req.params.roomId,req.query.beforeMessageId));
  }));
  app.post('/api/personal-agent/tasks/:roomId/control',withProfile(async(req,res,profile)=>{
    if(!options.tasks)return res.status(503).json({error:'Tasks are unavailable'});
    return res.json(await options.tasks.control(profile.clientId,req.params.roomId,req.body || {}));
  }));
  app.post('/api/personal-agent/tasks/:roomId/inputs/:id',withProfile(async(req,res,profile)=>{
    if(!options.tasks)return res.status(503).json({error:'Tasks are unavailable'});
    return res.json(await options.tasks.answer(profile.clientId,req.params.roomId,req.params.id,req.body || {}));
  }));

  app.get('/api/personal-agent/files', withProfile(async (req,res,profile) => {
    if (!options.files) return res.status(503).json({ error: 'Personal files are unavailable' });
    return res.json(await options.files.list(profile.clientId,req.query));
  }));
  app.post('/api/personal-agent/files', express.raw({ type: 'application/pdf',limit: '10mb' }), withProfile(async (req,res,profile) => {
    if (!options.files) return res.status(503).json({ error: 'Personal files are unavailable' });
    if (!Buffer.isBuffer(req.body) || typeof req.query.name !== 'string') throw new RangeError('Choose a PDF file with a filename');
    return res.status(201).json(await options.files.import(profile.clientId,req.query.name,req.body));
  }));
  app.get('/api/personal-agent/files/:id/content', withProfile(async (req,res,profile) => {
    if (!options.files) return res.status(503).json({ error: 'Personal files are unavailable' });
    const found = await options.files.get(profile.clientId,req.params.id);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(found.file.name)}`);
    return res.send(found.body);
  }));
  app.post('/api/personal-agent/files/:id/fill', withProfile(async (req,res,profile) => {
    if (!options.files) return res.status(503).json({ error: 'Personal files are unavailable' });
    return res.status(201).json(await options.files.fill(profile.clientId,req.params.id,req.body?.fields));
  }));

  app.get('/api/personal-agent/watches', withProfile(async (req,res,profile) => {
    if(!options.tracking)return res.status(503).json({error:'Page tracking is unavailable'});
    return res.json(await options.tracking.list(profile.clientId,req.query));
  }));
  app.post('/api/personal-agent/watches', withProfile(async (req,res,profile) => {
    if(!options.tracking)return res.status(503).json({error:'Page tracking is unavailable'});
    return res.status(201).json(await options.tracking.create(profile.clientId,req.body || {}));
  }));
  app.patch('/api/personal-agent/watches/:id', withProfile(async (req,res,profile) => {
    if(!options.tracking)return res.status(503).json({error:'Page tracking is unavailable'});
    return res.json(await options.tracking.control(profile.clientId,req.params.id,req.body || {}));
  }));
  app.delete('/api/personal-agent/watches/:id', withProfile(async (req,res,profile) => {
    if(!options.tracking)return res.status(503).json({error:'Page tracking is unavailable'});
    return res.json(await options.tracking.remove(profile.clientId,req.params.id));
  }));
  app.get('/api/personal-agent/notifications', withProfile(async (req,res,profile) => {
    if(!options.notifications)return res.status(503).json({error:'Updates are unavailable'});
    return res.json(await options.notifications.list(profile.clientId,req.query));
  }));
  app.post('/api/personal-agent/notifications/:id/read', withProfile(async (req,res,profile) => {
    if(!options.notifications)return res.status(503).json({error:'Updates are unavailable'});
    return res.json(await options.notifications.read(profile.clientId,req.params.id));
  }));

  app.get('/api/personal-agent/ideas', withProfile(async (req, res, profile) => {
    if (!options.ideas) return res.status(503).json({ error: 'Suggestions are unavailable' });
    return res.json(await options.ideas.list(profile.clientId, req.query));
  }));
  app.post('/api/personal-agent/ideas/refresh', withProfile(async (_req, res, profile) => {
    if (!options.ideas) return res.status(503).json({ error: 'Suggestions are unavailable' });
    if (options.google && (await options.google.auth.status(profile.clientId)).connected) {
      await options.google.mail(profile.clientId);
    }
    await options.ideas.refresh(profile.clientId);
    return res.json(await options.ideas.list(profile.clientId,{status:'all'}));
  }));
  app.patch('/api/personal-agent/ideas/:id', withProfile(async (req, res, profile) => {
    if (!options.ideas) return res.status(503).json({ error: 'Suggestions are unavailable' });
    const idea = (await options.ideas.list(profile.clientId, { id: req.params.id, status: 'all', limit: 1 })).ideas[0];
    if (!idea) return res.status(404).json({ error: 'Suggestion not found' });
    if (req.body?.action === 'dismiss') return res.json(await options.ideas.dismiss(profile.clientId, idea.id, req.body.expectedUpdatedAt));
    if (req.body?.action !== 'accept') throw new RangeError('Invalid suggestion decision');
    if (!options.acceptIdea) return res.status(503).json({ error: 'Suggestion execution is unavailable' });
    return res.json(await options.acceptIdea(profile.clientId, idea.id, personalIdeaPrompt(req.body.prompt ?? idea.prompt), personalIdeaRevision(req.body.expectedUpdatedAt)));
  }));

  app.get('/api/personal-agent/results', withProfile(async (req, res, profile) => {
    if (!options.results) return res.status(503).json({ error: 'Personal results are unavailable' });
    return res.json(await options.results.list(profile.clientId, req.query));
  }));
  app.get('/api/personal-agent/results/:id/content', withProfile(async (req, res, profile) => {
    if (!options.results) return res.status(503).json({ error: 'Personal results are unavailable' });
    const found = await options.results.get(profile.clientId, req.params.id);
    if (!found) return res.status(404).json({ error: 'Result not found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', found.result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.result.filename)}`);
    return res.send(found.body);
  }));

  app.get('/api/personal-agent/browsers',withProfile(async(_req,res,profile)=>{
    if(!options.browser)return res.status(503).json({error:'Personal browser is unavailable'});
    return res.json(await options.browser.sessions(profile.clientId));
  }));
  app.post('/api/personal-agent/browsers',withProfile(async(req,res,profile)=>{
    if(!options.browser)return res.status(503).json({error:'Personal browser is unavailable'});
    return res.status(201).json(await options.browser.create(profile.clientId,req.body || {}));
  }));
  app.get('/api/personal-agent/browser/:roomId/preview',withProfile(async(req,res,profile)=>{
    if(!options.browser)return res.status(503).json({error:'Personal browser is unavailable'});
    res.setHeader('Cache-Control','private,no-store');res.type('image/jpeg');
    return res.send(await options.browser.preview(profile.clientId,req.params.roomId));
  }));
  app.get('/api/personal-agent/browser-observations', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    return res.json(await options.browser.list(profile.clientId, req.query));
  }));
  app.get('/api/personal-agent/browser-observations/:id/image', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(await options.browser.image(profile.clientId, req.params.id));
  }));
  app.get('/api/personal-agent/browser/:roomId', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    return res.json(await options.browser.current(profile.clientId, req.params.roomId));
  }));
  app.post('/api/personal-agent/browser/:roomId/take-control', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    return res.json(await options.browser.takeControl(profile.clientId, req.params.roomId));
  }));
  app.patch('/api/personal-agent/browser/:roomId/control', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    return res.json(await options.browser.manual(profile.clientId, req.params.roomId, req.body?.control, req.body || {}));
  }));
  app.post('/api/personal-agent/browser/:roomId/release-control', withProfile(async (req, res, profile) => {
    if (!options.browser) return res.status(503).json({ error: 'Personal browser is unavailable' });
    return res.json(await options.browser.releaseControl(profile.clientId, req.params.roomId, req.body?.control));
  }));

  app.get('/api/personal-agent/memories', withProfile(async (req, res, profile) =>
    res.json(await readPersonalMemories(store, profile.clientId, req.query))));
  app.post('/api/personal-agent/memories', withProfile(async (req, res, profile) =>
    res.status(201).json({ memory: await savePersonalMemory(store, profile.clientId, { ...req.body, id: undefined }, { label: 'Added by you' }) })));
  app.post('/api/personal-agent/memories/merge', withProfile(async (req, res, profile) =>
    res.json(await mergePersonalMemories(store, profile.clientId, req.body || {}, { label: 'Edited by you' }))));
  app.patch('/api/personal-agent/memories/:id', withProfile(async (req, res, profile) =>
    res.json({ memory: await savePersonalMemory(store, profile.clientId, { ...req.body, id: req.params.id }, { label: 'Edited by you' }) })));
  app.delete('/api/personal-agent/memories/:id', withProfile(async (req, res, profile) =>
    res.json(await forgetPersonalMemory(store, profile.clientId, req.params.id, req.body?.expectedUpdatedAt))));

  app.put('/api/personal-agent/profile', withProfile(async (req, res, profile) => {
    const updates: Partial<Pick<PersonalAgentProfile, 'name' | 'avatar' | 'instructions' | 'memory' | 'showUpdates' | 'pushEnabled' | 'tone'>> = {};
    for (const [key, limit] of [['name', 100], ['avatar', 64], ['instructions', 8000], ['memory', 16000]] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = textField(req.body[key], key, limit, key === 'instructions' || key === 'memory');
      }
    }
    for (const key of ['showUpdates','pushEnabled'] as const) if (req.body?.[key] !== undefined) {
      if (typeof req.body[key] !== 'boolean') throw new RangeError(`Invalid ${key}`);
      updates[key]=req.body[key];
    }
    if(req.body?.tone !== undefined){
      if(!['warm','concise','thoughtful'].includes(req.body.tone))throw new RangeError('Invalid tone');
      updates.tone=req.body.tone;
    }
    if(updates.avatar !== undefined && !['sky','sand','lilac'].includes(updates.avatar))throw new RangeError('Choose sky, sand or lilac avatar');
    const expectedUpdatedAt = req.body?.expectedUpdatedAt;
    if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)))) throw new RangeError('Invalid expectedUpdatedAt');
    const updated = await store.updatePersonalAgentProfile!(profile.clientId, updates, expectedUpdatedAt);
    if (!updated) throw new PersonalAgentMemoryConflict('Your preferences changed. Refresh before saving.');
    return res.json({ profile: updated });
  }));

  app.post('/api/personal-agent/threads', withProfile(async (req, res, profile) => {
    const memoryId = req.body?.memoryId === undefined ? undefined : textField(req.body.memoryId, 'memoryId', 100);
    const room = await store.createPersonalAgentThread!(profile.clientId, textField(req.body?.name, 'name', 100), memoryId);
    return res.status(201).json({ room });
  }));

  app.post('/api/personal-agent/threads/:id/title', withProfile(async (req, res, profile) => {
    if (!options.chatTitles) return res.status(503).json({ error: 'Chat titles are unavailable' });
    const room = await options.chatTitles.generate(profile.clientId, req.params.id);
    return room ? res.json({ room }) : res.status(404).json({ error: 'Conversation not found' });
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
    const goal=await savePersonalAgentGoal(store, profile.clientId, req.body || {}, existing);
    await options.tasks?.pauseGoal(goal);
    return res.json({goal});
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
