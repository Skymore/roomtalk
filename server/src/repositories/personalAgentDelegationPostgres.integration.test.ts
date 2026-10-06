import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import express from 'express';
import {registerPersonalAgentTaskContextRoutes} from '../routes/personalAgentTaskContextRoutes';
import {PersonalAgentTaskService,PERSONAL_TASK_API_PATH} from '../services/personalAgentTasks';
import {createPostgresPool} from './postgresPool';
import {PostgresStore} from './postgresStore';
import {PersonalAgentScheduler} from '../services/personalAgentScheduler';
const url=process.env.ROOM_EVENT_TEST_DATABASE_URL;
if(url && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1)))throw Error('Delegation requires a test database');
test('delegate retains complete task inputs and queued work after executor wake fails',{skip:!url},async()=>{
  const logger={info(){},warn(){},error(){},debug(){}};
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any);
  const owner=`delegate-${randomUUID()}`,other=`delegate-other-${randomUUID()}`;
  try{
    await store.initializeSchema();for(const clientId of [owner,other]){await store.createPasswordAccountForClient({clientId,accountId:clientId,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(clientId);}
    const options={selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai' as const,label:'GPT',description:''}};
    const csv='date,description,amount\n'+Array.from({length:1000},(_,index)=>`2026-10-01,Confirmed row ${index},${index}\n`).join('');
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{throw Error('Stopped worker');}},logger as any,options);
    const saved=await scheduler.delegate(owner,{kind:'finance',prompt:'Analyze this complete CSV',input:{csv}});
    const task=(await store.readPersonalAgentTask(owner,saved.room.id))!;
    assert.equal(task.input.csv,csv);assert.equal(await store.readPersonalAgentTask(other,saved.room.id),null);
    const messages=(await store.readMessagePageByRoom(saved.room.id,{limit:100})).messages;
    assert.equal(messages.length,1);assert.equal(messages[0].codeAgentQueuedInput?.state,'queued');assert.equal(messages[0].codeAgentQueuedInput?.requestedMode,'fullAccess');
    assert.match(messages[0].content,/roomtalk task get/);assert.equal(messages[0].content.includes('Confirmed row 999'),false);
    let wakes=0;await new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{wakes++;}},logger as any,options).tick();
    assert.equal(wakes,1);assert.equal((await store.readPersonalAgentRooms(owner)).filter(room=>room.personalAgentThreadKind==='task').length,1);
    const goal=await store.savePersonalAgentGoal({id:randomUUID(),clientId:owner,title:'Source goal',prompt:'',category:'Health',schedule:'manual',time:'09:00',timezone:'UTC',enabled:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const planned=await scheduler.delegate(owner,{kind:'plan',title:'Plan: Source goal',prompt:'Create a practical plan for this goal: Source goal. ',goalId:goal.id,input:{}});
    assert.equal(planned.room.personalAgentGoalId,goal.id);assert.equal(planned.room.name,'Plan: Source goal');
    assert.equal((await new PostgresStore(pool,logger as any).readPersonalAgentGoals(owner)).find(item=>item.id===goal.id)!.category,'Health');
    const count=(await store.readPersonalAgentRooms(other)).length;
    await assert.rejects(scheduler.delegate(other,{kind:'plan',prompt:'Unowned goal',goalId:goal.id,input:{}}),/Goal not found/);
    assert.equal((await store.readPersonalAgentRooms(other)).length,count);

  }finally{await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])',[[owner,other]]);await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[owner,other]]);await pool.end?.();}
});

test('native private task API delegates complete inputs and enforces owner, mode and turn boundaries',{skip:!url},async()=>{
  const logger={info(){},warn(){},error(){},debug(){}},pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any);
  const owner=`native-delegate-${randomUUID()}`,other=`native-other-${randomUUID()}`;
  let server:import('node:http').Server|undefined;
  try{
    await store.initializeSchema();
    for(const clientId of [owner,other]){await store.createPasswordAccountForClient({clientId,accountId:clientId,now:new Date().toISOString()});await store.ensurePersonalAgentProfile(clientId);}
    const profile=(await store.getPersonalAgentProfile(owner))!,foreign=(await store.getPersonalAgentProfile(other))!,turnId=randomUUID();
    await store.acquireCodeAgentRoomLease(profile.mainRoomId,turnId,'native-delegate-test',new Date().toISOString(),60000);
    const claims={clientId:owner,roomId:profile.mainRoomId,turnId,mode:'fullAccess'};
    const scheduler=new PersonalAgentScheduler(store as any,{resumeQueuedTurns:async()=>{}},logger as any,{selectedModel:{id:'gpt-5',apiModel:'gpt-5',provider:'openai',label:'GPT',description:''}});
    const tasks=new PersonalAgentTaskService(store as any,{create:(clientId,roomId,content)=>scheduler.createQueuedMessage(clientId,roomId,content),wake:async()=>{},delegate:(clientId,input)=>scheduler.delegate(clientId,input)});
    const app=express();app.use(express.json());
    registerPersonalAgentTaskContextRoutes(app,{store:store as any,roomContext:{verifyTurnToken:()=>claims,assertAccess:async()=>{}} as any,tasks,logger:logger as any});
    server=await new Promise<import('node:http').Server>(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
    const address=server.address() as import('node:net').AddressInfo,base=`http://127.0.0.1:${address.port}${PERSONAL_TASK_API_PATH}`;
    const call=(body:object)=>fetch(base,{method:'PATCH',headers:{authorization:'Bearer scoped-test','content-type':'application/json'},body:JSON.stringify(body)});
    const csv='date,description,amount,category\n'+Array.from({length:1000},(_,index)=>`2026-10-01,Actual imported row ${index},${index+1},Actual expenses\n`).join('');
    const admitted=await call({operation:'delegate',clientId:other,data:{kind:'finance',prompt:'Use all imported rows',input:{csv}}});assert.equal(admitted.status,201);
    const room=(await admitted.json() as {room:{id:string;creatorId:string}}).room;assert.equal(room.creatorId,owner);
    assert.equal((await store.readPersonalAgentTask(owner,room.id))!.input.csv,csv);
    assert.equal((await store.readPersonalAgentTask(other,room.id)),null);
    const listed=await fetch(`${base}?operation=list`,{headers:{authorization:'Bearer scoped-test'}});assert.equal(listed.status,200);assert.equal((await listed.json() as {tasks:{id:string}[]}).tasks.filter(item=>item.id===room.id).length,1);
    assert.equal((await call({operation:'control',id:room.id,action:'pause'})).status,200);
    assert.equal((await tasks.detail(owner,room.id)).room.personalAgentTaskStatus,'paused');
    assert.equal((await call({operation:'control',id:room.id,action:'resume'})).status,200);
    assert.equal((await store.readMessagesByRoom(room.id)).length,1);
    assert.equal((await fetch(`${base}?operation=get&id=${foreign.mainRoomId}`,{headers:{authorization:'Bearer scoped-test'}})).status,404);
    assert.equal((await call({operation:'control',id:foreign.mainRoomId,action:'cancel'})).status,404);
    assert.equal((await call({operation:'delegate',data:{prompt:'x'.repeat(12001)}})).status,422);
    assert.equal((await call({operation:'delegate',data:{title:'x'.repeat(161),prompt:'Actual request'}})).status,422);
    assert.equal((await call({operation:'delegate',data:{kind:'finance',prompt:'Analyze',input:{csv:'invented'}}})).status,400);
    claims.mode='plan';assert.equal((await call({operation:'delegate',data:{prompt:'Read only cannot delegate'}})).status,403);claims.mode='fullAccess';
    await pool.query("UPDATE rooms SET personal_agent_task_control='paused' WHERE id=$1",[profile.mainRoomId]);
    assert.equal((await call({operation:'delegate',data:{prompt:'Paused source cannot delegate'}})).status,409);
    await pool.query('UPDATE rooms SET personal_agent_task_control=NULL WHERE id=$1',[profile.mainRoomId]);
    claims.clientId=other;assert.equal((await call({operation:'delegate',data:{prompt:'Wrong owner'}})).status,403);claims.clientId=owner;
    claims.turnId=randomUUID();assert.equal((await call({operation:'delegate',data:{prompt:'Ended turn'}})).status,403);
  }finally{
    if(server)await new Promise<void>(resolve=>{server!.close(()=>resolve());server!.closeAllConnections();});
    await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])',[[owner,other]]);await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[[owner,other]]);await pool.end?.();
  }
});
