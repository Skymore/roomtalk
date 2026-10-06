import assert from 'node:assert/strict';
import express from 'express';
import {test} from 'node:test';
import {AddressInfo} from 'node:net';
import {CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {registerPersonalChoiceContextRoutes} from './personalChoiceContextRoutes';
import {JevService} from '../services/personalChoices/service';
import {Store} from '../services/personalComputer/store';
import {presentChoicesTool} from '../services/personalChoices/tools';
import {encodeJevAction} from '../services/personalChoices/domain';

function fixture() {
  let active=true,paused=false;
  const records=new Map<string,Record<string,unknown>>();
  const key=(owner:string,kind:string,id:string)=>JSON.stringify([owner,kind,id]);
  const rooms={
    getRoomMember:async()=>null,
    getRoomById:async()=>({id:'thread',creatorId:'owner',personalAgentOwnerId:'owner',type:'codeAgent',codeAgentAccess:'owner',...(paused?{personalAgentTaskControl:'paused'}:{})}),
    hasActiveCodeAgentRoomLease:async()=>active,
    readPersonalComputerRecords:async(owner:string,kind:string,id?:string)=>[...records.entries()].filter(([value])=>{const parts=JSON.parse(value);return parts[0]===owner && parts[1]===kind && (!id || parts[2]===id);}).map(([,data])=>({id:String(data.id),data:structuredClone(data)})),
    putPersonalComputerRecord:async(owner:string,kind:string,id:string,data:Record<string,unknown>,insertOnly:boolean)=>{const k=key(owner,kind,id);if(insertOnly && records.has(k))return null;records.set(k,structuredClone(data));return {id,data:structuredClone(data)};},
    patchPersonalComputerRecord:async(owner:string,kind:string,id:string,expected:Record<string,unknown>,patch:Record<string,unknown>)=>{const k=key(owner,kind,id),data=records.get(k);if(!data || Object.entries(expected).some(([field,value])=>data[field]!==value))return null;const updated={...data,...patch};records.set(k,updated);return {id,data:structuredClone(updated)};},
  } as any;
  let evaluatedUser='';
  const choices=new JevService({store:new Store(rooms),mode:'live',adapter:{decide:async input=>{evaluatedUser=input.userMessage;return {control:input.allowedControls[0],scores:Object.fromEntries(input.options.map(option=>[option.id,1]))};}}});
  const context=new CodeAgentRoomContextService(rooms,{tokenSecret:'choice-test-secret'});
  return {rooms,choices,context,pause:()=>{paused=true;},end:()=>{active=false;},user:()=>evaluatedUser};
}
const input={message:'Agent summary',context:'Read evidence',title:'Next step',control:'clarification',options:[{id:'plan',label:'Plan',details:[],sources:[]},{id:'research',label:'Research',details:[],sources:[]}]};

test('choices broker binds actual user context, enforces owner/turn/mode/pause and continues a saved selection',async()=>{
  const f=fixture();
  await f.choices.beginTurn('owner','thread','turn','Help me plan');
  const app=express();app.use(express.json());
  registerPersonalChoiceContextRoutes(app,{store:f.rooms,roomContext:f.context,choices:f.choices,logger:{error(){}} as any});
  const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-agent/room-context/personal-choices`;
  const send=(data:unknown=input,clientId='owner',mode:'plan'|'fullAccess'='fullAccess')=>fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.context.issueTurnToken({roomId:'thread',clientId,turnId:'turn',mode})}`},body:JSON.stringify(data)});
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await send(input,'other')).status,403);
    assert.equal((await send(input,'owner','plan')).status,403);
    assert.equal((await send({...input,userMessage:'Forged user context'})).status,422);
    const response=await send();assert.equal(response.status,200);
    const {panel}=await response.json() as any;assert.equal(panel.threadId,'thread');assert.equal(panel.turnId,'turn');assert.equal(f.user(),'Help me plan');
    const action={panelId:panel.id,threadId:'thread',candidateSetVersion:panel.candidateSetVersion,optionId:'plan'};
    assert.match(await f.choices.beginTurn('owner','thread','next-turn',encodeJevAction(action)),/I choose “Plan”/);
    assert.match(await f.choices.beginTurn('owner','thread','retry-turn',encodeJevAction(action)),/I choose “Plan”/);
    await assert.rejects(f.choices.beginTurn('owner','thread','conflict',encodeJevAction({...action,optionId:'research'})),/different choice/);
    await f.choices.beginTurn('owner','thread','new-question','A new request');
    await assert.rejects(f.choices.select('owner','thread',action),/superseded/);
    f.pause();assert.equal((await send()).status,409);
    f.end();assert.equal((await send()).status,403);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('live comparisons require actual source text and email evidence from the same turn',async()=>{
  const f=fixture();await f.choices.beginTurn('owner','thread','turn','Compare real places');
  const tool=presentChoicesTool(f.choices,'owner','thread','turn',new AbortController().signal,'live','Compare real places');
  const comparison={...input,control:'comparison' as const,options:[{id:'a',label:'Kelp Forest',details:['Ocean habitat'],sources:[{title:'Kelp',url:'https://example.org/kelp'}]}]};
  assert.match((await tool.execute(comparison)).error!,/Read the source page/);
  await f.choices.noteEvidence('owner','thread','earlier-turn','web','https://example.org/kelp','Kelp Forest. Ocean habitat.');
  assert.match((await tool.execute(comparison)).error!,/Read the source page/);
  await f.choices.noteEvidence('owner','thread','turn','web','https://example.org/kelp','Kelp Forest. Ocean habitat.');
  assert.match((await tool.execute({...comparison,options:[{...comparison.options[0],details:['Invented fact']}]})).error!,/not present/);
  assert.match((await tool.execute({...comparison,mailThreadId:'mail-thread'})).error!,/Read the referenced email/);
  await f.choices.noteEvidence('owner','thread','turn','mail','mail-thread');
  const prepared=await tool.execute({...comparison,mailThreadId:'mail-thread'});assert.ok(prepared.panel);assert.equal(prepared.panel.mode,'live');
});
