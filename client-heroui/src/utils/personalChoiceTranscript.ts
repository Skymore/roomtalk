import type {Message} from './types';
import {parseJevResult} from './personalChoiceActions';
import type {JevToolResult} from '../../../server/src/services/personalChoices/domain';

export function isPersonalChoicesCall(message:Message):boolean {
  const command=message.toolArgs?.command ?? message.toolArgs?.cmd;
  return message.messageType==='tool_call' && (message.toolName==='present_choices' || (typeof command==='string' && /\broomtalk\s+choices\s+present\b/.test(command)));
}
export function personalChoiceResult(message:Message):JevToolResult|null {
  for(const line of message.content.split('\n')) {
    if(!line.trim().startsWith('{'))continue;
    try {
      const value=JSON.parse(line);
      if(value.tool==='PersonalChoices')return parseJevResult({panel:value.panel ?? null,...(value.error?{error:value.error}:{})});
      const result=parseJevResult(value);
      if(result)return result;
    }catch{/* Native exec_command includes process summaries around its JSON receipt. */}
  }
  return null;
}
/** Adapt the durable Codex transcript to the upstream AG-UI choice interaction contract. */
export function personalChoiceTranscript(messages:Message[]):unknown[] {
  const calls=new Set(messages.filter(isPersonalChoicesCall).map(message=>message.toolCallId));
  return messages.flatMap((message):unknown[]=>{
    if(message.messageType==='text')return [{role:'user',content:message.content}];
    if(message.messageType==='ai')return message.status==='error'?[]:[{role:'assistant',content:message.content}];
    if(isPersonalChoicesCall(message))return [{role:'assistant',toolCalls:[{id:message.toolCallId,name:'present_choices'}]}];
    if(message.messageType==='tool_result' && calls.has(message.toolCallId))return [{role:'tool',toolCallId:message.toolCallId,content:personalChoiceResult(message)}];
    return [];
  });
}
export function personalChoiceSteps(messages:Message[]) {
  const results=new Map(messages.filter(message=>message.messageType==='tool_result').map(message=>[message.toolCallId,message]));
  return messages.filter(isPersonalChoicesCall).map(call=>{
    const result=results.get(call.toolCallId);
    return {id:call.id,loading:!result,result:result?personalChoiceResult(result):null};
  });
}

export type PersonalChoiceSender=(text:string,retry?:boolean)=>Promise<void>;

/*
MIT License

Copyright (c) 2026 OpenMuse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Ported from CopilotKit/OpenMuse 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
*/
