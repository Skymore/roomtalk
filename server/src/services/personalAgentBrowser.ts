import {createRoomRecord} from './messageDomain';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../repositories/store';
import { PersonalAgentBrowserObservation, PersonalAgentBrowserSession } from '../types';
import { CodexAuthCipher } from './codexConnection';
import { CodeAgentSandboxService } from './codeAgentSandboxService';
import { CodeAgentSandboxLifecycleService } from './codeAgentSandboxLifecycle';
import { PersonalAgentFileService } from './personalAgentFiles';
import { MediaObjectStorage } from './mediaObjectStorage';

export const PERSONAL_BROWSER_API_PATH = '/api/code-agent/room-context/personal-browser';
const CONTROL_TTL_MS = 90_000;
const WORKER = '/opt/roomtalk_code_agent_runner/roomtalk_code_agent_runner/personal_browser.cjs';
export class PersonalAgentBrowserError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const field = (value: unknown, name: string, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RangeError(`Invalid browser ${name}`);
  return value;
};
export const browserObservationMetadata = ({ clientId: _owner, objectKey: _key, ...value }: PersonalAgentBrowserObservation) => value;
export const personalBrowserMetadata = ({encryptedState:_state,clientId:_owner,previewObjectKey,...value}:PersonalAgentBrowserSession)=>({...value,...(previewObjectKey?{previewUrl:`/api/personal-agent/browser/${encodeURIComponent(value.roomId)}/preview?version=${encodeURIComponent(value.updatedAt)}`}:{})});
export type BrowserControl = { id: string; fence: number };

export function parsePersonalBrowserAction(input: Record<string, unknown>): Record<string, unknown> {
  const action = input.action;
  if (action === 'import_pdf') return {action,id:field(input.id,'download id',100)};
  if (action === 'read' || action === 'close') return { action };
  if (action === 'open') {
    let url: URL;
    try { url = new URL(field(input.url, 'URL')); } catch { throw new RangeError('Invalid browser URL'); }
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new RangeError('Use an HTTP, HTTPS or local file URL');
    return { action, url: url.href };
  }
  if (action === 'fill') {
    if (typeof input.text !== 'string' || input.text.length > 20_000) throw new RangeError('Invalid browser text');
    return { action, selector: field(input.selector, 'selector', 1000), text: input.text };
  }
  if (action === 'text') return { action, text: field(input.text, 'text', 20_000) };
  if (action === 'key') return { action, key: field(input.key, 'key', 50) };
  if (action === 'click') {
    if (input.selector !== undefined) return { action, selector: field(input.selector, 'selector', 1000) };
    const { x, y } = input;
    if (!Number.isInteger(x) || !Number.isInteger(y) || Number(x) < 0 || Number(x) >= 1280 || Number(y) < 0 || Number(y) >= 800) throw new RangeError('Invalid browser click coordinates');
    return { action, x, y };
  }
  if (action === 'scroll' && Number.isInteger(input.deltaY) && Math.abs(Number(input.deltaY)) <= 5000) return { action, deltaY: input.deltaY };
  throw new RangeError('Invalid browser action');
}

export class PersonalAgentBrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: RoomStore, private readonly sandbox: CodeAgentSandboxService,
    private readonly lifecycle: CodeAgentSandboxLifecycleService, private readonly storage: MediaObjectStorage,
    private readonly cipher: CodexAuthCipher, private readonly files?: PersonalAgentFileService) {}

  private async serial<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(roomId) || Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(roomId, next);
    try { return await next; } finally { if (this.queues.get(roomId) === next) this.queues.delete(roomId); }
  }
  private async ownedRoom(clientId: string, roomId: string) {
    const room = await this.store.getRoomById(field(roomId, 'room', 100));
    if (!room || room.personalAgentOwnerId !== clientId || room.creatorId !== clientId) throw new PersonalAgentBrowserError('Browser not found', 404);
    return room;
  }
  async sessions(clientId:string){
    const rooms=await this.store.readPersonalAgentRooms!(clientId);
    const sessions=await Promise.all(rooms.map(room=>this.current(clientId,room.id)));
    return {sessions:sessions.flatMap(value=>value.session?[value.session]:[])};
  }
  async preview(clientId:string,roomId:string){
    await this.ownedRoom(clientId,roomId);
    const session=await this.store.getPersonalAgentBrowserSession!(clientId,roomId);
    if(!session?.previewObjectKey)throw new PersonalAgentBrowserError('Preview unavailable. Open the browser to reconnect.',404);
    return (await this.storage.getMediaObject!(session.previewObjectKey)).body;
  }
  async create(clientId:string,input:Record<string,unknown>,source?:{clientId:string;roomId:string;turnId:string}){
    const action=parsePersonalBrowserAction({action:'open',url:input.url});
    const room={...createRoomRecord({roomId:randomUUID(),name:'Browser',creatorId:clientId,type:'codeAgent',codeAgentBackend:'codex-app-server',now:new Date()}),personalAgentOwnerId:clientId,personalAgentThreadKind:'browser' as const,codeAgentAccess:'owner' as const,codeAgentMode:'fullAccess' as const};
    if(!await this.store.saveRoom(room))throw new PersonalAgentBrowserError('Browser session could not be created',503);
    const {control}=await this.takeControl(clientId,room.id);
    const leaseTurnId=`browser-control:${control.id}`;
    await this.store.savePersonalAgentBrowser!({id:room.id,clientId,roomId:room.id,url:String(action.url),title:'Browser',status:'active',updatedAt:new Date().toISOString()},leaseTurnId);
    try{return await this.serial(room.id,()=>this.execute(clientId,room.id,leaseTurnId,action,source));}
    catch(error){
      const session=await this.store.getPersonalAgentBrowserSession!(clientId,room.id);
      if(session)await this.store.savePersonalAgentBrowser!({...session,status:'error'},leaseTurnId);
      throw error;
    }finally{await this.releaseControl(clientId,room.id,control);}
  }
  async current(clientId: string, roomId: string) {
    await this.ownedRoom(clientId, roomId);
    const session = await this.store.getPersonalAgentBrowserSession!(clientId, roomId);
    return { session: session ? personalBrowserMetadata(session) : null };
  }
  async list(clientId: string, query: Record<string, unknown>) {
    const limit = Number(query.limit ?? 50), offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Invalid browser history page');
    const options: { id?: string; roomId?: string; turnId?: string; limit: number; offset: number } = { limit, offset };
    for (const key of ['id', 'roomId', 'turnId'] as const) if (query[key] !== undefined) options[key] = field(query[key], key, 100);
    const found = await this.store.readPersonalAgentBrowserObservations!(clientId, options);
    return { observations: found.observations.map(browserObservationMetadata), total: found.total };
  }
  async image(clientId: string, id: string) {
    const found = (await this.store.readPersonalAgentBrowserObservations!(clientId, { id: field(id, 'observation', 100), limit: 1 })).observations[0];
    if (!found) throw new PersonalAgentBrowserError('Browser observation not found', 404);
    return (await this.storage.getMediaObject!(found.objectKey)).body;
  }
  async takeControl(clientId: string, roomId: string) {
    await this.ownedRoom(clientId, roomId);
    const id = randomUUID();
    const lease = await this.store.acquireCodeAgentRoomLease!(roomId, `browser-control:${id}`, `personal-browser:${clientId}`, new Date().toISOString(), CONTROL_TTL_MS);
    if (!lease) throw new PersonalAgentBrowserError('Wait for the agent or other browser window to finish', 409);
    return { control: { id, fence: lease.fence } };
  }
  private async renew(clientId: string, roomId: string, control: BrowserControl) {
    await this.ownedRoom(clientId, roomId);
    if (!control || typeof control.id !== 'string' || !/^[0-9a-f-]{36}$/.test(control.id) || !Number.isInteger(control.fence)) throw new RangeError('Invalid browser control');
    const lease = await this.store.renewCodeAgentRoomLease!(roomId, `browser-control:${control.id}`, `personal-browser:${clientId}`, new Date().toISOString(), CONTROL_TTL_MS, control.fence);
    if (!lease) throw new PersonalAgentBrowserError('Browser control expired. Open the browser again.', 409);
    return lease.turnId;
  }
  async releaseControl(clientId: string, roomId: string, control: BrowserControl) {
    await this.ownedRoom(clientId, roomId);
    if (!control || typeof control.id !== 'string' || !Number.isInteger(control.fence)) throw new RangeError('Invalid browser control');
    return { released: await this.store.releaseCodeAgentRoomLease!(roomId, `browser-control:${control.id}`, `personal-browser:${clientId}`, control.fence) };
  }
  async manual(clientId: string, roomId: string, control: BrowserControl, input: Record<string, unknown>) {
    const action = parsePersonalBrowserAction(input);
    return this.serial(roomId, async () => this.execute(clientId, roomId, await this.renew(clientId, roomId, control), action));
  }
  async agent(source:{clientId:string;roomId:string;turnId:string},input:Record<string,unknown>){
    await this.ownedRoom(source.clientId,source.roomId);
    if(!await this.store.hasActiveCodeAgentRoomLease!(source.roomId,new Date().toISOString(),source.turnId))throw new PersonalAgentBrowserError('This agent turn ended',403);
    if(input.action==='create')return this.create(source.clientId,input,source);
    const action=parsePersonalBrowserAction(input);
    if(input.sessionId!==undefined){
      const session=await this.store.getPersonalAgentBrowserSession!(source.clientId,field(input.sessionId,'session id',100));
      if(!session)throw new PersonalAgentBrowserError('Browser session not found',404);
      if(session.roomId!==source.roomId){
        const {control}=await this.takeControl(source.clientId,session.roomId);
        try{return await this.serial(session.roomId,()=>this.execute(source.clientId,session.roomId,`browser-control:${control.id}`,action,source));}
        finally{await this.releaseControl(source.clientId,session.roomId,control);}
      }
    }
    return this.serial(source.roomId,()=>this.execute(source.clientId,source.roomId,source.turnId,action,source));
  }
  private async execute(clientId: string, roomId: string, leaseTurnId: string, action: Record<string, unknown>, source?:{clientId:string;roomId:string;turnId:string}) {
    const recordVisit=Boolean(source);
    const previous = await this.store.getPersonalAgentBrowserSession!(clientId, roomId);
    const ready = await this.lifecycle.ensureReadySandbox(roomId, clientId);
    if (!ready.ok) throw new PersonalAgentBrowserError('Browser environment is not ready', 503);
    if (!recordVisit) await this.sandbox.setSandboxTimeout!(ready.handle, 150_000);
    const id = previous?.id || randomUUID();
    const input = { ...action, sessionId: id, initialUrl: previous?.url, ...(previous?.encryptedState ? { storageState: JSON.parse(this.cipher.decryptAuthJson(JSON.parse(previous.encryptedState))) } : {}) };
    const requestPath = `/tmp/roomtalk-codex/browser-${randomUUID()}.json`;
    let output = '';
    await this.sandbox.writeSecretFile!(ready.handle, { path: requestPath, content: JSON.stringify(input) });
    try {
      const process = await this.sandbox.startWorkspaceCommand!({ handle: ready.handle, command: `node ${WORKER} request-file ${requestPath}`, timeoutMs: 45_000,
        env: { NODE_PATH: '/usr/lib/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' } });
      if (!process.stdout || !process.completed) throw new PersonalAgentBrowserError('Browser execution is unavailable', 503);
      const read = new Promise<void>((resolve, reject) => {
        process.stdout!.on('data', chunk => {
          output += chunk.toString();
          if (Buffer.byteLength(output) > 18 * 1024 * 1024) { reject(new PersonalAgentBrowserError('Browser response exceeds its limit', 400)); void process.stop(); }
        });
        process.stdout!.once('end', resolve); process.stdout!.once('error', reject);
      });
      const [completed] = await Promise.all([process.completed, read]);
      if (completed?.exitCode !== 0) throw new PersonalAgentBrowserError('Browser action could not finish', 503);
    } finally { await this.sandbox.deleteSecretFile!(ready.handle, requestPath); }
    const observed = JSON.parse(output);
    if (!observed.success) throw new PersonalAgentBrowserError(typeof observed.error === 'string' ? observed.error.slice(0, 500) : 'Browser action failed', 400);
    const state = JSON.stringify(observed.storageState);
    if (Buffer.byteLength(state || '') > 1024 * 1024) throw new PersonalAgentBrowserError('Browser login state is too large to save', 400);
    const session: PersonalAgentBrowserSession = { id, clientId, roomId, url: observed.url || previous?.url || 'about:blank',
      title: observed.title || previous?.title || '',status:observed.closed?'closed':'active',previewObjectKey:previous?.previewObjectKey, encryptedState: state ? JSON.stringify(this.cipher.encryptAuthJson(state)) : undefined, updatedAt: new Date().toISOString() };
    let observation: PersonalAgentBrowserObservation | undefined;
    if (source && !observed.closed) {
      const visitId = randomUUID();
      const body = Buffer.from(observed.screenshot, 'base64');
      if (!body.length || body.length > 2 * 1024 * 1024) throw new PersonalAgentBrowserError('Browser screenshot exceeds its limit', 400);
      observation = { id: visitId, sessionId:session.id,browserRoomId:session.roomId,clientId, roomId:source.roomId, turnId:source.turnId, url: session.url, title: session.title,
        objectKey: `personal-agent-browser/${roomId}/${visitId}.jpg`, createdAt: session.updatedAt };
      await this.storage.putMediaObject({ objectKey: observation.objectKey, body, byteSize: body.length, mimeType: 'image/jpeg' });
    }
    if(!observed.closed && observed.screenshot){
      const body=Buffer.from(observed.screenshot,'base64');
      if(!body.length || body.length>2*1024*1024)throw new PersonalAgentBrowserError('Browser screenshot exceeds its limit',400);
      session.previewObjectKey=observation?.objectKey || `personal-agent-browser/${roomId}/preview.jpg`;
      if(!observation)await this.storage.putMediaObject({objectKey:session.previewObjectKey,body,byteSize:body.length,mimeType:'image/jpeg'});
    }
    try {
      if (!await this.store.savePersonalAgentBrowser!(session, leaseTurnId, observation)) throw new PersonalAgentBrowserError('Browser execution ended before the observation was saved', 409);
    } catch (error) {
      if (observation) await this.storage.deleteMediaObject!(observation.objectKey);
      throw error;
    }
    let file: unknown;
    if (action.action === 'import_pdf') {
      if (!this.files || !observed.download || typeof observed.download.content !== 'string') throw new PersonalAgentBrowserError('Downloaded PDF is unavailable',400);
      const saved = await this.files.import(clientId,observed.download.name,Buffer.from(observed.download.content,'base64'),`Browser: ${observed.download.url}`,undefined,source ? {roomId:source.roomId,turnId:source.turnId} : undefined);
      file = saved.file;
    }
    return { ...(file ? {file} : {}), downloads: observed.downloads || [], session: personalBrowserMetadata(session), ...(observation ? { observation: browserObservationMetadata(observation) } : {}),
      httpStatus: observed.httpStatus, text: observed.text || '', truncated: observed.truncated === true,
      ...(recordVisit ? {} : { screenshot: observed.screenshot, viewport: observed.viewport }), closed: observed.closed === true };
  }
}
