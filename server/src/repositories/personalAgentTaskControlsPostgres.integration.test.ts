import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createPostgresPool} from './postgresPool';
import {PostgresStore} from './postgresStore';
import {PersonalAgentScheduler} from '../services/personalAgentScheduler';
import {PersonalAgentTaskService} from '../services/personalAgentTasks';
const url=process.env.ROOM_EVENT_TEST_DATABASE_URL;
if(url && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1)))throw Error('Task controls require a test database');
const logger={info(){},warn(){},error(){},debug(){}};
test('source task controls persist pauses, preserve queued input, fence execution and cancel review',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`control-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    let wakes=0,interrupts=0;
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{wakes++;}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    const service=new PersonalAgentTaskService(store as any,{create:(clientId,roomId,content)=>scheduler.createQueuedMessage(clientId,roomId,content),wake:room=>scheduler.wakeTask(room),interrupt:async()=>{interrupts++;}});
    const {room}=await scheduler.delegate(owner,{kind:'plan',prompt:'Persist original task',input:{}});
    assert.equal((await store.readPersonalAgentRooms(owner)).find(item=>item.id===room.id)!.personalAgentTaskKind,'plan');
    const original=(await service.detail(owner,room.id)).messages[0];
    await service.control(owner,room.id,{action:'pause'});
    assert.equal((await new PostgresStore(pool,logger as any).getRoomById(room.id))!.personalAgentTaskControl,'paused');
    assert.equal(await store.claimNextCodeAgentQueuedMessage(room.id),null);
    assert.equal((await store.findRoomsWithQueuedCodeAgentMessages()).includes(room.id),false);
    assert.equal((await service.detail(owner,room.id)).room.personalAgentTaskStatus,'paused');
    await assert.rejects(service.control('another-owner',room.id,{action:'resume'}),/not found/);
    await service.control(owner,room.id,{action:'resume'});
    assert.equal((await service.detail(owner,room.id)).messages.length,1);
    assert.equal((await store.claimNextCodeAgentQueuedMessage(room.id))!.message.id,original.id);
    // Queue ownership acquired just before pause cannot start a model turn afterwards.
    await service.control(owner,room.id,{action:'pause'});
    const now=new Date().toISOString(),turnId=randomUUID();
    const started=await store.beginCodeAgentTurn({roomId:room.id,turn:{id:turnId,roomId:room.id,status:'running',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now},placeholder:{id:randomUUID(),roomId:room.id,clientId:'ai',content:'',timestamp:now,messageType:'ai',turnId,status:'streaming'},ownerId:'test-worker',now,leaseTtlMs:60000,queuedMessageId:original.id});
    assert.equal(started.outcome,'busy');
    await service.control(owner,room.id,{action:'resume'});
    await pool.query("UPDATE room_messages SET code_agent_queued_input=NULL WHERE room_id=$1",[room.id]);
    await store.upsertRoomAgentTurn({id:turnId,roomId:room.id,status:'complete',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now});
    await pool.query('UPDATE rooms SET code_agent_last_turn_id=$2 WHERE id=$1',[room.id,turnId]);
    await store.savePersonalGoogleRecord({clientId:owner,kind:'action',id:'review',data:{sourceRoomId:room.id,sourceTurnId:turnId,status:'awaiting_review'},updatedAt:now});
    assert.equal((await service.detail(owner,room.id)).room.personalAgentTaskStatus,'waiting_review');
    await service.control(owner,room.id,{action:'pause'});await service.control(owner,room.id,{action:'resume'});
    assert.equal((await service.detail(owner,room.id)).messages.length,1); // Review resumes without an extra model invocation.
    await service.control(owner,room.id,{action:'cancel'});
    assert.equal((await service.detail(owner,room.id)).room.personalAgentTaskStatus,'cancelled');
    assert.equal((await store.readPersonalGoogleRecords(owner,'action','review'))[0].data.status,'denied');
    await assert.rejects(service.control(owner,room.id,{action:'resume'}),/Only paused/);
    assert.equal(await store.claimNextCodeAgentQueuedMessage(room.id),null);assert.ok(wakes>=2);assert.ok(interrupts>=3);
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});
test('failed tasks retry once durably and refuse uncertain reviewed actions',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`retry-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    const room=await store.createPersonalAgentThread(owner,'Failed source task'),now=new Date().toISOString(),turnId=randomUUID();
    await store.upsertRoomAgentTurn({id:turnId,roomId:room.id,status:'error',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now});await pool.query('UPDATE rooms SET code_agent_last_turn_id=$2 WHERE id=$1',[room.id,turnId]);
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    const service=new PersonalAgentTaskService(store as any,{create:(clientId,roomId,content)=>scheduler.createQueuedMessage(clientId,roomId,content),wake:async()=>{}});
    await store.savePersonalGoogleRecord({clientId:owner,kind:'action',id:'uncertain',data:{sourceRoomId:room.id,sourceTurnId:turnId,status:'outcome_unknown'},updatedAt:now});
    await assert.rejects(service.control(owner,room.id,{action:'retry'}),/uncertain/);
    await pool.query("DELETE FROM personal_google_records WHERE client_id=$1",[owner]);
    const results=await Promise.allSettled([service.control(owner,room.id,{action:'retry'}),service.control(owner,room.id,{action:'retry'})]);
    assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
    assert.equal((await service.detail(owner,room.id)).messages.length,1);
    assert.equal((await service.detail(owner,room.id)).room.personalAgentTaskStatus,'queued');
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});
test('review outcomes recover into one durable task continuation and stay held while paused',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`review-continue-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    const room=await store.createPersonalAgentThread(owner,'Review result'),now=new Date().toISOString(),turnId=randomUUID();
    await store.upsertRoomAgentTurn({id:turnId,roomId:room.id,status:'complete',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now});
    // Backend Codex turn ids are deliberately different from durable RoomTalk turn ids.
    await pool.query('UPDATE rooms SET code_agent_last_turn_id=$2 WHERE id=$1',[room.id,'backend-turn-42']);
    const record={clientId:owner,kind:'action' as const,id:randomUUID(),data:{sourceRoomId:room.id,sourceTurnId:turnId,status:'succeeded',result:'Gmail sent message · actual-receipt'},updatedAt:now};
    await store.savePersonalGoogleRecord(record);
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    await pool.query("UPDATE rooms SET personal_agent_task_control='paused' WHERE id=$1",[room.id]);
    assert.equal((await store.readPersonalAgentReviewContinuations()).some(item=>item.id===record.id),false);
    await pool.query('UPDATE rooms SET personal_agent_task_control=NULL WHERE id=$1',[room.id]);
    const candidates=(await store.readPersonalAgentReviewContinuations()).filter(item=>item.id===record.id);assert.equal(candidates.length,1);
    const messages=Array.from({length:2},()=>scheduler.createQueuedMessage(owner,room.id,'Continue with actual reviewed receipt'));
    const saved=await Promise.all(messages.map(message=>store.continuePersonalAgentReview(candidates[0],message)));
    assert.equal(saved.filter(Boolean).length,1);
    assert.equal((await store.readMessagesByRoom(room.id)).length,1);
    await scheduler.tick();assert.equal((await store.readMessagesByRoom(room.id)).length,1);
    const persisted=(await store.readPersonalGoogleRecords(owner,'action',record.id))[0];assert.ok(persisted.data.taskContinuationMessageId);
    assert.equal((await store.readPersonalAgentRooms(owner)).find(item=>item.id===room.id)!.personalAgentTaskStatus,'queued');
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});
test('task outcomes publish the source input/review notification and append completed goal work once',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`outcome-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    for(const mode of ['input','review','fast-review','done'] as const){
      const room=await store.createPersonalAgentThread(owner,`Source ${mode}`),now=new Date().toISOString(),turnId=randomUUID(),messageId=randomUUID(),goalId=randomUUID();
      await store.savePersonalAgentGoal({id:goalId,clientId:owner,title:'Source outcome goal',category:'Personal',prompt:'',schedule:'manual',time:'09:00',timezone:'UTC',enabled:true,milestones:[],createdAt:now,updatedAt:now});
      await pool.query('UPDATE rooms SET personal_agent_goal_id=$2 WHERE id=$1',[room.id,goalId]);
      const placeholder={id:messageId,roomId:room.id,clientId:'ai_assistant',content:'',timestamp:now,messageType:'ai' as const,status:'streaming' as const,turnId,aiStreamOwnerId:'outcome-test',aiStreamFence:0};
      const started=await store.beginCodeAgentTurn({roomId:room.id,turn:{id:turnId,roomId:room.id,status:'running',startedAt:now,backend:'codex-app-server',assistantName:'Agent',updatedAt:now},placeholder,ownerId:'outcome-worker',now,leaseTtlMs:60000});
      assert.equal(started.outcome,'started');if(started.outcome!=='started')throw Error('Expected actual owner turn');
      if(mode==='input')assert.ok(await store.savePersonalAgentInputRequest({id:randomUUID(),clientId:owner,roomId:room.id,turnId,question:'Provide the missing confirmed name',fields:[],createdAt:now}));
      if(mode==='review' || mode==='fast-review')await store.savePersonalGoogleRecord({clientId:owner,kind:'action',id:randomUUID(),data:{sourceRoomId:room.id,sourceTurnId:turnId,status:mode==='fast-review'?'succeeded':'awaiting_review'},updatedAt:now});
      const terminal={claim:{roomId:room.id,turnId,ownerId:started.lease.ownerId,fence:started.lease.fence},outcome:'complete' as const,completedAt:new Date().toISOString(),finalMessageId:messageId,message:{...placeholder,content:'Persisted outcome',status:'complete' as const},expectedMessageOwnership:{ownerId:'outcome-test',fence:0}};
      assert.equal((await store.finishCodeAgentTurn(terminal)).outcome,'applied');
      const notice=(await store.readPersonalAgentNotification(owner,`task:${messageId}`))!;
      if(mode==='fast-review'){
        assert.equal(notice,null);
        assert.equal((await store.readPersonalAgentRooms(owner)).find(item=>item.id===room.id)!.personalAgentTaskStatus,'queued');
        assert.equal((await new PersonalAgentTaskService(store as any).detail(owner,room.id)).room.personalAgentTaskStatus,'queued');
      }else assert.equal(notice.kind,mode==='input'?'task_input':mode==='review'?'task_review':'task_complete');
      const saved=(await store.readPersonalAgentGoals(owner)).find(goal=>goal.id===goalId)!;
      assert.equal(saved.milestones?.length,mode==='done'?1:0);
      if(mode==='done')assert.deepEqual(saved.milestones,[{id:room.id,title:room.name,done:true}]);
      await store.finishCodeAgentTurn(terminal);
      assert.equal((await store.readPersonalAgentGoals(owner)).find(goal=>goal.id===goalId)!.milestones?.length,mode==='done'?1:0);
    }
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});
test('explicit resume preserves pending input after the native turn was interrupted, and review failures stay failed',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`paused-input-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    const room=await store.createPersonalAgentThread(owner,'Paused input'),now=new Date().toISOString(),turnId=randomUUID();
    const turn={id:turnId,roomId:room.id,status:'running' as const,startedAt:now,backend:'codex-app-server' as const,assistantName:'Agent',updatedAt:now};await store.upsertRoomAgentTurn(turn);
    await store.acquireCodeAgentRoomLease(room.id,turnId,'paused-input',now,60000);
    const request=(await store.savePersonalAgentInputRequest({id:randomUUID(),clientId:owner,roomId:room.id,turnId,question:'Provide the confirmed name',fields:[],createdAt:now}))!;assert.ok(request);
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    const service=new PersonalAgentTaskService(store as any,{create:(clientId,roomId,content)=>scheduler.createQueuedMessage(clientId,roomId,content),wake:async()=>{},interrupt:async()=>{await store.upsertRoomAgentTurn({...turn,status:'cancelled'});}});
    await service.control(owner,room.id,{action:'pause'});
    await assert.rejects(service.answer(owner,room.id,request.id,{text:'Confirmed'}),/Resume/);
    assert.equal(await store.savePersonalAgentInputRequest({id:randomUUID(),clientId:owner,roomId:room.id,turnId,question:'Late input',fields:[],createdAt:now}),null);
    await service.control(owner,room.id,{action:'resume'});
    assert.equal((await service.detail(owner,room.id)).room.personalAgentTaskStatus,'waiting_input');
    await service.answer(owner,room.id,request.id,{text:'Confirmed'});
    assert.equal((await store.readMessagesByRoom(room.id)).length,1);
    await service.control(owner,room.id,{action:'pause'}); // A resumed input task can be paused again.
    assert.equal((await store.getRoomById(room.id))!.personalAgentTaskControl,'paused');
    const failed=await store.createPersonalAgentThread(owner,'Failed review'),failedTurn=randomUUID();
    await store.upsertRoomAgentTurn({...turn,id:failedTurn,roomId:failed.id,status:'complete'});
    const action={clientId:owner,kind:'action' as const,id:randomUUID(),data:{sourceRoomId:failed.id,sourceTurnId:failedTurn,status:'denied'},updatedAt:now};await store.savePersonalGoogleRecord(action);
    assert.equal(await store.continuePersonalAgentReview(action,scheduler.createQueuedMessage(owner,failed.id,'Must not rerun a denied action')),null);
    assert.equal((await service.detail(owner,failed.id)).room.personalAgentTaskStatus,'error');
    assert.equal((await store.readMessagesByRoom(failed.id)).length,0);
    await assert.rejects(service.control(owner,failed.id,{action:'retry'}),/reviewed action/);
    assert.equal((await store.readPersonalAgentNotifications(owner)).notifications.find(item=>item.id===`review:${action.id}`)!.kind,'task_error');
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});

test('source goal pause holds its running work while goal completion preserves task states',{skip:!url},async()=>{
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any),owner=`goal-pause-${randomUUID()}`;
  try{
    await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(owner);
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    const tasks=new PersonalAgentTaskService(store as any,{create:(clientId,roomId,content)=>scheduler.createQueuedMessage(clientId,roomId,content),wake:async()=>{}});
    const now=new Date().toISOString(),goal=await store.savePersonalAgentGoal({id:randomUUID(),clientId:owner,title:'Original goal',prompt:'Source description',category:'Personal',schedule:'manual',time:'09:00',timezone:'UTC',enabled:true,milestones:[],createdAt:now,updatedAt:now});
    const delegated=await scheduler.delegate(owner,{kind:'plan',prompt:'Plan the original goal',goalId:goal.id,input:{}});
    await tasks.pauseGoal({...goal,enabled:false,completedAt:now});
    assert.equal((await tasks.detail(owner,delegated.room.id)).room.personalAgentTaskStatus,'queued');
    await tasks.pauseGoal({...goal,enabled:false});
    assert.equal((await tasks.detail(owner,delegated.room.id)).room.personalAgentTaskStatus,'paused');
    assert.equal(await store.claimNextCodeAgentQueuedMessage(delegated.room.id),null);
    await tasks.control(owner,delegated.room.id,{action:'resume'});
    assert.equal((await store.readMessagesByRoom(delegated.room.id)).length,1);
  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();}
});
