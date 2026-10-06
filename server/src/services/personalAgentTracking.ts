import { randomUUID } from 'node:crypto';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { PersonalAgentNotification, PersonalAgentWatch } from '../types';
import { PersonalAgentBrowserError, PersonalAgentBrowserService } from './personalAgentBrowser';
import { CodeAgentSandboxService } from './codeAgentSandboxService';
import { createRoomRecord } from './messageDomain';

export class PersonalAgentTrackingError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const field = (value: unknown, name: string, limit = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new RangeError(`Invalid ${name}`);
  return value.trim();
};
export const personalWatchMetadata = ({ clientId: _owner, epoch: _epoch, lastText, ...watch }: PersonalAgentWatch) =>
  ({ ...watch, ...(lastText !== undefined ? { lastExcerpt: lastText.slice(0, 1000) } : {}) });
export const personalNotificationMetadata = ({ clientId: _owner, eventKey: _key, ...notice }: PersonalAgentNotification) => notice;
export const personalPageOptions = (query: Record<string, unknown>) => {
  const limit=Number(query.limit ?? 50), offset=Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0) throw new RangeError('Invalid page');
  return {limit,offset};
};
export function matchPersonalWatch(watch: Pick<PersonalAgentWatch,'condition'|'value'|'lastText'|'matched'>, rawText: string) {
  const text=rawText.replace(/\s+/g,' ').trim();
  const matched=watch.condition==='change' ? watch.lastText!==undefined && watch.lastText!==text
    : watch.condition==='contains' ? text.toLowerCase().includes(watch.value.toLowerCase())
    : [...text.matchAll(/(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)].some(match=>Number(match[1].replace(/,/g,''))<Number(watch.value));
  return {text,matched,notify:matched && (watch.condition==='change' || !watch.matched)};
}

export class PersonalAgentTrackingService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private requested=false;
  constructor(private readonly store: RoomStore, private readonly browser: PersonalAgentBrowserService,
    private readonly sandbox: Pick<CodeAgentSandboxService,'destroy'>, private readonly logger: Logger,
    private readonly onNotification: (notice: PersonalAgentNotification) => Promise<void> = async () => {}) {}
  start() {
    if (this.timer) return;
    const run=()=>void this.tick().catch(error=>this.logger.error('Personal page tracking failed',{error}));
    this.timer=setInterval(run,60_000);this.timer.unref?.();run();
  }
  private wake() {
    if(!this.timer)return;
    this.requested=true;
    void this.tick().catch(error=>this.logger.error('Personal page tracking failed',{error}));
  }
  async stop() { if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running; }
  tick() {
    if(this.running)return this.running;
    this.running=(async()=>{
      do {this.requested=false;await this.poll();} while(this.requested);
    })().finally(()=>{this.running=undefined});return this.running;
  }
  private async poll() {
    const due=await this.store.readDuePersonalAgentWatches!(4);
    const outcomes=await Promise.allSettled(due.map(watch=>this.check(watch)));
    outcomes.forEach((outcome,index)=>{if(outcome.status==='rejected')this.logger.warn('Personal watch check failed',{error:outcome.reason,watchId:due[index].id})});
  }
  async list(clientId: string, query: Record<string, unknown> = {}) {
    const found=await this.store.readPersonalAgentWatches!(clientId,{...personalPageOptions(query),...(query.id ? {id:field(query.id,'watch id')} : {})});
    return {watches:found.watches.map(personalWatchMetadata),total:found.total};
  }
  private async get(clientId: string,id: string) {
    const watch=(await this.store.readPersonalAgentWatches!(clientId,{id:field(id,'watch id'),limit:1})).watches[0];
    if(!watch)throw new PersonalAgentTrackingError('Watch not found',404);return watch;
  }
  async create(clientId: string, body: Record<string,unknown>, claim?: {roomId: string;turnId: string}) {
    const title=field(body.title,'watch title'),url=new URL(field(body.url,'page URL',2000));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new RangeError('Use an HTTP or HTTPS page URL');
    if(!['change','contains','price_below'].includes(String(body.condition)))throw new RangeError('Invalid watch condition');
    const condition=body.condition as PersonalAgentWatch['condition'];
    let value=condition==='change' ? '' : field(body.value,'watch value',1000);
    if(condition==='price_below') { const price=Number(value);if(!Number.isFinite(price)||price<=0)throw new RangeError('Enter a positive USD price');value=String(price); }
    const intervalMinutes=Number(body.intervalMinutes ?? 30);
    if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)throw new RangeError('Check interval must be 1 to 1440 minutes');
    const now=new Date(),roomId=randomUUID();
    const watch:PersonalAgentWatch={id:randomUUID(),clientId,roomId,title,url:url.href,condition,value,intervalMinutes,status:'active',epoch:0,
      checks:0,failures:0,failureStreak:0,matched:false,nextCheckAt:now.toISOString(),createdAt:now.toISOString(),updatedAt:now.toISOString()};
    const room={...createRoomRecord({roomId,name:title,creatorId:clientId,type:'codeAgent',codeAgentBackend:'codex-app-server',now}),
      personalAgentOwnerId:clientId,personalAgentThreadKind:'watch' as const,codeAgentAccess:'owner' as const,codeAgentMode:'fullAccess' as const};
    const saved=await this.store.createPersonalAgentWatch!(watch,room,claim);
    this.wake();
    return {watch:personalWatchMetadata(saved)};
  }
  async control(clientId: string,id: string,body: Record<string,unknown>) {
    await this.get(clientId,id);
    const action=body.action;
    if(!['pause','resume','check'].includes(String(action)))throw new RangeError('Invalid watch action');
    const revision=field(body.expectedUpdatedAt,'watch version');if(!Number.isFinite(Date.parse(revision)))throw new RangeError('Invalid watch version');
    const watch=await this.store.controlPersonalAgentWatch!(clientId,id,action as 'pause'|'resume'|'check',revision);
    if(!watch)throw new PersonalAgentTrackingError('The watch changed. Refresh before trying again.',409);
    if(action!=='pause')this.wake();
    return {watch:personalWatchMetadata(watch)};
  }
  async remove(clientId: string,id: string) {
    const watch=await this.get(clientId,id),room=await this.store.getRoomById(watch.roomId);
    if(!await this.store.deleteRoom(watch.roomId,clientId))throw new PersonalAgentTrackingError('Unable to remove the watch',409);
    if(room?.sandboxId)await this.sandbox.destroy(room.sandboxId);
    return {removed:true};
  }
  async check(watch: PersonalAgentWatch) {
    let control;
    try {control=(await this.browser.takeControl(watch.clientId,watch.roomId)).control;}
    catch(error) {if(error instanceof PersonalAgentBrowserError && (error.statusCode===409||error.statusCode===404))return;throw error;}
    try {
      const current=(await this.store.readPersonalAgentWatches!(watch.clientId,{id:watch.id,limit:1})).watches[0];
      if(!current||current.status!=='active'||current.epoch!==watch.epoch||current.checks!==watch.checks)return;
      const claim={clientId:watch.clientId,id:watch.id,epoch:watch.epoch,checks:watch.checks,control};
      let observation, pageError;
      try {
        const page=await this.browser.manual(watch.clientId,watch.roomId,control,{action:'open',url:watch.url});
        if(!Number.isInteger(page.httpStatus)||page.httpStatus<200||page.httpStatus>=400)throw new Error(`Page returned HTTP ${page.httpStatus ?? 'unknown'}`);
        observation={url:page.session.url,title:page.session.title,...matchPersonalWatch(watch,page.text)};
      }catch(error) {
        pageError=error instanceof Error ? error.message : 'Page check failed';
      }
      const saved=await this.store.finishPersonalAgentWatchCheck!({...claim,checkedAt:new Date().toISOString(),
        ...(observation ? {observation} : {error:pageError})});
      if(saved?.notification)await this.onNotification(saved.notification);
    }finally {
      try {await this.browser.releaseControl(watch.clientId,watch.roomId,control);}catch(error){this.logger.warn('Watch browser release failed',{error,watchId:watch.id})}
    }
  }
}
