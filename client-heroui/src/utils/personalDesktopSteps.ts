import type {Message} from './types';

export interface PersonalDesktopStep {id:string;turnId?:string;receiptId?:string;action?:string;error?:string;loading:boolean}
// Codex invokes the CLI through exec_command. Its one-line receipt is preserved
// inside the normal tool output; image bytes are saved locally, never in history.
export function readPersonalDesktopSteps(messages:Message[]):PersonalDesktopStep[]{
  const results=new Map(messages.filter(message=>message.messageType==='tool_result' && message.toolCallId).map(message=>[message.toolCallId!,message]));
  return messages.filter(message=>message.messageType==='tool_call' && typeof (message.toolArgs?.command ?? message.toolArgs?.cmd)==='string' && /\broomtalk\s+computer\s+desktop\b/.test(String(message.toolArgs?.command ?? message.toolArgs?.cmd))).map(call=>{
    const result=call.toolCallId?results.get(call.toolCallId):undefined;
    const step:PersonalDesktopStep={id:call.id,turnId:call.turnId,loading:!result};
    if(!result)return step;
    for(const line of (result.toolOutputPreview || result.content).split('\n')){
      if(!line.trim().startsWith('{'))continue;
      try{
        const receipt=JSON.parse(line);
        if(receipt.tool==='PersonalComputer' && receipt.receipt){step.receiptId=receipt.receipt.id;step.action=receipt.receipt.command;break;}
        if(receipt.success===false && typeof receipt.error==='string'){step.error=receipt.error;break;}
      }catch{/* exec_command also includes non-JSON process output. */}
    }
    return step;
  });
}
