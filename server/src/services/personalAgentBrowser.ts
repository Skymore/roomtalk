import { randomUUID } from 'node:crypto';
import { RoomStore } from '../repositories/store';
import { PersonalAgentBrowserObservation, PersonalAgentBrowserSession } from '../types';
import { CodexAuthCipher } from './codexConnection';
import { CodeAgentSandboxService } from './codeAgentSandboxService';
import { CodeAgentSandboxLifecycleService } from './codeAgentSandboxLifecycle';
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
const sessionMetadata = ({ encryptedState: _state, clientId: _owner, ...value }: PersonalAgentBrowserSession) => value;
export type BrowserControl = { id: string; fence: number };

export function parsePersonalBrowserAction(input: Record<string, unknown>): Record<string, unknown> {
  const action = input.action;
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
    private readonly cipher: CodexAuthCipher) {}

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
  async current(clientId: string, roomId: string) {
    await this.ownedRoom(clientId, roomId);
    const session = await this.store.getPersonalAgentBrowserSession!(clientId, roomId);
    return { session: session ? sessionMetadata(session) : null };
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
  async agent(source: { clientId: string; roomId: string; turnId: string }, input: Record<string, unknown>) {
    const action = parsePersonalBrowserAction(input);
    return this.serial(source.roomId, async () => {
      await this.ownedRoom(source.clientId, source.roomId);
      if (!await this.store.hasActiveCodeAgentRoomLease!(source.roomId, new Date().toISOString(), source.turnId)) throw new PersonalAgentBrowserError('This agent turn ended', 403);
      return this.execute(source.clientId, source.roomId, source.turnId, action, true);
    });
  }
  private async execute(clientId: string, roomId: string, leaseTurnId: string, action: Record<string, unknown>, recordVisit = false) {
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
          if (Buffer.byteLength(output) > 8 * 1024 * 1024) { reject(new PersonalAgentBrowserError('Browser response exceeds its limit', 400)); void process.stop(); }
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
      title: observed.title || previous?.title || '', encryptedState: state ? JSON.stringify(this.cipher.encryptAuthJson(state)) : undefined, updatedAt: new Date().toISOString() };
    let observation: PersonalAgentBrowserObservation | undefined;
    if (recordVisit && !observed.closed) {
      const visitId = randomUUID();
      const body = Buffer.from(observed.screenshot, 'base64');
      if (!body.length || body.length > 2 * 1024 * 1024) throw new PersonalAgentBrowserError('Browser screenshot exceeds its limit', 400);
      observation = { id: visitId, clientId, roomId, turnId: leaseTurnId, url: session.url, title: session.title,
        objectKey: `personal-agent-browser/${roomId}/${visitId}.jpg`, createdAt: session.updatedAt };
      await this.storage.putMediaObject({ objectKey: observation.objectKey, body, byteSize: body.length, mimeType: 'image/jpeg' });
    }
    try {
      if (!await this.store.savePersonalAgentBrowser!(session, leaseTurnId, observation)) throw new PersonalAgentBrowserError('Browser execution ended before the observation was saved', 409);
    } catch (error) {
      if (observation) await this.storage.deleteMediaObject!(observation.objectKey);
      throw error;
    }
    return { session: sessionMetadata(session), ...(observation ? { observation: browserObservationMetadata(observation) } : {}),
      text: observed.text || '', truncated: observed.truncated === true,
      ...(recordVisit ? {} : { screenshot: observed.screenshot, viewport: observed.viewport }), closed: observed.closed === true };
  }
}
