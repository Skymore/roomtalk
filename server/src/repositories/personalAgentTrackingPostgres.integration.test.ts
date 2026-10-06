import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './postgresPool';
import { PostgresPool, PostgresStore } from './postgresStore';
import { PersonalAgentTrackingService, matchPersonalWatch } from '../services/personalAgentTracking';
import { PersonalAgentWatch, Message } from '../types';
import {PersonalAgentTaskService} from '../services/personalAgentTasks';
import { withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';

const databaseUrl = process.env.ROOM_EVENT_TEST_DATABASE_URL;
if (databaseUrl && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1))) throw new Error('Tracking requires a test/e2e database');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const owner = `tracking-test-${randomUUID()}`, other = `tracking-other-${randomUUID()}`;

describe('personal tracking and durable updates PostgreSQL', { skip: !databaseUrl }, () => {
  let pool: PostgresPool, store: PostgresStore, tracking: PersonalAgentTrackingService;
  before(async () => {
    pool = createPostgresPool(databaseUrl!, logger as any);
    store = new PostgresStore(pool, logger as any);
    await store.initializeSchema();
    for (const clientId of [owner, other]) {
      await store.createPasswordAccountForClient({ clientId, accountId: clientId, now: new Date().toISOString() });
      await store.ensurePersonalAgentProfile(clientId);
    }
    tracking = new PersonalAgentTrackingService(store as any, {} as any, { async destroy() {} }, logger as any);
  });
  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])', [[owner, other]]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[owner, other]]);
    await pool.end?.();
  });
  const fresh = async (id: string) => (await store.readPersonalAgentWatches(owner, { id })).watches[0];
  const create = async (condition = 'change', value = '') => {
    const saved = await tracking.create(owner, { title: 'Actual page', url: `https://example.org/${randomUUID()}`, condition, value });
    return fresh(saved.watch.id);
  };
  const acquire = async (watch: PersonalAgentWatch) => {
    const id = randomUUID();
    const lease = (await store.acquireCodeAgentRoomLease(watch.roomId, `browser-control:${id}`, 'tracking-test', new Date().toISOString(), 60000))!;
    assert.ok(lease);
    return { id, fence: lease.fence };
  };
  const finish = async (watch: PersonalAgentWatch, text?: string, error?: string) => {
    const control = await acquire(watch);
    try {
      return await store.finishPersonalAgentWatchCheck({ clientId: owner, id: watch.id, epoch: watch.epoch, checks: watch.checks,
        control, checkedAt: new Date().toISOString(), ...(text !== undefined ? { observation: { url: watch.url, title: 'Actual page', ...matchPersonalWatch(watch, text) } } : { error }) });
    } finally { await store.releaseCodeAgentRoomLease(watch.roomId, `browser-control:${control.id}`, 'tracking-test', control.fence); }
  };

  it('deduplicates concurrent creation without orphan rooms and keeps watches private', async () => {
    const body = { title: 'One page', url: `https://example.org/${randomUUID()}`, condition: 'contains', value: 'Available' };
    const saved = await Promise.all([tracking.create(owner, body), tracking.create(owner, body)]);
    assert.equal(saved[0].watch.id, saved[1].watch.id);
    const rooms = (await store.readPersonalAgentRooms(owner)).filter(room => room.name === body.title);
    assert.equal(rooms.length, 1); assert.equal(rooms[0].personalAgentThreadKind, 'watch');
    assert.equal(rooms[0].codeAgentMode, 'fullAccess'); assert.equal(rooms[0].codeAgentAccess, 'owner');
    assert.equal((await tracking.list(other)).total, 0);
    await assert.rejects(tracking.control(other, saved[0].watch.id, { action: 'pause', expectedUpdatedAt: saved[0].watch.updatedAt }), /not found/);
  });

  it('exposes a source monitor task in Activity and controls it without queuing model work',async()=>{
    const watch=await create();let wakes=0,interrupts=0;
    const tasks=new PersonalAgentTaskService(store as any,{create:()=>{throw Error('A monitor does not queue model work');},wake:async()=>{wakes++;},interrupt:async()=>{interrupts++;},tracking});
    const projected=(await tasks.list(owner)).tasks.find(room=>room.id===watch.roomId)!;
    assert.equal(projected.personalAgentTaskKind,'monitor');assert.equal(projected.personalAgentTaskStatus,'scheduled');
    const detail=await tasks.detail(owner,watch.roomId);assert.equal(detail.task?.kind,'monitor');assert.ok('watch' in detail && detail.watch?.id===watch.id);
    await assert.rejects(tasks.detail(other,watch.roomId),/not found/);
    await tasks.control(owner,watch.roomId,{action:'pause'});assert.equal((await tasks.detail(owner,watch.roomId)).room.personalAgentTaskStatus,'paused');
    await tasks.control(owner,watch.roomId,{action:'resume'});assert.equal((await tasks.detail(owner,watch.roomId)).room.personalAgentTaskStatus,'scheduled');
    await tasks.control(owner,watch.roomId,{action:'cancel'});assert.equal((await tasks.detail(owner,watch.roomId)).room.personalAgentTaskStatus,'cancelled');
    assert.equal((await store.readMessagesByRoom(watch.roomId)).length,0);assert.equal(wakes,0);assert.equal(interrupts,0);
    await assert.rejects(tasks.control(owner,watch.roomId,{action:'resume'}),/stopped monitor/);
  });

  it('commits baseline and real change exactly once under the browser lease', async () => {
    const watch = await create();
    const first = (await finish(watch, '  Actual   source\n$120 '))!;
    assert.equal(first.notification, undefined); assert.equal(first.watch.lastText, 'Actual source $120');
    const same = (await finish(first.watch, 'Actual source   $120'))!;
    assert.equal(same.notification, undefined);
    const control = await acquire(same.watch);
    const outcome = { clientId: owner, id: watch.id, epoch: same.watch.epoch, checks: same.watch.checks, control,
      checkedAt: new Date().toISOString(), observation: { url: watch.url, title: 'Actual source title', ...matchPersonalWatch(same.watch, 'Changed source $90') } };
    try {
      assert.equal(await store.finishPersonalAgentWatchCheck({ ...outcome, control: { ...control, fence: control.fence + 1 } }), null);
      const saved = (await store.finishPersonalAgentWatchCheck(outcome))!;
      assert.equal(saved.notification?.source?.excerpt, 'Changed source $90');
      assert.equal(saved.notification?.source?.title, 'Actual source title');
      assert.equal(await store.finishPersonalAgentWatchCheck(outcome), null);
      const read = (await store.markPersonalAgentNotificationRead(owner, saved.notification!.id))!;
      assert.equal(await store.markPersonalAgentNotificationRead(other, read.id), null);
      const restart = new PostgresStore(pool, logger as any);
      assert.equal((await restart.markPersonalAgentNotificationRead(owner, read.id))!.readAt, read.readAt);
      await tracking.remove(owner, watch.id);
      const retained = (await restart.readPersonalAgentNotification(owner, read.id))!;
      assert.equal(retained.watchId, undefined); assert.equal(retained.source?.url, watch.url);
    } finally { await store.releaseCodeAgentRoomLease(watch.roomId, `browser-control:${control.id}`, 'tracking-test', control.fence); }
  });

  it('alerts only on a contains/price transition and resets after the condition stops matching', async () => {
    for (const condition of ['contains', 'price_below']) {
      const watch = await create(condition, condition === 'contains' ? 'AVAILABLE' : '100');
      const positive = condition === 'contains' ? 'Now available' : 'Price USD 99.50';
      const negative = condition === 'contains' ? 'Sold out' : 'Price $100.00';
      const first = (await finish(watch, positive))!; assert.ok(first.notification);
      const repeated = (await finish(first.watch, positive))!; assert.equal(repeated.notification, undefined);
      const unmatched = (await finish(repeated.watch, negative))!; assert.equal(unmatched.watch.matched, false);
      assert.ok((await finish(unmatched.watch, positive))!.notification);
    }
    assert.equal(matchPersonalWatch({ condition: 'price_below', value: '1300', matched: false }, '$1,299.99').notify, true);
    assert.equal(matchPersonalWatch({ condition: 'price_below', value: '100', matched: false }, 'EUR 80').matched, false);
  });

  it('invalidates an in-flight check on pause/resume and backs off failed pages without corrupting the source', async () => {
    const baseline = (await finish(await create(), 'Confirmed source'))!.watch;
    const control = await acquire(baseline);
    const paused = (await store.controlPersonalAgentWatch(owner, baseline.id, 'pause', baseline.updatedAt))!;
    assert.equal(paused.status, 'paused'); assert.equal(paused.nextCheckAt, undefined);
    assert.equal((await store.readDuePersonalAgentWatches(100)).some(item => item.id === paused.id), false);
    assert.equal(await store.controlPersonalAgentWatch(owner, baseline.id, 'resume', baseline.updatedAt), null);
    const resumed = (await store.controlPersonalAgentWatch(owner, baseline.id, 'resume', paused.updatedAt))!;
    assert.equal(await store.finishPersonalAgentWatchCheck({ clientId: owner, id: baseline.id, epoch: baseline.epoch, checks: baseline.checks,
      control, checkedAt: new Date().toISOString(), error: 'Stale check' }), null);
    await store.releaseCodeAgentRoomLease(baseline.roomId, `browser-control:${control.id}`, 'tracking-test', control.fence);
    assert.equal((await store.readDuePersonalAgentWatches(100)).some(item => item.id === resumed.id), true);
    let current = resumed;
    for (let failures = 1; failures <= 5; failures++) {
      const failed = (await finish(current, undefined, 'Page returned HTTP 503'))!;
      assert.equal(failed.watch.lastText, 'Confirmed source'); assert.equal(failed.watch.failures, failures);
      assert.equal(Boolean(failed.notification), failures === 1 || failures === 5);
      if (failures < 5) assert.equal(Date.parse(failed.watch.nextCheckAt!) - Date.parse(failed.watch.lastCheckedAt!), 2 ** failures * 60000);
      current = failed.watch;
    }
    assert.equal(current.status, 'paused'); assert.equal(current.nextCheckAt, undefined);
    const restart = new PostgresStore(pool, logger as any);
    assert.equal((await restart.readPersonalAgentWatches(owner, { id: current.id })).watches[0].status, 'paused');
    const retry = (await restart.controlPersonalAgentWatch(owner, current.id, 'resume', current.updatedAt))!;
    assert.ok((await finish(retry, undefined, 'Another failure'))!.notification);
  });

  it('retains stopped tracking history and rejects further controls and stale observations',async()=>{
    const baseline=(await finish(await create(),'Confirmed original'))!.watch;
    const lease=await acquire(baseline);
    const stopped=(await store.controlPersonalAgentWatch(owner,baseline.id,'stop',baseline.updatedAt))!;
    assert.equal(stopped.status,'stopped');assert.equal(stopped.nextCheckAt,undefined);
    assert.equal((await new PostgresStore(pool,logger as any).readPersonalAgentWatches(owner,{id:baseline.id})).watches[0].lastText,'Confirmed original');
    assert.equal(await store.controlPersonalAgentWatch(owner,baseline.id,'resume',stopped.updatedAt),null);
    assert.equal(await store.finishPersonalAgentWatchCheck({clientId:owner,id:baseline.id,epoch:baseline.epoch,checks:baseline.checks,control:lease,checkedAt:new Date().toISOString(),error:'stale'}),null);
    await store.releaseCodeAgentRoomLease(baseline.roomId,`browser-control:${lease.id}`,'tracking-test',lease.fence);
    assert.equal((await store.readDuePersonalAgentWatches(100)).some(item=>item.id===baseline.id),false);
    const saved=await tracking.create(owner,{title:'Weekly check',url:`https://example.org/${randomUUID()}`,condition:'change',intervalMinutes:10080});
    assert.equal(saved.watch.intervalMinutes,10080);
  });

  it('stores task completion and its update atomically and preserves preference revisions', async () => {
    const room = await store.createPersonalAgentThread(owner, 'Actual completed task');
    const now = new Date().toISOString(), turnId = randomUUID(), messageId = randomUUID();
    const placeholder: Message = withAIStreamRecoveryMetadata({ id: messageId, roomId: room.id, clientId: 'ai_assistant', content: '', timestamp: now,
      messageType: 'ai', status: 'streaming', turnId }, 'tracking-stream-test');
    const started = await store.beginCodeAgentTurn({ roomId: room.id, turn: { id: turnId, roomId: room.id, status: 'running',
      startedAt: now, updatedAt: now, backend: 'codex-app-server', assistantName: 'Agent' }, placeholder, ownerId: 'tracking-terminal-test', now, leaseTtlMs: 60000 });
    assert.equal(started.outcome, 'started'); if (started.outcome !== 'started') return;
    const claim = { roomId: room.id, turnId, ownerId: started.lease.ownerId, fence: started.lease.fence };
    const finalId = messageId;
    const terminal = { claim, outcome: 'complete' as const, completedAt: new Date().toISOString(), finalMessageId: finalId,
      message: { ...placeholder, content: 'Actual finished response', status: 'complete' as const }, expectedMessageOwnership: { ownerId: 'tracking-stream-test', fence: 0 } };
    const original = (store as any).insertPersonalNotification;
    (store as any).insertPersonalNotification = async () => { throw new Error('Notification transaction failure'); };
    try { await assert.rejects(store.finishCodeAgentTurn(terminal), /Notification transaction failure/); }
    finally { (store as any).insertPersonalNotification = original; }
    assert.equal((await store.readRoomAgentTurns(room.id)).at(-1)!.status, 'running');
    assert.equal(await store.readPersonalAgentNotification(owner, `task:${finalId}`), null);
    assert.equal((await store.readMessagesByRoom(room.id)).find(message => message.id === messageId)!.status, 'streaming');
    assert.equal((await store.finishCodeAgentTurn(terminal)).outcome, 'applied');
    assert.equal((await store.readPersonalAgentNotification(owner, `task:${finalId}`))!.body, 'Actual finished response');
    assert.equal((await store.finishCodeAgentTurn(terminal)).outcome, 'stale');
    await store.releaseCodeAgentRoomLease(room.id, turnId, claim.ownerId, claim.fence);
    const profile = (await store.getPersonalAgentProfile(owner))!;
    const saved = (await store.updatePersonalAgentProfile(owner, { showUpdates: false, pushEnabled: false }, profile.updatedAt))!;
    assert.equal(saved.showUpdates, false); assert.equal(saved.pushEnabled, false);
    assert.equal(await store.updatePersonalAgentProfile(owner, { showUpdates: true }, profile.updatedAt), null);
    assert.equal((await new PostgresStore(pool, logger as any).getPersonalAgentProfile(owner))!.pushEnabled, false);
  });
});
