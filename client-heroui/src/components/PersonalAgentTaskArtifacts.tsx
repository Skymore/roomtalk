import {readPersonalInlineSteps} from '../utils/personalToolSteps';
import {PersonalSearchToolCard} from './PersonalInlineTools';
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

Ported from OpenMuse TaskThreadCard / FileThreadCard in thread-artifacts.tsx (73a7149).
*/
import React from 'react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import type {PersonalAgentFile,PersonalAgentTaskDetail,PersonalBrowserFrame} from '../utils/personalAgent';
import {PersonalAgentFiles} from './PersonalAgentFiles';
import {PersonalAgentBrowserSessionCard} from './PersonalAgentComputer';
import {PersonalAgentBrowserControl} from './PersonalAgentBrowser';
import {PersonalAgentResults} from './PersonalAgentResults';
export function PersonalAgentFileThreadCard({clientId,file}:{clientId:string;file:PersonalAgentFile}){
  const {t}=useTranslation(),[open,setOpen]=React.useState(false),[error,setError]=React.useState('');
  const showError=React.useCallback((message:string)=>setError(message),[]);
  return <><button type="button" aria-label={`${t('personalResultOpen')}: ${file.name}`} onClick={()=>setOpen(true)} className="w-full max-w-[440px] space-y-[18px] rounded-[22px] bg-content2 p-[18px] text-left" data-testid="personal-file-thread-card">
    <div className="space-y-[14px] rounded-xl bg-content1 p-[22px]"><h3 className="break-words text-lg font-semibold">{file.name.replace(/\.pdf$/i,'')}</h3>{file.fields.length?file.fields.slice(0,4).map(field=><div key={field.name} className="space-y-1 border-b border-default-200 pb-2"><p className="text-[9px] uppercase text-default-500">{field.name.replace(/_/g,' ')}</p><p className="break-words text-xs">{field.value || '—'}</p></div>):<p className="text-sm text-default-500">{t('personalFilesPages',{count:file.pageCount})}</p>}</div>
    <div className="flex items-center gap-[13px]"><span className="rounded-[9px] bg-[#fc2359] p-[9px] text-white"><Icon icon="lucide:file-text" width={23}/></span><div className="min-w-0 flex-1"><p className="break-words font-semibold">{file.name}</p><p className="text-sm text-default-500">{t('personalFilesPdf')}</p></div><Icon icon="lucide:chevron-right" width={18}/></div>
  </button>{error && <p role="alert" className="text-sm text-danger">{error}</p>}{open && <PersonalAgentFiles clientId={clientId} initialFileId={file.id} detailOnly onFileClose={()=>setOpen(false)} showError={showError}/>}</>;
}
export function PersonalAgentTaskArtifacts({clientId,detail,newestFileOnly=false,showResults=true}:{clientId:string;detail:PersonalAgentTaskDetail;newestFileOnly?:boolean;showResults?:boolean}){
  const [browser,setBrowser]=React.useState<PersonalBrowserFrame['session']>();
  const files=[...(detail.files || [])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return <div className="space-y-3">{readPersonalInlineSteps(detail.messages).filter(step=>step.kind==='search').map(step=><PersonalSearchToolCard key={step.id} step={step} active={detail.room.personalAgentTaskStatus==='running'}/>)}{detail.browsers?.map(session=><PersonalAgentBrowserSessionCard key={session.id} clientId={clientId} session={session} onOpen={()=>setBrowser(session)}/>)}{(newestFileOnly?files.slice(0,1):files).map(file=><PersonalAgentFileThreadCard key={file.id} clientId={clientId} file={file}/>)}{showResults && detail.turns.map(turn=><PersonalAgentResults key={turn.id} clientId={clientId} turn={turn} canInteract/>)}{browser && <PersonalAgentBrowserControl clientId={clientId} roomId={browser.roomId} isOpen onClose={()=>setBrowser(undefined)}/>}</div>;
}
