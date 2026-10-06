import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before,after,describe,it } from 'node:test';
import { createPostgresPool } from './postgresPool';
import { PostgresStore,PostgresPool } from './postgresStore';
import { PersonalAgentGoogleAuth } from '../services/personalAgentGoogleAuth';
import { PersonalAgentGoogleService } from '../services/personalAgentGoogle';
import { PersonalAgentFileService } from '../services/personalAgentFiles';

const url = process.env.ROOM_EVENT_TEST_DATABASE_URL;
if (url && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw Error('Google integration tests require a test database');
const logger = {info(){},warn(){},error(){},debug(){}};
const owner = `google-test-${randomUUID()}`,other = `google-other-${randomUUID()}`;
const config = {clientId:'test-client',clientSecret:'synthetic-client-secret',encryptionKey:'test-google-encryption-key',redirectUri:'http://127.0.0.1/api/personal-agent/google/callback'};
const scopes = ['gmail.readonly','gmail.send','calendar.events','calendar.events.readonly','calendar.calendarlist.readonly'].map(scope=>`https://www.googleapis.com/auth/${scope}`).join(' ');

describe('personal Google durable account and review flows',{skip:!url},()=>{
  let pool:PostgresPool,store:PostgresStore,auth:PersonalAgentGoogleAuth,service:PersonalAgentGoogleService;
  let onRequest: (request:Request)=>Promise<Response>;
  const requests:Request[] = [];
  const fetcher:typeof fetch = async(input,init)=>{
    const request = new Request(input,init);requests.push(request);
    return onRequest(request);
  };
  const event = {id:'event-1',etag:'"revision-1"',summary:'Reviewed event',start:{dateTime:'2026-10-10T09:00:00-07:00',timeZone:'America/Los_Angeles'},end:{dateTime:'2026-10-10T10:00:00-07:00'}};
  const defaultRequest = async (request:Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/token') return Response.json({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',expires_in:3600,scope:scopes});
    if (url.pathname.endsWith('/profile')) return Response.json({emailAddress:'owner@example.com'});
    if (url.pathname.endsWith('/revoke')) return new Response(null,{status:200});
    if (url.pathname.endsWith('/messages/send')) return Response.json({id:'sent-1',threadId:'thread-1'});
    if (url.pathname.endsWith('/events/event-1')) return Response.json(event);
    if (url.pathname.endsWith('/events') && request.method === 'POST') return Response.json({...event,id:'created-1'});
    throw Error(`Unexpected Google fixture request: ${url.pathname}`);
  };
  const connect = async () => {
    const result = await auth.connect(owner,true),state = new URL(result.url).searchParams.get('state')!;
    await auth.callback(state,'synthetic-code');return state;
  };
  before(async()=>{
    pool=createPostgresPool(url!,logger as any);store=new PostgresStore(pool,logger as any);await store.initializeSchema();
    for (const clientId of [owner,other]) {await store.createPasswordAccountForClient({clientId,accountId:clientId,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(clientId);}
    onRequest=defaultRequest;auth=new PersonalAgentGoogleAuth(store as any,config,fetcher);
    service=new PersonalAgentGoogleService(store as any,auth,new PersonalAgentFileService(store as any,{} as any,logger as any),fetcher);
  });
  after(async()=>{
    if (pool) {await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])',[[owner,other]]);await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[owner,other]]);await pool.end?.();}
  });
  it('stores PKCE state once, encrypts tokens, and keeps public connection metadata private',async()=>{
    const result = await auth.connect(owner,true),params = new URL(result.url).searchParams;
    assert.equal(params.get('code_challenge_method'),'S256');assert.equal(params.get('access_type'),'offline');
    const rows = await pool.query('SELECT * FROM personal_google_oauth_states WHERE id=$1',[params.get('state')]);
    assert.equal(rows.rows[0].client_id,owner);assert.ok(rows.rows[0].verifier);assert.notEqual(rows.rows[0].verifier,params.get('code_challenge'));
    await auth.callback(params.get('state')!,'synthetic-code');
    await assert.rejects(auth.callback(params.get('state')!,'same-code'),/expired/);
    const credential = await store.readPersonalGoogleCredential(owner);
    assert.equal(JSON.stringify(credential).includes('synthetic-access-token'),false);
    assert.equal(JSON.stringify(credential).includes('synthetic-refresh-token'),false);
    const status = await auth.status(owner);assert.equal(status.connected,true);assert.equal(status.canSend,true);assert.equal(status.account,'owner@example.com');
    assert.equal('accessToken' in status,false);assert.equal(await auth.tokens(other),null);
  });
  it('records the source task and prevents a cancelled task from executing its reviewed action',async()=>{
    onRequest=defaultRequest;await connect();
    const room=await store.createPersonalAgentThread(owner,'Source review');const turnId=randomUUID(),now=new Date().toISOString();
    await store.upsertRoomAgentTurn({id:turnId,roomId:room.id,status:'running',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now});
    const proposed=await service.propose(owner,{kind:'email.send',data:{to:['recipient@example.com'],subject:'Confirmed source task',body:'Actual proposed message'}},{roomId:room.id,turnId});
    assert.equal(proposed.action.sourceRoomId,room.id);assert.equal(proposed.action.sourceTurnId,turnId);
    await store.upsertRoomAgentTurn({id:turnId,roomId:room.id,status:'cancelled',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:new Date().toISOString()});
    const sent=requests.filter(item=>item.url.endsWith('/messages/send')).length;
    await assert.rejects(service.decide(owner,proposed.action.id,proposed.action.updatedAt,'approve'),/Cancelled tasks cannot execute/);
    assert.equal(requests.filter(item=>item.url.endsWith('/messages/send')).length,sent);
    assert.equal((await service.decide(owner,proposed.action.id,proposed.action.updatedAt,'deny')).action.status,'denied');
  });

  it('rejects an in-flight OAuth callback after disconnect instead of reviving the connection',async()=>{
    const result = await auth.connect(owner,true),state = new URL(result.url).searchParams.get('state')!;
    let entered!:()=>void,release!:()=>void;
    const tokenEntered = new Promise<void>(resolve=>{entered=resolve;}),barrier = new Promise<void>(resolve=>{release=resolve;});
    onRequest = async request=>{if(new URL(request.url).pathname === '/token'){entered();await barrier;}return defaultRequest(request);};
    const callback = auth.callback(state,'in-flight-code');const rejected = assert.rejects(callback,/disconnected during sign-in/);
    await tokenEntered;await auth.disconnect(owner);release();await rejected;
    assert.equal(await auth.tokens(owner),null);onRequest=defaultRequest;await connect();
  });
  it('persists drafts across service restarts and rejects a stale correction and a different owner',async()=>{
    const saved = await service.saveDraft(owner,{to:['recipient@example.com'],subject:'Actual private draft',body:'Draft text',attachmentIds:[]});
    const restarted = new PersonalAgentGoogleService(store as any,auth,{} as any,fetcher);
    assert.equal((await restarted.drafts(owner)).drafts[0].subject,'Actual private draft');
    const draft = saved.draft as Record<string,unknown>;
    const updated = await restarted.saveDraft(owner,{...draft,body:'Correction',expectedUpdatedAt:draft.updatedAt});
    assert.equal(updated.draft.body,'Correction');
    await assert.rejects(service.saveDraft(owner,{...draft,body:'Stale',expectedUpdatedAt:draft.updatedAt}),/changed/);
    assert.deepEqual((await service.drafts(other)).drafts,[]);
    await assert.rejects(service.saveDraft(other,{...draft,body:'Other owner'}),/not found/);
  });
  it('claims an exact review once and preserves the real API receipt across service restarts',async()=>{
    const proposed = await service.propose(owner,{kind:'email.send',data:{to:['recipient@example.com'],subject:'Reviewed test',body:'Exact body',attachmentIds:[]}});
    const before = requests.filter(request=>request.url.endsWith('/messages/send')).length;
    const decisions = await Promise.allSettled([
      service.decide(owner,proposed.action.id,proposed.action.updatedAt,'approve'),
      service.decide(owner,proposed.action.id,proposed.action.updatedAt,'approve'),
    ]);
    assert.equal(decisions.filter(result=>result.status === 'fulfilled').length,1);
    assert.equal(requests.filter(request=>request.url.endsWith('/messages/send')).length-before,1);
    const action = (await service.actions(owner)).actions.find(action=>action.id === proposed.action.id)!;
    assert.equal(action.status,'succeeded');assert.equal(action.result,'Gmail sent message · sent-1');
    assert.deepEqual((await service.actions(other)).actions,[]);
    const timeline=(await new PersonalAgentGoogleService(store as any,auth,{} as any,fetcher).activity(owner)).activity.filter(item=>item.actionId===proposed.action.id);
    assert.equal(timeline.length,3);
    assert.deepEqual(timeline.map(item=>item.status).sort(),['awaiting_review','executing','succeeded']);
    assert.ok(timeline.some(item=>item.detail==='Gmail sent message · sent-1'));
    assert.deepEqual((await service.activity(other)).activity,[]);
  });
  it('refuses a changed calendar version before dispatching the write and preserves unknown outcomes',async()=>{
    const proposed = await service.propose(owner,{kind:'calendar.update',data:{eventId:event.id,calendarId:'primary',title:'Update',start:'2026-10-10T09:00:00-07:00',end:'2026-10-10T10:00:00-07:00'}});
    assert.equal(proposed.action.targetVersion,event.etag);
    onRequest = async request=>request.url.endsWith('/events/event-1') ? Response.json({...event,etag:'"revision-2"'}) : defaultRequest(request);
    const before = requests.filter(request=>request.method === 'PATCH').length;
    const result = await service.decide(owner,proposed.action.id,proposed.action.updatedAt,'approve');
    assert.equal(result.action.status,'failed');assert.match(String(result.action.error),/changed/);assert.equal(requests.filter(request=>request.method === 'PATCH').length,before);
    onRequest = async request=>{if(request.method === 'POST' && new URL(request.url).pathname.endsWith('/events'))throw Error('lost response');return defaultRequest(request);};
    const unknown = await service.propose(owner,{kind:'calendar.create',data:{title:'Unknown outcome',start:'2026-10-10T09:00:00-07:00',end:'2026-10-10T10:00:00-07:00'}});
    const decided = await service.decide(owner,unknown.action.id,unknown.action.updatedAt,'approve');
    assert.equal(decided.action.status,'outcome_unknown');
    const count = requests.filter(request=>request.method === 'POST' && new URL(request.url).pathname.endsWith('/events')).length;
    await service.decide(owner,unknown.action.id,decided.action.updatedAt,'approve');
    assert.equal(requests.filter(request=>request.method === 'POST' && new URL(request.url).pathname.endsWith('/events')).length,count);
    onRequest=defaultRequest;
  });
});
