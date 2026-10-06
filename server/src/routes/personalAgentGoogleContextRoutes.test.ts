import assert from 'node:assert/strict';
import express from 'express';
import {test} from 'node:test';
import {AddressInfo} from 'node:net';
import {CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {registerPersonalAgentGoogleContextRoutes} from './personalAgentGoogleContextRoutes';

test('conversation mail tools keep upstream bounded summaries, full thread excerpts and actual mail evidence',async t=>{
  const mail=Array.from({length:25},(_,i)=>({id:`message-${i}`,threadId:'thread',sender:'Sender',from:'sender@example.org',to:['owner@example.org'],subject:'Subject',date:'2026-10-06T10:00:00Z',body:'x'.repeat(13000),unread:true,label:'Inbox',attachments:[]}));
  const rooms={getRoomMember:async()=>null,getRoomById:async()=>({id:'room',creatorId:'owner',personalAgentOwnerId:'owner',type:'codeAgent',codeAgentAccess:'owner'}),hasActiveCodeAgentRoomLease:async()=>true} as any;
  const context=new CodeAgentRoomContextService(rooms,{tokenSecret:'mail-context-test'}),evidence:unknown[][]=[];
  const app=express();registerPersonalAgentGoogleContextRoutes(app,{store:rooms,roomContext:context,google:{mail:async()=>({mail}),thread:async()=>({mail})} as any,choices:{noteEvidence:async(...args:unknown[])=>{evidence.push(args);}} as any,logger:{error(){}} as any});
  const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/code-agent/room-context/personal-google`;
  const headers={Authorization:`Bearer ${context.issueTurnToken({roomId:'room',clientId:'owner',turnId:'turn',mode:'fullAccess'})}`};
  const searched=await(await fetch(`${url}?operation=mail&query=Subject`,{headers})).json() as any;
  assert.equal(searched.matches.length,20);assert.equal(searched.matches[0].snippet.length,240);assert.equal(searched.matches[0].body,undefined);assert.equal(searched.truncated,true);assert.deepEqual(evidence,[]);
  const read=await(await fetch(`${url}?operation=thread&id=thread`,{headers})).json() as any;
  assert.equal(read.messages.length,20);assert.equal(read.messages[0].id,'message-5');assert.equal(read.messages.at(-1).id,'message-24');assert.equal(read.messages[0].body.length,12000);assert.equal(read.truncated,true);assert.deepEqual(evidence,[['owner','room','turn','mail','thread']]);
});
