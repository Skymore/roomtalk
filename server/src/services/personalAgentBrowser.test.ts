import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { PersonalAgentBrowserService, parsePersonalBrowserAction } from './personalAgentBrowser';
import { CodexAuthCipher } from './codexConnection';
import type { PersonalAgentBrowserObservation, PersonalAgentBrowserSession } from '../types';

const source = { clientId: 'owner', roomId: 'private', turnId: 'actual-turn' };
const cipher = new CodexAuthCipher('test-only-browser-profile-key');
function fixture() {
  const objects = new Map<string, Buffer>(), requests = new Map<string, string>(), visits: PersonalAgentBrowserObservation[] = [];
  let session: PersonalAgentBrowserSession | null = null, active = true, rejectSave = false, failSave = false;
  let savedLease = '', workerInput: any, command = '';
  const service = new PersonalAgentBrowserService({
    getRoomById: async (id: string) => id === 'private' ? { id, creatorId: 'owner', personalAgentOwnerId: 'owner' } : null,
    getPersonalAgentBrowserSession: async (owner: string) => owner === 'owner' ? session : null,
    readPersonalAgentBrowserObservations: async (owner: string, query: any) => {
      const rows = visits.filter(visit => visit.clientId === owner && (!query.id || query.id === visit.id)); return { observations: rows, total: rows.length };
    },
    savePersonalAgentBrowser: async (row: PersonalAgentBrowserSession, lease: string, visit?: PersonalAgentBrowserObservation) => {
      if (failSave) throw new Error('database unavailable');
      if (rejectSave) return false; session = row; savedLease = lease; if (visit) visits.push(visit); return true;
    },
    hasActiveCodeAgentRoomLease: async (_room: string, _now: string, turn: string) => active && turn === source.turnId,
    acquireCodeAgentRoomLease: async (_room: string, turn: string, owner: string) => active ? null : { turnId: turn, ownerId: owner, fence: 7 },
    renewCodeAgentRoomLease: async (_room: string, turn: string, _owner: string, _now: string, _ttl: number, fence: number) => !active && fence === 7 ? { turnId: turn, fence } : null,
    releaseCodeAgentRoomLease: async (_room: string, _turn: string, _owner: string, fence: number) => fence === 7,
  } as any, {
    setSandboxTimeout: async () => {},
    writeSecretFile: async (_handle: any, file: any) => { requests.set(file.path, file.content); },
    deleteSecretFile: async (_handle: any, file: string) => { requests.delete(file); },
    startWorkspaceCommand: async (input: any) => {
      assert.deepEqual(input.env, { NODE_PATH: '/usr/lib/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' });
      command = input.command; workerInput = JSON.parse(requests.get(input.command.split(' ').at(-1)!)!);
      const observed = { success: true, title: 'Actual page title', url: 'https://example.org/confirmed', text: 'Confirmed content', truncated: false,
        screenshot: Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64'), viewport: { width: 1280, height: 800 },
        storageState: { cookies: [{ name: 'session', value: 'private-login-cookie' }], origins: [] } };
      return { stdout: Readable.from([JSON.stringify(observed)]), completed: Promise.resolve({ exitCode: 0 }) };
    },
  } as any, { ensureReadySandbox: async () => ({ ok: true, handle: { id: 'sandbox' } }) } as any, {
    putMediaObject: async (object: any) => { objects.set(object.objectKey, object.body); },
    getMediaObject: async (key: string) => ({ body: objects.get(key) }), deleteMediaObject: async (key: string) => { objects.delete(key); },
  } as any, cipher);
  return { service, objects, visits, requests, get session() { return session; }, get workerInput() { return workerInput; }, get command() { return command; }, get savedLease() { return savedLease; },
    end() { active = false; }, reject() { rejectSave = true; }, fail() { failSave = true; } };
}
describe('personal shared browser', () => {
  it('saves immutable sourced screenshots and encrypted login state without exposing it to the agent', async () => {
    const test = fixture();
    const result = await test.service.agent(source, { action: 'open', url: 'https://example.org', clientId: 'forged', turnId: 'forged' });
    assert.equal(result.text, 'Confirmed content'); assert.equal(test.visits[0].turnId, source.turnId);
    assert.equal(test.visits[0].url, 'https://example.org/confirmed'); assert.equal(test.objects.size, 1);
    assert.equal('objectKey' in result.observation!, false); assert.equal('encryptedState' in result.session, false);
    assert.equal(JSON.stringify(result).includes('private-login-cookie'), false);
    assert.equal(test.session!.encryptedState!.includes('private-login-cookie'), false);
    assert.equal(JSON.parse(cipher.decryptAuthJson(JSON.parse(test.session!.encryptedState!))).cookies[0].value, 'private-login-cookie');
    assert.equal(test.requests.size, 0); assert.equal(test.command.includes('private-login-cookie'), false);
    await test.service.agent(source, { action: 'read' });
    assert.equal(test.workerInput.storageState.cookies[0].value, 'private-login-cookie');
    assert.equal(test.workerInput.sessionId, test.session!.id); assert.equal(test.visits.length, 2);
    assert.equal((await test.service.list('other', {})).total, 0);
    await assert.rejects(test.service.image('other', test.visits[0].id), /not found/);
  });
  it('refuses foreign rooms, stale turns and concurrent user control', async () => {
    const test = fixture();
    await assert.rejects(test.service.agent({ ...source, clientId: 'other' }, { action: 'read' }), /not found/);
    await assert.rejects(test.service.agent({ ...source, turnId: 'old-turn' }, { action: 'read' }), /ended/);
    await assert.rejects(test.service.takeControl('owner', 'private'), /Wait for the agent/);
    test.end();
    const held = (await test.service.takeControl('owner', 'private')).control;
    const live = await test.service.manual('owner', 'private', held, { action: 'read' });
    assert.equal(typeof live.screenshot, 'string'); assert.equal(test.visits.length,0);assert.equal(test.objects.size,1);assert.ok(live.session.previewUrl);assert.equal('previewObjectKey' in live.session,false);
    assert.equal(test.savedLease, `browser-control:${held.id}`);
    await assert.rejects(test.service.manual('owner', 'private', { ...held, fence: 6 }, { action: 'read' }), /expired/);
    assert.equal((await test.service.releaseControl('owner', 'private', held)).released, true);
  });
  it('cleans screenshot uploads if the execution lease ends or the database fails', async () => {
    for (const failure of ['reject', 'fail'] as const) {
      const test = fixture(); test[failure]();
      await assert.rejects(test.service.agent(source, { action: 'read' }));
      assert.equal(test.objects.size, 0); assert.equal(test.requests.size, 0);
    }
  });
  it('validates real browser operations before starting a process', () => {
    for (const action of [{ action: 'open', url: 'invalid' }, { action: 'open', url: 'javascript:alert(1)' }, { action: 'click', x: -1, y: 2 },
      { action: 'click', x: 1280, y: 3 }, { action: 'scroll', deltaY: 9000 }, { action: 'unknown' }]) assert.throws(() => parsePersonalBrowserAction(action), RangeError);
    assert.deepEqual(parsePersonalBrowserAction({ action: 'fill', selector: 'input', text: '' }), { action: 'fill', selector: 'input', text: '' });
  });
});
