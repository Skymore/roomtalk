import { randomUUID } from 'node:crypto';
import { PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { PersonalAgentIdea, PersonalAgentIdeaSourceKind } from '../types';
import type {Mail} from './personalAgentGoogleTypes';
import type {PersonalAgentGoogleService} from './personalAgentGoogle';

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
  constructor(private readonly store: RoomStore,private readonly google?:Pick<PersonalAgentGoogleService,'auth'|'mail'>) {}

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
    if (!['goal', 'memory', 'result', 'browser', 'mail'].includes(String(kind))) throw new RangeError('Select a goal, memory, result, browser or mail source');
    const source = await this.store.readPersonalAgentIdeaSource!(clientId, kind as PersonalAgentIdeaSourceKind, text(body.sourceId, 'source id', 100));
    if (!source) throw new PersonalAgentIdeaError('Source not found or already handled', 404);
    const taskKind=body.taskKind ?? 'plan';
    if(!['plan','document','finance','agent'].includes(String(taskKind)))throw new RangeError('Invalid task kind');
    const input=kind==='mail'?{messageId:source.id}:kind==='goal'?{goalId:source.id}:{};
    const now = new Date().toISOString();
    const saved = await this.store.savePersonalAgentIdea!({ id: randomUUID(), clientId, source, automatic,taskKind:taskKind as PersonalAgentIdea['taskKind'],input,
      title: text(body.title, 'title', 1200), reason: text(body.reason, 'reason', 2000),
      prompt: personalIdeaPrompt(body.prompt), status: 'new', createdAt: now, updatedAt: now,
    }, claim);
    if (!saved) throw new PersonalAgentIdeaConflictError('The source changed or this turn ended. Read the source again.');
    return { idea: saved };
  }

  async refresh(clientId: string) {
    // OpenMuse refreshIdeas: PDF forms, coordination mail and goals without milestones.
    if(this.google && (await this.google.auth.status(clientId)).connected)await this.google.mail(clientId);
    const goals = await this.store.readPersonalAgentGoals!(clientId);
    for (const goal of goals.filter(item => item.enabled && !item.completedAt && !item.milestones?.length)) {
      try { await this.propose(clientId, { sourceKind: 'goal', sourceId: goal.id, title: `Let's make a plan for ${goal.title}`,taskKind:'plan',
        reason: 'This goal has no milestones yet. A concrete plan will give it a next step.',
        prompt: `Create an actionable plan for ${goal.title}. ${goal.prompt}`,
      }, undefined, true); }
      catch (error) { if (!(error instanceof PersonalAgentIdeaConflictError) && !(error instanceof PersonalAgentIdeaError && error.statusCode === 404)) throw error; }
    }
    const connection=await this.store.readPersonalGoogleCredential!(clientId);
    const records=await this.store.readPersonalGoogleRecords!(clientId,'mail');
    const mail=records.filter(record=>connection?.connectionId && record.connectionId===connection.connectionId).map(record=>record.data as unknown as Mail);
    const sent=new Set(mail.filter(item=>/^Sent\b/i.test(item.label)).map(item=>item.id));
    const completed=new Set<string>();
    for(const room of (await this.store.readPersonalAgentRooms!(clientId)).filter(room=>room.personalAgentTaskStatus==='complete')){
      const task=await this.store.readPersonalAgentTask!(clientId,room.id);
      if(task?.input.messageId)completed.add(`${task.kind}:${task.input.messageId}`);
    }
    const obsolete=(kind:PersonalAgentIdea['taskKind'],id:string)=>sent.has(id)||completed.has(`${kind}:${id}`);
    for(const kind of ['document','agent'] as const){
      const candidates=mail.filter(item=>!obsolete(kind,item.id) && (kind==='document'?item.attachments.length && /form|permission|complete|fill|sign/i.test(`${item.subject} ${item.body}`):/coffee|meet|available|schedule/i.test(`${item.subject} ${item.body}`))).slice(0,5);
      for(const message of candidates){
        try{await this.propose(clientId,{sourceKind:'mail',sourceId:message.id,taskKind:kind,
          title:kind==='document'?`I can help with ${message.subject}`:`I can help coordinate ${message.subject}`,
          reason:kind==='document'?`${message.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`:`${message.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
          prompt:kind==='document'?`Help complete the PDF from “${message.subject}” and prepare a reply for review.`:`Review the email “${message.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        },undefined,true);}catch(error){if(!(error instanceof PersonalAgentIdeaConflictError) && !(error instanceof PersonalAgentIdeaError && error.statusCode===404))throw error;}
      }
    }
    // Retire obsolete proposals; accepted and dismissed decisions remain intact.
    let offset = 0;
    while (true) {
      const found = await this.store.readPersonalAgentIdeas!(clientId, { status: 'new', limit: 100, offset });
      let retired = 0;
      for (const idea of found.ideas) {
        const current = await this.store.readPersonalAgentIdeaSource!(clientId, idea.source.kind, idea.source.id);
        if (!current || current.recordedAt !== idea.source.recordedAt || (idea.source.kind==='mail' && obsolete(idea.taskKind,idea.source.id)) || (idea.automatic && idea.source.kind==='goal' && goals.find(goal => goal.id === idea.source.id)?.milestones?.length)) {
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
