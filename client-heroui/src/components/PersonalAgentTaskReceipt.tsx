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

Ported from OpenMuse TaskThreadCard in thread-artifacts.tsx (73a7149).
*/
import React from 'react';
import {useTranslation} from 'react-i18next';
import {readPersonalAgentTask,answerPersonalAgentTaskInput} from '../utils/personalAgent';
import {Button} from '@heroui/react';
import type {PersonalAgentTaskDetail} from '../utils/personalAgent';
import {PersonalAgentTaskArtifacts} from './PersonalAgentTaskArtifacts';
import type {PersonalTaskStep} from '../utils/personalTaskSteps';
import {PersonalAgentTaskCard} from './PersonalAgentActivity';
import {PersonalAgentTaskDetailView} from './PersonalAgentTaskDetail';
export const PersonalAgentTaskReceipt:React.FC<{clientId:string;step:PersonalTaskStep}>=({clientId,step})=>{
  const {t}=useTranslation(),[detail,setDetail]=React.useState<PersonalAgentTaskDetail>(),[open,setOpen]=React.useState(false),[error,setError]=React.useState(''),[attempt,setAttempt]=React.useState(0);
  React.useEffect(()=>{
    if(!step.roomId)return;let live=true;
    const refresh=()=>void readPersonalAgentTask(clientId,step.roomId!).then(detail=>{if(live){setDetail(detail);setError('');}}).catch(error=>{if(live)setError(error.message);});
    refresh();const timer=window.setInterval(()=>{if(!document.hidden)refresh();},15000);return()=>{live=false;window.clearInterval(timer);};
  },[clientId,step.roomId,attempt]);
  return <div className="mx-auto w-full max-w-3xl space-y-3" data-testid="personal-task-receipt">{detail?<><PersonalAgentTaskCard room={detail.room} compact onOpen={()=>setOpen(true)}/><PersonalAgentTaskArtifacts clientId={clientId} detail={detail} newestFileOnly/></>:<div className="space-y-2 rounded-[22px] bg-content2 p-4"><p className="font-semibold">{t(step.loading?'personalSourceSavingTask':'personalTaskDetail')}</p>{(step.error || error) && <p role="alert" className="text-sm text-danger">{step.error || error}</p>}</div>}{error && <div><p role="alert" className="text-sm text-danger">{error}</p><Button size="sm" variant="light" onPress={()=>setAttempt(value=>value+1)}>{t('personalTaskReloadResults')}</Button></div>}{open && step.roomId && <PersonalAgentTaskDetailView clientId={clientId} roomId={step.roomId} isOpen onClose={()=>setOpen(false)} onSubmit={async(request,answer)=>{await answerPersonalAgentTaskInput(clientId,step.roomId!,request.id,answer);}}/>}</div>;
};
