import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './postgresPool';
import { PostgresPool, PostgresStore } from './postgresStore';
import { PersonalAgentIdeaService } from '../services/personalAgentIdeas';
import { PersonalAgentScheduler } from '../services/personalAgentScheduler';
import { PersonalAgentGoal } from '../types';

const databaseUrl = process.env.ROOM_EVENT_TEST_DATABASE_URL;
if (databaseUrl && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1))) throw new Error('Suggestions require a dedicated test/e2e database');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const owner = `ideas-test-${randomUUID()}`, other = `ideas-other-${randomUUID()}`;
const now = new Date().toISOString();

describe('personal suggestions PostgreSQL transactions', { skip: !databaseUrl }, () => {
  let pool: PostgresPool, store: PostgresStore, ideas: PersonalAgentIdeaService, scheduler: PersonalAgentScheduler;
  before(async () => {
    pool = createPostgresPool(databaseUrl!, logger as any); store = new PostgresStore(pool, logger as any);
    await store.initializeSchema();
    for (const clientId of [owner, other]) {
      await store.createPasswordAccountForClient({ clientId, accountId: clientId, now });
      await store.ensurePersonalAgentProfile(clientId);
    }
    ideas = new PersonalAgentIdeaService(store as any);
    scheduler = new PersonalAgentScheduler(store as any, { async resumeQueuedTurns() {} }, logger as any, {
      selectedModel: { id: 'test', apiModel: 'test', provider: 'openai', label: 'Test', description: 'Test' }, mode: 'plan',
    });
  });
  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])', [[owner, other]]);
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])', [[owner, other]]);
    await pool.end?.();
  });
  const goal = (title: string, changes: Partial<PersonalAgentGoal> = {}) => store.savePersonalAgentGoal({
    id: randomUUID(), clientId: owner, title, prompt: `Prepare ${title}`, schedule: 'manual', time: '09:00', timezone: 'UTC',
    enabled: true, createdAt: now, updatedAt: now, ...changes,
  });
  const proposal = (sourceId: string, sourceKind = 'goal') => ideas.propose(owner, {
    sourceId, sourceKind, title: 'Useful next step', reason: 'Based on the saved source', prompt: 'Prepare a practical plan',
    source: { title: 'Fabricated source', excerpt: 'Fabricated evidence' }, clientId: other,
  });

  it('generates one real proposal across apps and preserves dismissal across restart', async () => {
    const saved = await goal('No steps');
    await goal('Already planned', { milestones: [{ id: 'step', title: 'Read sources', done: false }] });
    await goal('Paused', { enabled: false });
    await goal('Complete', { enabled: false, completedAt: now });
    const [first, second] = await Promise.all([ideas.refresh(owner), new PersonalAgentIdeaService(store as any).refresh(owner)]);
    assert.equal(first.ideas.length, 1); assert.equal(second.ideas[0].id, first.ideas[0].id);
    assert.equal(first.ideas[0].source.id, saved.id); assert.equal(first.ideas[0].source.excerpt, saved.prompt);
    await ideas.dismiss(owner, first.ideas[0].id, first.ideas[0].updatedAt);
    const restarted = new PersonalAgentIdeaService(new PostgresStore(pool, logger as any) as any);
    assert.equal((await restarted.refresh(owner)).ideas.length, 0);
    assert.equal((await restarted.list(owner, { status: 'dismissed' })).ideas.length, 1);
    assert.equal((await restarted.list(other, { status: 'all' })).ideas.length, 0);
  });

  it('concurrent acceptance creates one full-access task with the edited instructions', async () => {
    const saved = await goal('Accepted plan'); const idea = (await proposal(saved.id)).idea;
    const [a, b] = await Promise.all([scheduler.acceptIdea(owner, idea.id, 'My edited instructions', idea.updatedAt),
      scheduler.acceptIdea(owner, idea.id, 'Another edit', idea.updatedAt)]);
    assert.equal(a.room.id, b.room.id); assert.equal(a.idea.prompt, b.idea.prompt);
    assert.equal(a.room.personalAgentGoalId, saved.id); assert.equal(a.room.codeAgentMode, 'fullAccess');
    assert.equal(a.room.codeAgentBackend, 'codex-app-server');
    const messages = await store.readMessagesByRoom(a.room.id);
    assert.equal(messages.length, 1); assert.equal(messages[0].content, a.idea.prompt);
    assert.equal(messages[0].codeAgentQueuedInput?.requestedMode, 'fullAccess');
    assert.equal((await store.readPersonalAgentGoals(owner)).find(item => item.id === saved.id)!.lastRunRoomId, a.room.id);
    const replay = await scheduler.acceptIdea(owner, idea.id, 'Retry must not change the task', idea.updatedAt);
    assert.equal(replay.room.id, a.room.id); assert.equal(replay.idea.prompt, a.idea.prompt);
    assert.equal((await store.readPersonalAgentRooms(owner)).filter(room => room.personalAgentGoalId === saved.id).length, 1);
    assert.equal((await ideas.refresh(owner)).ideas.some(item => item.source.id === saved.id), false);
    await assert.rejects(scheduler.acceptIdea(other, idea.id, 'Foreign task', idea.updatedAt));
    await store.deleteRoom(a.room.id, owner);
    await assert.rejects(scheduler.acceptIdea(owner, idea.id, 'Deleted task', idea.updatedAt));
  });

  it('rejects obsolete sources and permits a new version without resurrecting a dismissed version', async () => {
    const saved = await goal('Versioned'); const original = (await proposal(saved.id)).idea;
    const updated = await store.savePersonalAgentGoal({ ...saved, prompt: 'A newly confirmed goal' }, saved.updatedAt);
    await assert.rejects(scheduler.acceptIdea(owner, original.id, 'Old plan', original.updatedAt));
    const fresh = (await ideas.refresh(owner)).ideas.find(item => item.source.id === saved.id)!;
    assert.notEqual(fresh.id, original.id); assert.equal(fresh.source.excerpt, updated.prompt);
    assert.equal((await ideas.list(owner, { status: 'dismissed' })).ideas.find(item => item.id === original.id)!.source.excerpt, saved.prompt);
    await store.deletePersonalAgentGoal(owner, saved.id, updated.updatedAt);
    await assert.rejects(scheduler.acceptIdea(owner, fresh.id, 'Missing source', fresh.updatedAt));
    assert.equal((await ideas.refresh(owner)).ideas.some(item => item.source.id === saved.id), false);
  });

  it('uses canonical memory evidence and fences writes to the actual active owner turn', async () => {
    const room = await store.createPersonalAgentThread(owner, 'Source chat');
    const memory = (await store.savePersonalAgentMemory({ id: randomUUID(), clientId: owner, kind: 'topic', title: 'Real topic',
      content: 'Actual decision', source: 'You', sourceRoomId: room.id, createdAt: now, updatedAt: now }))!;
    const turnId = randomUUID(), startedAt = new Date().toISOString();
    await store.upsertRoomAgentTurn({ id: turnId, roomId: room.id, status: 'running', startedAt,
      backend: 'codex-app-server', assistantName: 'Agent', updatedAt: startedAt });
    const lease = (await store.acquireCodeAgentRoomLease(room.id, turnId, 'idea-test', startedAt, 60000))!;
    const body = { sourceKind: 'memory', sourceId: memory.id, title: 'Follow up', reason: 'Confirmed decision', prompt: 'Read the actual topic', source: { excerpt: 'Forgery' } };
    await assert.rejects(ideas.propose(owner, body, { roomId: room.id, turnId: 'other-turn' }));
    await assert.rejects(ideas.propose(other, body));
    const idea = (await ideas.propose(owner, body, { roomId: room.id, turnId })).idea;
    assert.equal(idea.source.excerpt, memory.content); assert.equal(idea.source.title, memory.title); assert.equal(idea.source.roomId, room.id);
    const result = (await store.savePersonalAgentResult({ id: randomUUID(), clientId: owner, roomId: room.id, turnId,
      kind: 'plan', title: 'Actual plan', summary: 'Verified next steps', filename: 'plan.md', mimeType: 'text/markdown',
      byteSize: 32, objectKey: `idea-test/${room.id}/plan`, createdAt: startedAt }))!;
    const session = { id: randomUUID(), clientId: owner, roomId: room.id, title: 'Actual page', url: 'https://example.org/source', updatedAt: startedAt };
    const visit = { id: randomUUID(), clientId: owner, roomId: room.id, turnId, title: session.title, url: session.url,
      objectKey: `idea-test/${room.id}/page.jpg`, createdAt: startedAt };
    assert.equal(await store.savePersonalAgentBrowser(session, turnId, visit), true);
    const resultIdea = (await proposal(result.id, 'result')).idea, browserIdea = (await proposal(visit.id, 'browser')).idea;
    assert.equal(resultIdea.source.excerpt, result.summary); assert.equal(resultIdea.source.turnId, turnId);
    assert.equal(browserIdea.source.url, session.url); assert.equal(browserIdea.source.recordedAt, (await store.readPersonalAgentBrowserObservations(owner, { id: visit.id })).observations[0].createdAt);
    assert.equal(JSON.stringify(resultIdea.source).includes('objectKey'), false);
    assert.equal(await store.readPersonalAgentIdeaSource(other, 'browser', visit.id), null);
    await ideas.dismiss(owner, resultIdea.id, resultIdea.updatedAt); await ideas.dismiss(owner, browserIdea.id, browserIdea.updatedAt);
    await store.releaseCodeAgentRoomLease(room.id, turnId, 'idea-test', lease.fence);
    await assert.rejects(ideas.propose(owner, body, { roomId: room.id, turnId }));
    await ideas.dismiss(owner, idea.id, idea.updatedAt);
    assert.equal((await proposal(memory.id, 'memory')).idea.status, 'dismissed');
  });

  it('rolls back queue admission and leaves the suggestion retryable when message persistence fails', async () => {
    const saved = await goal('Atomic queue'); const idea = (await proposal(saved.id)).idea;
    // Trigger only this fixture's queue insert, leaving concurrent tests untouched.
    const functionName = `ideas_fail_${randomUUID().replace(/-/g, '')}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.client_id='${owner}' AND NEW.content='Fail this insert' THEN RAISE EXCEPTION 'fixture insert failed'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON room_messages FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    const before = (await store.readPersonalAgentRooms(owner)).length;
    try {
      await assert.rejects(scheduler.acceptIdea(owner, idea.id, 'Fail this insert', idea.updatedAt), /fixture insert failed/);
      assert.equal((await store.readPersonalAgentRooms(owner)).length, before);
      assert.equal((await ideas.list(owner, { id: idea.id })).ideas[0].status, 'new');
      assert.equal((await store.readPersonalAgentGoals(owner)).find(item => item.id === saved.id)!.lastRunRoomId, undefined);
    } finally {
      await pool.query(`DROP TRIGGER ${functionName} ON room_messages`); await pool.query(`DROP FUNCTION ${functionName}()`);
    }
    assert.equal((await scheduler.acceptIdea(owner, idea.id, 'Try again', idea.updatedAt)).idea.status, 'accepted');
  });
});
