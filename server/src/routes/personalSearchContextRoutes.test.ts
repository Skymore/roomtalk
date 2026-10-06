import assert from 'node:assert/strict';
import express from 'express';
import {test} from 'node:test';
import {AddressInfo} from 'node:net';
import {CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {registerPersonalSearchContextRoutes} from './personalSearchContextRoutes';
import {SearchService} from '../services/personalSearch';
import {Store} from '../services/personalComputer/store';
import {searchFixture,searchSource} from '../services/personalSearchFixture.test';

test('personal search uses the real MCP transport and fences the owner, turn, pause and disabled state',async t=>{
  const {requests}=await searchFixture(t);
  let active=true,paused=false;
  const records=new Map<string,Record<string,unknown>>();
  const rooms={getRoomMember:async()=>null,getRoomById:async()=>({id:'thread',creatorId:'owner',personalAgentOwnerId:'owner',type:'codeAgent',codeAgentAccess:'owner',...(paused?{personalAgentTaskControl:'paused'}:{})}),hasActiveCodeAgentRoomLease:async()=>active,
    readPersonalComputerRecords:async(_owner:string,_kind:string,id:string)=>records.has(id)?[{data:records.get(id)}]:[],putPersonalComputerRecord:async(_owner:string,_kind:string,id:string,data:Record<string,unknown>)=>{records.set(id,data);return {data};}} as any;
  const context=new CodeAgentRoomContextService(rooms,{tokenSecret:'search-test-secret'});
  const app=express();app.use(express.json());
  const options={store:rooms,roomContext:context,search:new SearchService(new Store(rooms)) as SearchService|undefined,logger:{error(){}} as any};
  registerPersonalSearchContextRoutes(app,options);
  const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-agent/room-context/personal-search`;
  const send=(clientId='owner',input:unknown={objective:'Find public research',search_queries:['public research']})=>fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${context.issueTurnToken({roomId:'thread',clientId,turnId:'turn',mode:'fullAccess'})}`},body:JSON.stringify(input)});
  assert.equal((await fetch(url,{method:'PATCH'})).status,401);
  assert.equal((await send('other')).status,403);
  assert.equal((await send('owner',{objective:'x',search_queries:[]})).status,422);
  assert.equal(requests.length,0);
  const response=await send();assert.equal(response.status,200);
  assert.deepEqual((await response.json() as any).results,[searchSource]);
  const count=requests.length;
  paused=true;assert.equal((await send()).status,409);paused=false;
  active=false;assert.equal((await send()).status,403);active=true;
  options.search=undefined;assert.equal((await send()).status,503);
  assert.equal(requests.length,count);
});
