import type {Message} from './types';
export interface PersonalTaskStep {id:string;roomId?:string;loading:boolean;error?:string}
// Native Codex CLI receipts provide the saved task id for OpenMuse's TaskThreadCard.
export function readPersonalTaskSteps(messages:Message[]):PersonalTaskStep[]{
  const results=new Map(messages.filter(message=>message.messageType==='tool_result' && message.toolCallId).map(message=>[message.toolCallId!,message]));
  return messages.filter(message=>message.messageType==='tool_call' && typeof (message.toolArgs?.command ?? message.toolArgs?.cmd)==='string' && /\broomtalk\s+(?:task\s+(?:delegate|get|control)|watch\s+create)\b/.test(String(message.toolArgs?.command ?? message.toolArgs?.cmd))).map(call=>{
    const result=call.toolCallId?results.get(call.toolCallId):undefined,step:PersonalTaskStep={id:call.id,loading:!result};
    if(!result)return step;
    for(const line of (result.toolOutputPreview || result.content).split('\n')){
      if(!line.trim().startsWith('{'))continue;
      try{
        const receipt=JSON.parse(line);
        if(receipt.success===false && typeof receipt.error==='string'){step.error=receipt.error;break;}
        const roomId=receipt.tool==='PersonalTask'?receipt.room?.id:receipt.tool==='PersonalWatch'?receipt.watch?.roomId:undefined;
        if(typeof roomId==='string'){step.roomId=roomId;break;}
      }catch{/* Normal exec_command output also includes process summaries. */}
    }
    return step;
  });
}
