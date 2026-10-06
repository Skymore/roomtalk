import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {PersonalAgentTaskService} from './personalAgentTasks';
import {PersonalAgentInputRequest,Message} from '../types';
function fixture(){
  const requests:PersonalAgentInputRequest[]=[],source={clientId:'owner',roomId:'task',turnId:'turn'};let active=true;
  const service=new PersonalAgentTaskService({
    getRoomById:async()=>({id:'task',creatorId:'owner',personalAgentOwnerId:'owner'}),
    readPersonalAgentBrowserObservations:async()=>({observations:[],total:0}),
    readPersonalAgentWatches:async()=>({watches:[],total:0}),
    readPersonalGoogleRecords:async()=>[],readRoomAgentTurns:async()=>[],readMessagePageByRoom:async()=>({messages:[],hasMore:false}),
    readPersonalAgentFiles:async(owner:string)=>({files:owner==='owner' ? [{id:'pdf',fields:[{name:'Name',type:'text'},{name:'Confirm',type:'checkbox'},{name:'Dropdown',type:'unsupported'}]}] : []}),
    savePersonalAgentInputRequest:async(input:PersonalAgentInputRequest)=>{if(!active)return null;requests.push(input);return input;},
    readPersonalAgentInputRequests:async(owner:string)=>owner==='owner' ? requests : [],
    answerPersonalAgentInputRequest:async(_owner:string,id:string,answer:PersonalAgentInputRequest['answer'])=>{const row=requests.find(row=>row.id===id)!;row.answer=answer;row.answeredAt=new Date().toISOString();return row;},
  } as any,{create:(clientId,roomId,content)=>({id:'answer',clientId,roomId,content,messageType:'text',timestamp:new Date().toISOString(),codeAgentQueuedInput:{state:'queued'}} as Message),wake:async()=>{}});return {service,source,requests,end(){active=false;}};
}
describe('durable task input requests',()=>{
  it('uses only supported fields from the actual owner PDF and retains typed answers',async()=>{
    const {service,source}=fixture();const saved=await service.request(source,{question:'What should I fill?',fileId:'pdf',fields:['Name','Confirm']});
    assert.equal(saved.status,'waiting_input');assert.equal('clientId' in saved.request,false);
    assert.deepEqual(saved.request.fields,[{name:'Name',type:'text'},{name:'Confirm',type:'checkbox'}]);
    await assert.rejects(service.answer('owner','task',saved.request.id,{fields:{Name:'User',Confirm:'true'}}),/Confirm/);
    const answered=await service.answer('owner','task',saved.request.id,{fields:{Name:'User',Confirm:true}});
    assert.ok(answered.request.answeredAt);assert.deepEqual(answered.request.answer,{text:'',fields:{Name:'User',Confirm:true}});
    assert.deepEqual((await service.detail('owner','task')).requests[0].answer,answered.request.answer);
    const repeated=await service.answer('owner','task',saved.request.id,{fields:{Name:'Different',Confirm:false}});
    assert.deepEqual(repeated.request.answer,answered.request.answer);
  });
  it('rejects foreign ownership, invented fields and ended turns',async()=>{
    const {service,source,end}=fixture();
    await assert.rejects(service.request({...source,clientId:'other'},{question:'Read secret'}),/not found/);
    await assert.rejects(service.request(source,{question:'Fill',fileId:'pdf',fields:['Invented']}),/actual PDF/);
    await assert.rejects(service.request(source,{question:'Fill',fileId:'pdf',fields:['Dropdown']}),/actual PDF/);
    const request=await service.request(source,{question:'Which date?'});
    await assert.rejects(service.answer('owner','task',request.request.id,{}),/answer/);
    await assert.rejects(service.answer('other','task',request.request.id,{text:'foreign'}),/not found/);
    end();await assert.rejects(service.request(source,{question:'Too late'}),/ended/);
  });
});
