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

Ported from OpenMuse DelegateSheet in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button,Modal,ModalBody,ModalContent,ModalHeader,Textarea} from '@heroui/react';
import {useTranslation} from 'react-i18next';
import {delegatePersonalAgentTask,personalGoogleRequest,type PersonalMail} from '../utils/personalAgent';
import type {Room} from '../utils/types';
export const PersonalAgentDelegate:React.FC<{clientId:string;isOpen:boolean;onClose:()=>void;onTask:(room:Room)=>void}> = ({clientId,isOpen,onClose,onTask})=>{
  const {t}=useTranslation();
  const [kind,setKind]=React.useState<'plan'|'document'|'finance'|'agent'>('plan');
  const [prompt,setPrompt]=React.useState(''),[messageId,setMessageId]=React.useState(''),[csv,setCsv]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  const [mail,setMail]=React.useState<PersonalMail[]>([]);
  React.useEffect(()=>{if(!isOpen || kind!=='document')return;let live=true;setError('');void personalGoogleRequest<{connected:boolean}>(clientId,'/google').then(async status=>{if(status.connected){return personalGoogleRequest<{mail:PersonalMail[]}>(clientId,'/mail');}return {mail:[]};}).then(result=>{if(live)setMail(result.mail);}).catch(failure=>{if(live)setError(failure.message);});return()=>{live=false;};},[clientId,isOpen,kind]);
  const submit=async()=>{setBusy(true);setError('');try{const {room}=await delegatePersonalAgentTask(clientId,{kind,prompt:prompt.trim(),input:kind==='finance'?{csv}:kind==='document'?{messageId}:{}});onTask(room);onClose();setPrompt('');setCsv('');setMessageId('');}catch(failure){setError(failure instanceof Error?failure.message:String(failure));}finally{setBusy(false);}};
  return <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside" classNames={{base:'max-h-[90dvh] bg-white dark:bg-[#252522]'}}><ModalContent className="personal-agent-theme"><ModalHeader className="flex-col"><h2>{t('personalDelegateTitle')}</h2><p className="mt-2 text-xs font-normal text-default-500">{t('personalDelegateSubtitle')}</p></ModalHeader><ModalBody><div className="space-y-4 pb-6">
    <div className="flex flex-wrap gap-2">{(['plan','document','finance','agent'] as const).map(item=><Button key={item} size="sm" variant={kind===item?'flat':'light'} color={kind===item?'secondary':'default'} aria-pressed={kind===item} onPress={()=>setKind(item)}>{t(`personalDelegateKind_${item}`)}</Button>)}</div>
    <Textarea variant="bordered" labelPlacement="outside" label={t('personalDelegatePrompt')} value={prompt} onValueChange={setPrompt} placeholder={t(`personalDelegatePlaceholder_${kind}`)} minRows={4} maxLength={16000}/>
    {kind==='document' && <section className="space-y-3"><h3 className="text-sm font-semibold">{t('personalDelegateChooseMail')}</h3>{mail.filter(message=>message.attachments.length).map(message=><button key={message.id} type="button" role="radio" aria-checked={message.id===messageId} className="flex w-full items-center gap-3 rounded-xl bg-default-50 p-3 text-left text-sm" onClick={()=>setMessageId(message.id)}><span>{message.id===messageId?'●':'○'}</span><span>{message.subject} · {message.sender}</span></button>)}{!mail.some(message=>message.attachments.length) && <p className="text-sm text-default-500">{t('personalDelegateNoMail')}</p>}</section>}
    {kind==='finance' && <><Textarea variant="bordered" labelPlacement="outside" label={t('personalDelegateCSV')} value={csv} onValueChange={setCsv} minRows={7} maxLength={500000} placeholder={'date,description,amount,category\n2026-09-01,Groceries,54.20,Food'}/><p className="text-xs text-default-500">{t('personalDelegateCSVHint')}</p></>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button color="secondary" isLoading={busy} isDisabled={!prompt.trim() || (kind==='document'&&!messageId) || (kind==='finance'&&!csv.trim())} onPress={()=>void submit()}>{t('personalDelegateTask')}</Button>
  </div></ModalBody></ModalContent></Modal>;
};
