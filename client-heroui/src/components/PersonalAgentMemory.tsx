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

Ported from OpenMuse AppsScreen memory section / MemoryRow (73a7149).
*/
import React from 'react';
import {Button,Textarea} from '@heroui/react';
import {useTranslation} from 'react-i18next';
import {forgetPersonalAgentMemory,readPersonalAgentMemories,savePersonalAgentMemory,type PersonalAgentMemory as Memory} from '../utils/personalAgent';
import {formatDate} from '../utils/formatters';
import type {Room} from '../utils/types';

interface MemoryMutation { (entry:Memory,content?:string):Promise<void> }
const MemoryRow:React.FC<{entry:Memory;mutate:MemoryMutation;busy:boolean}> = ({entry,mutate,busy}) => {
  const {t,i18n}=useTranslation(),[editing,setEditing]=React.useState(false),[text,setText]=React.useState(entry.content),[error,setError]=React.useState('');
  const act=async(forget:boolean)=>{setError('');try{await mutate(entry,forget ? undefined : text);setEditing(false);}catch(failure){setError(failure instanceof Error ? failure.message : String(failure));}};
  return <article className="space-y-2 border-b border-[#dedbd0] pb-4 dark:border-[#30302e]" data-testid="personal-memory-entry">
    {editing ? <Textarea label={t('personalAgentMemory')} value={text} onValueChange={setText} maxLength={8000} /> : <p className="whitespace-pre-wrap break-words text-sm leading-6">{entry.content}</p>}
    <p className="text-xs text-default-500">{entry.source} · {formatDate(entry.createdAt,i18n.language)}</p>
    <div className="flex gap-2">
      {editing ? <Button size="sm" variant="light" isLoading={busy} isDisabled={!text.trim()} onPress={()=>void act(false)}>{t('personalMemorySaveCorrection')}</Button> : <Button size="sm" variant="light" isDisabled={busy} onPress={()=>{setText(entry.content);setEditing(true);}}>{t('edit')}</Button>}
      <Button size="sm" variant="light" color="danger" isDisabled={busy} onPress={()=>void act(true)}>{t('personalMemoryForget')}</Button>
    </div>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </article>;
};
export const PersonalAgentMemory:React.FC<{clientId:string;rooms:Room[];onRoomSelect:(room:Room)=>void;showError:(message:string)=>void;showSuccess:(message:string)=>void}> = ({clientId,showError,showSuccess}) => {
  const {t}=useTranslation(),[entries,setEntries]=React.useState<Memory[]>([]),[total,setTotal]=React.useState(0),[text,setText]=React.useState(''),[busy,setBusy]=React.useState(false);
  const mounted=React.useRef(true);
  React.useEffect(()=>{mounted.current=true;void readPersonalAgentMemories(clientId).then(found=>{if(mounted.current){setEntries(found.memories);setTotal(found.total);}}).catch(failure=>{if(mounted.current)showError(failure.message);});return()=>{mounted.current=false;};},[clientId,showError]);
  const mutate=async(entry:Memory,content?:string)=>{
    if(busy)return;setBusy(true);
    try{
      if(content===undefined){await forgetPersonalAgentMemory(clientId,entry);setEntries(previous=>previous.filter(value=>value.id!==entry.id));setTotal(value=>value-1);showSuccess(t('personalMemoryForgotten'));}
      else{const saved=await savePersonalAgentMemory(clientId,{kind:entry.kind,title:entry.title,content},entry);setEntries(previous=>previous.map(value=>value.id===entry.id ? saved.memory : value));showSuccess(t('personalMemorySaved'));}
    }finally{setBusy(false);}
  };
  return <section className="space-y-4 rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-5 sm:p-6 dark:border-[#30302e] dark:bg-[#1d1d1b]" data-testid="personal-memory-library">
    <h3 className="text-base font-semibold">{t('personalAgentMemory')}</h3><p className="text-sm text-default-500">{t('personalMemoryInspect')}</p>
    {entries.map(entry=><MemoryRow key={entry.id} entry={entry} mutate={mutate} busy={busy} />)}
    {entries.length<total && <Button variant="light" isLoading={busy} onPress={()=>{setBusy(true);void readPersonalAgentMemories(clientId,'',entries.length).then(found=>{setEntries(previous=>[...previous,...found.memories]);setTotal(found.total);}).catch(failure=>showError(failure.message)).finally(()=>setBusy(false));}}>{t('loadMore')}</Button>}
    <Textarea label={t('personalMemoryRememberAboutMe')} value={text} onValueChange={setText} placeholder={t('personalMemoryExample')} maxLength={8000} />
    <Button size="sm" color="secondary" isLoading={busy} isDisabled={!text.trim()} onPress={()=>{
      const content=text.trim();setBusy(true);void savePersonalAgentMemory(clientId,{kind:'fact',title:content.split('\n')[0].slice(0,200),content})
        .then(saved=>{setEntries(previous=>[...previous,saved.memory]);setTotal(value=>value+1);setText('');showSuccess(t('personalMemorySaved'));})
        .catch(failure=>showError(failure.message)).finally(()=>setBusy(false));
    }}>{t('personalMemoryRemember')}</Button>
  </section>;
};
