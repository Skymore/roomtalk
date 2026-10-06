// Workspace and review flows ported from OpenMuse workspace.ts/actions.ts.
// Original MIT notice is retained in personalAgentGoogleTypes.ts.
import { randomUUID } from 'node:crypto';
import { z } from 'openmuse-zod';
import { RoomStore } from '../repositories/store';
import { PersonalAgentFileService } from './personalAgentFiles';
import { PersonalAgentGoogleAuth, PersonalGoogleError } from './personalAgentGoogleAuth';
import { GoogleClient, OutcomeUnknownError } from './personalAgentGoogleClient';
import { CalendarEvent, Mail, PersonalGoogleAction, PersonalGoogleRecord, PersonalGoogleDraft, emailDraftSchema, proposalSchema, ProposalInput } from './personalAgentGoogleTypes';

export const PERSONAL_GOOGLE_API_PATH = '/api/code-agent/room-context/personal-google';
export class PersonalAgentGoogleService {
  constructor(private readonly store: RoomStore, readonly auth: PersonalAgentGoogleAuth,
    private readonly files: PersonalAgentFileService, private readonly fetcher = fetch) {}
  private async connection(clientId: string) {
    const tokens = await this.auth.tokens(clientId);
    if (!tokens) throw new PersonalGoogleError('Google is disconnected',409);
    return tokens;
  }
  private google(clientId: string, connectionId: string) {
    return new GoogleClient({getAccessToken:()=>this.auth.accessToken(clientId,connectionId),fetch:this.fetcher});
  }
  private async records(clientId: string, kind: PersonalGoogleRecord['kind'], id?: string) {
    return this.store.readPersonalGoogleRecords!(clientId,kind,id);
  }
  private async put(clientId: string, kind: PersonalGoogleRecord['kind'], id: string, data: object,
    connectionId?: string, expectedUpdatedAt?: string) {
    const saved = await this.store.savePersonalGoogleRecord!({clientId,kind,id,data:data as Record<string,unknown>,connectionId,updatedAt:new Date().toISOString()},expectedUpdatedAt);
    if (!saved) throw new PersonalGoogleError('This item changed. Refresh it before continuing.',409);
    return saved;
  }
  private async cacheMail(clientId: string, mail: Mail[], connectionId: string) {
    const imports = await this.records(clientId,'attachment');
    for (const message of mail) {
      message.attachments = message.attachments.map(ref=>{
        const saved = imports.find(item=>item.id === ref && item.connectionId === connectionId);
        return saved ? String(saved.data.fileId) : ref;
      });
      await this.put(clientId,'mail',message.id,message,connectionId);
    }
    return mail;
  }
  async mail(clientId: string, query = 'in:inbox') {
    if (query.length > 4000) throw new RangeError('Mail search is too long');
    const connection = await this.connection(clientId);
    return {mail:await this.cacheMail(clientId,await this.google(clientId,connection.connectionId).listMail(query || 'in:inbox'),connection.connectionId)};
  }
  async thread(clientId: string, id: string) {
    const connection = await this.connection(clientId);
    const mail = await this.cacheMail(clientId,await this.google(clientId,connection.connectionId).getThread(id),connection.connectionId);
    if (!mail.length) throw new PersonalGoogleError('Mail thread not found',404);
    return {mail:mail.sort((a,b)=>a.date.localeCompare(b.date))};
  }
  async message(clientId:string,id:string){
    const connection=await this.connection(clientId);
    const cached=(await this.records(clientId,'mail',id))[0];
    if(!cached || cached.connectionId!==connection.connectionId || typeof cached.data.threadId!=='string')throw new PersonalGoogleError('Choose a message from your connected inbox',404);
    const messages=await this.thread(clientId,cached.data.threadId);
    const mail=messages.mail.find(message=>message.id===id);
    if(!mail)throw new PersonalGoogleError('Mail message no longer exists',404);
    return {mail};
  }
  async calendars(clientId: string) {
    const connection = await this.connection(clientId);
    return {calendars:await this.google(clientId,connection.connectionId).listCalendars()};
  }
  async events(clientId: string, raw: unknown) {
    const options = z.object({calendarId:z.string().min(1).max(1024).optional(),
      timeMin:z.iso.datetime({offset:true}).optional(),timeMax:z.iso.datetime({offset:true}).optional()}).parse(raw);
    if (options.timeMin && options.timeMax && (Date.parse(options.timeMax)<=Date.parse(options.timeMin) || Date.parse(options.timeMax)-Date.parse(options.timeMin)>366*86400000)) throw new RangeError('Choose a calendar range of at most 366 days');
    const connection = await this.connection(clientId);
    const events = await this.google(clientId,connection.connectionId).listEvents(options);
    for (const event of events) await this.put(clientId,'event',`${event.calendarId}:${event.id}`,event,connection.connectionId);
    return {events};
  }
  async drafts(clientId: string) { return {drafts:(await this.records(clientId,'draft')).map(item=>({...item.data as unknown as PersonalGoogleDraft,updatedAt:item.updatedAt}))}; }
  async saveDraft(clientId: string, raw: unknown) {
    const value = emailDraftSchema.extend({id:z.string().uuid().optional(),expectedUpdatedAt:z.string().optional()}).parse(raw);
    const existing = value.id ? (await this.records(clientId,'draft',value.id))[0] : undefined;
    if (value.id && !existing) throw new PersonalGoogleError('Draft not found',404);
    const {expectedUpdatedAt,id:requestedId,...draft} = value;
    const id = requestedId ?? randomUUID();
    const saved = await this.put(clientId,'draft',id,{...draft,id,createdAt:existing?.data.createdAt ?? new Date().toISOString()},undefined,expectedUpdatedAt);
    return {draft:{...saved.data as unknown as PersonalGoogleDraft,updatedAt:saved.updatedAt}};
  }
  async importAttachment(clientId: string, reference: string,claim?:{roomId:string;turnId:string}) {
    const connection = await this.connection(clientId);
    const cached = (await this.records(clientId,'attachment',reference))[0];
    if(cached?.connectionId===connection.connectionId){
      const file=(await this.files.get(clientId,String(cached.data.fileId))).file;
      if(claim && !await this.store.linkPersonalAgentTaskFile!(clientId,file.id,claim))throw new PersonalGoogleError('This agent turn ended',409);
      return {file};
    }
    const [messageId,attachmentId,filename] = reference.split(':');
    if (!messageId || !attachmentId || !filename) throw new RangeError('Invalid attachment reference');
    const message = (await this.records(clientId,'mail',messageId))[0];
    const attachments = message?.data.attachments as string[] | undefined;
    if (message?.connectionId !== connection.connectionId || !attachments?.includes(reference)) throw new PersonalGoogleError('Refresh the current account mail thread before importing this attachment',404);
    const bytes = await this.google(clientId,connection.connectionId).getAttachment(messageId,attachmentId);
    const result = await this.files.import(clientId,decodeURIComponent(filename),Buffer.from(bytes),`Gmail · ${message.data.subject}`,undefined,claim);
    await this.put(clientId,'attachment',reference,{fileId:result.file.id},connection.connectionId);
    return result;
  }
  async propose(clientId: string, raw: unknown,source?:{roomId:string;turnId:string}) {
    const input = proposalSchema.parse(raw), connection = await this.connection(clientId);
    let target: CalendarEvent | undefined, targetVersion: string | undefined;
    if (input.kind === 'email.send') for (const id of input.data.attachmentIds) await this.files.get(clientId,id);
    if (input.kind === 'calendar.update' || input.kind === 'calendar.delete') {
      const reviewed = await this.google(clientId,connection.connectionId).reviewEvent(input.data.calendarId,input.data.eventId);
      target = reviewed.event; targetVersion = reviewed.version;
      if (input.kind === 'calendar.delete') input.data.title = target.title;
    }
    const action: PersonalGoogleAction = {id:randomUUID(),kind:input.kind,data:input.data,
      title:input.kind==='email.send'?`Send “${input.data.subject}”`:input.kind==='calendar.delete'?`Delete ${input.data.title}`:`${input.kind==='calendar.create'?'Create':'Update'} ${input.data.title}`,
      account:connection.account,connectionId:connection.connectionId,target,targetVersion,
      ...(source?{sourceRoomId:source.roomId,sourceTurnId:source.turnId}:{}),
      status:'awaiting_review',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString()};
    const saved = await this.put(clientId,'action',action.id,action,connection.connectionId);
    await this.record(clientId,action,'Ready for your review');
    return {action:{...action,updatedAt:saved.updatedAt}};
  }
  async activity(clientId:string){
    return {activity:(await this.records(clientId,'activity')).map(item=>item.data)};
  }
  private async record(clientId:string,action:PersonalGoogleAction,detail:string){
    const id=randomUUID();
    await this.put(clientId,'activity',id,{id,actionId:action.id,title:action.title,detail,date:new Date().toISOString(),status:action.status});
  }
  async actions(clientId: string) {
    const actions = await this.records(clientId,'action');
    for (const action of actions) if (action.data.status === 'executing' && Date.parse(action.updatedAt)<Date.now()-120000) {
      const saved = await this.store.savePersonalGoogleRecord!({...action,data:{...action.data,status:'outcome_unknown',error:'Execution was interrupted. Check Google before trying again.'}},action.updatedAt);
      if (saved) Object.assign(action,saved);
    }
    return {actions:actions.map(item=>({...item.data as unknown as PersonalGoogleAction,updatedAt:item.updatedAt}))};
  }
  private async assertSourceTask(clientId:string,action:PersonalGoogleAction){
    if(!action.sourceRoomId)return;
    const room=await this.store.getRoomById(action.sourceRoomId);
    const turns=await this.store.readRoomAgentTurns!(action.sourceRoomId);
    const latest=turns[turns.length-1];
    if(room?.personalAgentTaskControl || room?.personalAgentOwnerId!==clientId || (latest?.id!==action.sourceTurnId && room.personalAgentResumedTurnId!==action.sourceTurnId) || (!['running','complete'].includes(latest?.status || '') && room.personalAgentResumedTurnId!==latest?.id))throw new PersonalGoogleError('Resume the task before approving this action. Cancelled tasks cannot execute.',409);
  }
  async decide(clientId: string, id: string, expectedUpdatedAt: string, decision: 'approve' | 'deny') {
    const stored = (await this.records(clientId,'action',id))[0];
    if (!stored) throw new PersonalGoogleError('Action not found',404);
    if (stored.updatedAt !== expectedUpdatedAt) throw new PersonalGoogleError('This review changed. Refresh it before deciding.',409);
    const action = stored.data as unknown as PersonalGoogleAction;
    if (action.status !== 'awaiting_review') return {action:{...action,updatedAt:stored.updatedAt}};
    if (Date.parse(action.expiresAt) <= Date.now()) {
      await this.store.claimPersonalGoogleAction!(clientId,id,expectedUpdatedAt,'expired');
      throw new PersonalGoogleError('Review expired. Prepare a fresh action.',409);
    }
    if (decision === 'approve') {
      await this.assertSourceTask(clientId,action);
      const connection = await this.connection(clientId);
      if (connection.connectionId !== action.connectionId || connection.account !== action.account) throw new PersonalGoogleError('Google account changed. Prepare a new action.',409);
      const scope = action.kind === 'email.send' ? 'gmail.send' : 'calendar.events';
      if (!connection.scopes.includes(`https://www.googleapis.com/auth/${scope}`)) throw new PersonalGoogleError('Enable Google write access in Apps before continuing',403);
    }
    const claimed = await this.store.claimPersonalGoogleAction!(clientId,id,expectedUpdatedAt,decision === 'deny' ? 'denied' : 'executing');
    if (!claimed) throw new PersonalGoogleError('This action was already decided',409);
    await this.record(clientId,claimed.data as unknown as PersonalGoogleAction,decision==='deny'?'Declined; no changes made':'Approved; execution started');
    if (decision === 'deny') return {action:{...claimed.data as unknown as PersonalGoogleAction,updatedAt:claimed.updatedAt}};
    try{await this.assertSourceTask(clientId,action);}catch(error){
      await this.put(clientId,'action',id,{...action,status:'denied',error:error instanceof Error?error.message:String(error)},action.connectionId,claimed.updatedAt);
      throw error;
    }
    const finished: PersonalGoogleAction = {...action,status:'executing'};
    try {
      const input = proposalSchema.parse({kind:action.kind,data:action.data});
      finished.result = await this.execute(clientId,input,action.connectionId,action.targetVersion);
      finished.status = 'succeeded';
    } catch (error) {
      finished.status = error instanceof OutcomeUnknownError ? 'outcome_unknown' : 'failed';
      finished.error = error instanceof Error ? error.message : 'Execution failed';
    }
    const saved = await this.put(clientId,'action',id,finished,action.connectionId,claimed.updatedAt);
    await this.record(clientId,finished,finished.result ?? finished.error ?? finished.status);
    return {action:{...finished,updatedAt:saved.updatedAt}};
  }
  private async execute(clientId: string, input: ProposalInput, connectionId: string, targetVersion?: string) {
    const google = this.google(clientId,connectionId);
    if (input.kind === 'email.send') {
      const attachments = await Promise.all(input.data.attachmentIds.map(async id=>{
        const {file,body} = await this.files.get(clientId,id);
        return {name:file.name,mimeType:'application/pdf',bytes:body};
      }));
      const receipt = await google.sendEmail(input.data,attachments);
      return `Gmail sent message · ${receipt.id}`;
    }
    if ((input.kind === 'calendar.update' || input.kind === 'calendar.delete') && !targetVersion) throw new PersonalGoogleError('Prepare a fresh event review with its current version',409);
    if (input.kind === 'calendar.delete') {
      await google.deleteEvent(input.data.calendarId,input.data.eventId,targetVersion);
      return `Deleted Google Calendar event · ${input.data.eventId}`;
    }
    const event = input.kind === 'calendar.create' ? await google.createEvent(input.data) : await google.updateEvent(input.data.eventId,input.data,targetVersion);
    await this.put(clientId,'event',`${event.calendarId}:${event.id}`,event,connectionId);
    return `Google Calendar event · ${event.id}`;
  }
}
