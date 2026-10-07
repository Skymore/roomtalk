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
import {Icon} from '@iconify/react';
import {Spinner} from '@heroui/react';
import {useTranslation} from 'react-i18next';
import {z} from 'openmuse-zod';
import type {Message} from '../utils/types';
import type {PersonalInlineStep,PersonalWorkspaceOpener} from '../utils/personalToolSteps';
import {readPersonalInlineSteps} from '../utils/personalToolSteps';

const errorSchema=z.object({error:z.string()});
const mailSchema=z.object({id:z.string(),threadId:z.string(),sender:z.string(),from:z.string(),to:z.array(z.string()),subject:z.string(),body:z.string(),date:z.string(),unread:z.boolean(),label:z.string(),attachments:z.array(z.string())});
const threadSchema=z.object({messages:z.array(mailSchema),truncated:z.boolean()});
const mailSearchSchema=z.object({matches:z.array(z.object({id:z.string()})),truncated:z.boolean()});
const searchSchema=z.object({results:z.array(z.object({url:z.url({protocol:/^https?$/}),title:z.string().nullish()})),warnings:z.array(z.string()),truncated:z.boolean()});
const ErrorNotice=({error}:{error:string})=><p role="alert" className="rounded-[14px] bg-danger-50 p-4 text-sm text-danger-700">{error}</p>;
const actionClass='inline-flex min-h-[35px] items-center justify-center gap-2 rounded-3xl bg-content2 px-4 py-2 text-sm font-semibold text-foreground disabled:opacity-50';

// OpenMuse mail-tool-card.tsx, adapted from React Native to DOM with the same states and actions.
export function PersonalMailToolCard({step,active,open}:{step:PersonalInlineStep;active:boolean;open?:PersonalWorkspaceOpener}){
  const {t}=useTranslation(),failure=errorSchema.safeParse(step.result),search=step.kind==='mail-search';
  if(failure.success)return <ErrorNotice error={failure.data.error}/>;
  if(step.loading)return <div role="status" className="flex items-center gap-2.5 p-3.5 text-sm text-default-500">{active?<Spinner size="sm"/>:<Icon icon="lucide:mail" width={16}/>}<span>{t(!active?'personalToolMailPaused':search?'personalToolMailSearching':'personalToolMailReading')}</span></div>;
  if(search){
    const parsed=mailSearchSchema.safeParse(step.result);
    if(!parsed.success)return <ErrorNotice error={t('personalToolMailSearchUnreadable')}/>;
    return <div className="flex items-center gap-[9px] p-3 text-sm text-default-500"><Icon icon="lucide:search" width={16}/><span>{t(parsed.data.matches.length?'personalToolMailFound':'personalToolMailEmpty',{count:parsed.data.matches.length,atLeast:parsed.data.truncated?t('personalToolAtLeast'):''})}</span></div>;
  }
  const parsed=threadSchema.safeParse(step.result);
  if(!parsed.success)return <ErrorNotice error={t('personalToolMailUnreadable')}/>;
  const message=parsed.data.messages.at(-1);
  if(!message)return <p className="text-sm text-default-500">{t('personalToolThreadEmpty')}</p>;
  return <div className="w-full max-w-[440px] space-y-3.5 rounded-[23px] bg-content2 p-[18px]" data-testid="personal-mail-tool-card">
    <div className="flex items-center gap-2.5"><span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[13px] bg-secondary/15 text-secondary"><Icon icon="lucide:mail" width={20}/></span><div className="min-w-0"><p className="break-words text-[15px] font-semibold">{message.sender}</p><p className="text-[11px] text-default-500">{t('personalToolMailMessages',{count:parsed.data.messages.length})}</p></div></div>
    <h3 className="break-words text-base font-semibold">{message.subject}</h3><p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-[21px] text-default-500">{message.body}</p>
    {parsed.data.truncated && <p className="text-[11px] text-default-500">{t('personalToolMailExcerpt')}</p>}
    <button type="button" className={actionClass} disabled={!open} onClick={()=>open?.('mail',message)}><Icon icon="lucide:mail" width={16}/>{t('personalToolOpenMail')}</button>
  </div>;
}
// OpenMuse search-tool-card.tsx: deduplicated real URLs, honest stopped/error/empty/truncated states.
export function PersonalSearchToolCard({step,active}:{step:PersonalInlineStep;active:boolean}){
  const {t}=useTranslation(),failure=errorSchema.safeParse(step.result),parsed=searchSchema.safeParse(step.result);
  const error=failure.success?failure.data.error:!step.loading && !parsed.success?t('personalToolSearchUnreadable'):'';
  const sources=parsed.success?[...new Map(parsed.data.results.map(source=>[source.url,source])).values()]:[];
  return <div className="w-full max-w-[440px] space-y-2.5 rounded-[23px] bg-content2 p-3.5" data-testid="personal-search-tool-card">
    <div className="flex items-center gap-2.5 text-[15px]">{step.loading && active?<Spinner size="sm"/>:<Icon icon="lucide:search" width={18} className="text-secondary"/>}<span>{t(error?'personalToolSearchFailed':step.loading?active?'personalToolSearching':'personalToolSearchStopped':sources.length?'personalToolSourcesFound':'personalToolSourcesEmpty',{count:sources.length})}</span></div>
    {!step.loading && parsed.success && <>{sources.map(source=><a key={source.url} className="block break-words text-[15px] leading-[23px] text-foreground underline" href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a>)}{parsed.data.truncated && <p className="text-[11px] text-default-500">{t('personalToolSearchTruncated')}</p>}{[...new Set(parsed.data.warnings)].map(warning=><p key={warning} className="break-words text-[11px] text-default-500">{warning}</p>)}</>}
    {error && <ErrorNotice error={error}/>}
  </div>;
}
// OpenMuse chat.tsx ServerToolCard; saved task threads use PersonalAgentTaskReceipt.
export function PersonalServerToolCard({step,open}:{step:PersonalInlineStep;open?:PersonalWorkspaceOpener}){
  const {t}=useTranslation(),failure=errorSchema.safeParse(step.result);
  const label=t(step.kind==='goal'?'personalAgentGoals':step.kind==='memory'?'personalAgentMemory':'personalToolAgentProgress');
  const tab=step.kind==='goal'?'goals':step.kind==='memory'?'memory':'activity';
  return <div className="w-full space-y-2.5 rounded-[23px] bg-content1 p-4" data-testid="personal-server-tool-card"><h3 className="text-base font-semibold">{step.loading?t('personalToolSaving',{name:label}):label}</h3>
    {failure.success?<ErrorNotice error={failure.data.error}/>:<p className="text-sm text-default-500">{t(step.loading?'personalToolServerWaiting':'personalToolSavedResult')}</p>}
    <button type="button" className={actionClass} disabled={!open} onClick={()=>open?.(tab)}>{t('personalToolView',{name:label})}</button>
  </div>;
}
export function PersonalInlineTools({messages,active,open}:{messages:Message[];active:boolean;open?:PersonalWorkspaceOpener}){
  const steps=readPersonalInlineSteps(messages);
  if(!steps.length)return null;
  return <div className="space-y-3">{steps.map(step=>{
    if(step.kind==='mail-search' || step.kind==='mail-thread')return <PersonalMailToolCard key={step.id} step={step} active={active} open={open}/>;
    if(step.kind==='search')return <PersonalSearchToolCard key={step.id} step={step} active={active}/>;
    return <PersonalServerToolCard key={step.id} step={step} open={open}/>;
  })}</div>;
}
