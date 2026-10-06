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

Ported from OpenMuse TaskCard and AgentActivityScreen in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import type {Room} from '../utils/types';
import {PersonalAgentGoogleActivity} from './PersonalAgentGoogleActivity';
export const personalTaskStatusKey=(room:Room)=>room.personalAgentTaskStatus==='scheduled'?'personalWatchActive':room.personalAgentTaskStatus==='paused'?'personalAgentPaused':room.personalAgentTaskStatus==='queued'?'personalTaskQueued':room.personalAgentTaskStatus==='waiting_input'?'personalTaskWaitingInput':room.personalAgentTaskStatus==='waiting_review'?'personalGoogleNeedsReview':room.personalAgentTaskStatus==='complete'?'personalTaskSucceeded':room.personalAgentTaskStatus==='cancelled'?'personalAgentStopped':room.personalAgentTaskStatus==='error'?'personalAgentTaskFailed':'personalAgentWorking';
const active=(room:Room)=>!['complete','error','cancelled'].includes(room.personalAgentTaskStatus || 'queued');
export const PersonalAgentTaskCard:React.FC<{room:Room;compact?:boolean;onOpen:()=>void}>=({room,compact,onOpen})=>{
  const {t}=useTranslation(),plan=room.personalAgentTaskPlan || [],done=plan.filter(step=>step.status==='completed').length,waiting=['waiting_input','waiting_review'].includes(room.personalAgentTaskStatus || '');
  return <button type="button" aria-label={t('personalTaskOpen',{title:room.name})} data-testid="personal-activity-room" data-room-id={room.id} className={`block w-full space-y-3 rounded-[22px] bg-[#f0f1f2] text-left dark:bg-[#292b2d] ${compact?'p-4':'p-5'}`} onClick={onOpen}>
    <span className="flex items-center gap-3"><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[#2784bc] ${waiting?'bg-[#f4dccd]':'bg-[#d7e9fa]'}`}><Icon icon="lucide:list-checks" className="h-5 w-5"/></span><span className="min-w-0 flex-1"><span className="block font-semibold">{room.name}</span><span className="mt-1 block text-xs text-default-500">{t(personalTaskStatusKey(room))}{plan.length>0 && ` · ${t('personalTaskStepProgress',{done,total:plan.length})}`}</span></span><Icon icon="lucide:chevron-right" className="shrink-0 text-default-400"/></span>
    {plan.length>0 && <span className="block h-1 overflow-hidden rounded-full bg-default-200"><span className="block h-full bg-[#6aaee0]" style={{width:`${Math.round(done/plan.length*100)}%`}}/></span>}
    {room.personalAgentTaskSummary && <span className={`block whitespace-pre-wrap text-sm text-default-500 ${compact?'line-clamp-2':'line-clamp-4'}`}>{room.personalAgentTaskSummary}</span>}
    {waiting && <span className="block text-xs font-semibold text-[#2784bc]">{t(room.personalAgentTaskStatus==='waiting_review'?'personalTaskReviewRequested':'personalTaskInputNeeded')}</span>}
  </button>;
};
export const PersonalAgentActivity:React.FC<{clientId:string;rooms:Room[];onTask:(id:string)=>void;showError:(message:string)=>void}>=({clientId,rooms,onTask,showError})=>{
  const {t}=useTranslation(),[filter,setFilter]=React.useState<'all'|'active'|'finished'>('all');
  const tasks=rooms.filter(room=>(room.personalAgentTaskKind || room.personalAgentGoalId) && (filter==='all' || (filter==='active'?active(room):!active(room)))).sort((a,b)=>(b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return <section className="space-y-5"><div className="flex gap-2">{(['all','active','finished'] as const).map(value=><Button key={value} size="sm" color={filter===value?'secondary':'default'} variant={filter===value?'flat':'light'} onPress={()=>setFilter(value)}>{t(`personalTaskFilter_${value}`)}</Button>)}</div>
    {tasks.map(room=><PersonalAgentTaskCard key={room.id} room={room} onOpen={()=>onTask(room.id)}/>)}
    {!tasks.length && <div className="space-y-2 py-8 text-center"><Icon icon="lucide:list-checks" className="mx-auto h-6 w-6 text-default-400"/><p className="font-medium">{t('personalTaskActivityEmpty')}</p><p className="text-sm text-default-500">{t('personalTaskActivityEmptyHint')}</p></div>}
    <h3 className="font-semibold">{t('personalTaskReviewsReceipts')}</h3><PersonalAgentGoogleActivity clientId={clientId} showError={showError}/>
  </section>;
};
