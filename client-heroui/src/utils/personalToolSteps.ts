import type {Message} from './types';
import type {PersonalMail} from './personalAgent';
export type PersonalWorkspaceTarget='mail'|'goals'|'memory'|'activity';
export type PersonalWorkspaceOpener=(tab:PersonalWorkspaceTarget,mail?:PersonalMail)=>void;
export type PersonalInlineKind='mail-search'|'mail-thread'|'search'|'goal'|'memory'|'status';
export interface PersonalInlineStep {id:string;kind:PersonalInlineKind;loading:boolean;result:unknown;savedToFile?:boolean}
const sourceKinds:Record<string,PersonalInlineKind>={search_mail:'mail-search',read_mail_thread:'mail-thread',search_web:'search',create_goal:'goal',remember_fact:'memory',agent_status:'status'};
export function personalToolReceipt(message:Message):unknown {
  // Full durable output is necessary: the workspace preview can stop before the JSON receipt.
  for(const line of message.content.split('\n')){
    if(!line.trim().startsWith('{'))continue;
    try{return JSON.parse(line);}catch{/* Native command output contains process headers. */}
  }
  return null;
}
export function readPersonalInlineSteps(messages:Message[]):PersonalInlineStep[]{
  const results=new Map(messages.filter(message=>message.messageType==='tool_result' && message.toolCallId).map(message=>[message.toolCallId,message]));
  return messages.flatMap(call=>{
    if(call.messageType!=='tool_call')return [];
    let kind=sourceKinds[call.toolName || ''];
    const command=call.toolArgs?.command ?? call.toolArgs?.cmd;
    if(!kind && typeof command==='string'){
      if(/\broomtalk\s+google\s+mail\b/.test(command))kind='mail-search';
      else if(/\broomtalk\s+google\s+thread\b/.test(command))kind='mail-thread';
      else if(/\broomtalk\s+search\s+web\b/.test(command))kind='search';
      else if(/\broomtalk\s+goal\s+(?:create|update|run)\b/.test(command))kind='goal';
      else if(/\broomtalk\s+memory\s+(?:save|set|merge|forget)\b/.test(command))kind='memory';
      else if(/\broomtalk\s+task\s+list\b/.test(command))kind='status';
    }
    if(!kind)return [];
    const result=call.toolCallId?results.get(call.toolCallId):undefined;
    const savedToFile=kind==='search' && typeof command==='string' && /--json\s*>{1,2}\s*\S/.test(command) && result?.exitCode===0 && !result.isError && !result.content.trim();
    return [{id:call.id,kind,loading:!result,result:result?personalToolReceipt(result):null,savedToFile}];
  });
}
