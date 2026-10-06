import {describe,it,expect} from 'vitest';
import {readPersonalDesktopSteps} from './personalDesktopSteps';
import type {Message} from './types';
const message=(id:string,partial:Partial<Message>):Message=>({id,roomId:'task',clientId:'agent',timestamp:'2026-10-06T12:00:00Z',content:'',messageType:'tool_call',...partial});
describe('personal desktop receipts from Codex exec_command',()=>{
  it('pairs receipts by tool call and leaves an unfinished desktop operation loading',()=>{
    const calls=[message('first',{messageType:'tool_call',toolCallId:'call-1',turnId:'turn',toolArgs:{command:'roomtalk computer desktop --file /workspace/action.json --json'}}),message('second',{messageType:'tool_call',toolCallId:'call-2',toolArgs:{command:'roomtalk computer desktop --file /workspace/next.json --json'}}),message('terminal',{messageType:'tool_call',toolArgs:{command:'roomtalk computer run --command pwd --json'}})];
    const output=message('result',{messageType:'tool_result',toolCallId:'call-1',content:'Process exited with code 0\n{"success":true,"tool":"PersonalComputer","receipt":{"id":"receipt-1","command":"desktop: screenshot"},"screenshot":"/workspace/desktop.jpg"}\n'});
    expect(readPersonalDesktopSteps([...calls,output])).toEqual([{id:'first',turnId:'turn',loading:false,receiptId:'receipt-1',action:'desktop: screenshot'},{id:'second',turnId:undefined,loading:true}]);
  });
  it('shows the actual CLI error and does not interpret unrelated JSON as a desktop receipt',()=>{
    const call=message('call',{messageType:'tool_call',toolCallId:'tool',toolArgs:{command:'roomtalk computer desktop --file action.json --json'}});
    expect(readPersonalDesktopSteps([call,message('error',{messageType:'tool_result',toolCallId:'tool',content:'{"success":false,"error":"Computer is stopped","code":"room_context_request_failed"}'})])[0]).toMatchObject({loading:false,error:'Computer is stopped'});
    expect(readPersonalDesktopSteps([call,message('other',{messageType:'tool_result',toolCallId:'tool',content:'noise\n{"tool":"Other","receipt":{"id":"wrong"}}'})])[0].receiptId).toBeUndefined();
  });
});
