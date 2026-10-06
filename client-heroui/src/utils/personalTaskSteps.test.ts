import {describe,it,expect} from 'vitest';
import {readPersonalTaskSteps} from './personalTaskSteps';
import type {Message} from './types';
const message=(id:string,partial:Partial<Message>):Message=>({id,roomId:'conversation',clientId:'agent',timestamp:'2026-10-06T12:00:00Z',content:'',messageType:'tool_call',...partial});
describe('personal native task receipts',()=>{
  it('pairs actual durable task and monitor ids across reordered native receipts',()=>{
    const calls=[message('task',{toolCallId:'delegate',toolArgs:{command:'roomtalk task delegate --file /workspace/task.json --json'}}),message('watch',{toolCallId:'watch',toolArgs:{command:'roomtalk watch create --file /workspace/watch.json --json'}}),message('pending',{toolCallId:'get',toolArgs:{command:'roomtalk task get --id existing --json'}}),message('other',{toolArgs:{cmd:'echo unrelated'}})];
    const results=[message('watch-result',{messageType:'tool_result',toolCallId:'watch',content:'Process exited with code 0\n{"success":true,"tool":"PersonalWatch","watch":{"roomId":"watch-room"}}'}),message('task-result',{messageType:'tool_result',toolCallId:'delegate',content:'{"success":true,"tool":"PersonalTask","room":{"id":"task-room"}}'})];
    expect(readPersonalTaskSteps([...calls,...results])).toEqual([{id:'task',roomId:'task-room',loading:false},{id:'watch',roomId:'watch-room',loading:false},{id:'pending',loading:true}]);
  });
  it('renders actual errors and never substitutes ids from unrelated tools',()=>{
    const call=message('call',{toolCallId:'call',toolArgs:{command:'roomtalk task control --id task --action pause --json'}});
    expect(readPersonalTaskSteps([call,message('error',{messageType:'tool_result',toolCallId:'call',content:'{"success":false,"error":"Task not found"}'})])[0]).toMatchObject({loading:false,error:'Task not found'});
    expect(readPersonalTaskSteps([call,message('wrong',{messageType:'tool_result',toolCallId:'call',content:'{"tool":"Other","room":{"id":"wrong"}}'})])[0].roomId).toBeUndefined();
  });
});
