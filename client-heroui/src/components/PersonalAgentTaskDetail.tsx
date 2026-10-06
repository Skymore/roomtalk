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

Ported from OpenMuse TaskDetail in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button,Checkbox,Input,Modal,ModalBody,ModalContent,ModalHeader,Textarea} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {controlPersonalAgentTask,readPersonalAgentTask,type PersonalAgentInputRequest,type PersonalAgentTaskDetail} from '../utils/personalAgent';
import {PersonalAgentGoogleReview} from './PersonalAgentGoogleReview';
import type {PersonalGoogleAction} from '../utils/personalAgent';
import {PersonalAgentTaskArtifacts} from './PersonalAgentTaskArtifacts';
import {PersonalAgentResults} from './PersonalAgentResults';
import {PersonalAgentBrowserVisits} from './PersonalAgentBrowser';
import type {RoomAgentTurn} from '../utils/types';
interface SubmitInput { (request:PersonalAgentInputRequest,answer:NonNullable<PersonalAgentInputRequest['answer']>):Promise<void> }
const InputRequest:React.FC<{request:PersonalAgentInputRequest;onSubmit:SubmitInput}> = ({request,onSubmit}) => {
  const {t}=useTranslation(),[values,setValues]=React.useState<Record<string,string|boolean>>(()=>Object.fromEntries(request.fields.map(field=>[field.name,field.type === 'checkbox' ? false : '']))),[text,setText]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  return <form className="space-y-3 rounded-2xl bg-[#e7eff5] p-4 dark:bg-[#29323b]" onSubmit={event=>{event.preventDefault();setBusy(true);setError('');void onSubmit(request,{text,fields:values}).catch(failure=>setError(failure.message)).finally(()=>setBusy(false));}}>
    <h3 className="text-sm font-semibold">{request.question}</h3>
    {request.fields.map(function(field){if(field.type==='checkbox') { return <Checkbox key={field.name} isSelected={values[field.name] === true} onValueChange={value=>setValues(previous=>({...previous,[field.name]:value}))}>{field.name}</Checkbox>;
      }
      return <Input key={field.name} label={field.name} isRequired value={String(values[field.name] ?? '')} onValueChange={value=>setValues(previous=>({...previous,[field.name]:value}))} />;})}
    {!request.fields.length && <Textarea label={t('personalTaskAnswer')} value={text} onValueChange={setText} isRequired />}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Button type="submit" color="secondary" size="sm" isLoading={busy}>{t('personalTaskContinue')}</Button>
  </form>;
};
const turnStatus=(turn:RoomAgentTurn) => turn.status==='running' ? 'personalAgentWorking' : turn.status==='complete' ? 'personalTaskSucceeded' : turn.status==='cancelled' ? 'personalAgentStopped' : 'personalAgentTaskFailed';
export const PersonalAgentTaskDetailView:React.FC<{clientId:string;roomId:string;isOpen:boolean;onClose:()=>void;onSubmit:SubmitInput}> = ({clientId,roomId,isOpen,onClose,onSubmit}) => {
  const {t}=useTranslation(),[detail,setDetail]=React.useState<PersonalAgentTaskDetail>(),[error,setError]=React.useState('');
  const [review,setReview]=React.useState<PersonalGoogleAction>();
  const [busy,setBusy]=React.useState(false);
  const [olderMessages,setOlderMessages]=React.useState<PersonalAgentTaskDetail['messages']>([]);
  const [hasMoreOlder,setHasMoreOlder]=React.useState<boolean>();
  const [loadingMore,setLoadingMore]=React.useState(false);
  React.useEffect(()=>{if(!isOpen){setOlderMessages([]);setHasMoreOlder(undefined);}},[isOpen,roomId]);
  const load=React.useCallback(async()=>{const value=await readPersonalAgentTask(clientId,roomId);setDetail(value);setError('');},[clientId,roomId]);
  React.useEffect(()=>{if(!isOpen)return;let live=true;const refresh=()=>{void readPersonalAgentTask(clientId,roomId).then(value=>{if(live){setDetail(value);setError('');}}).catch(failure=>{if(live)setError(failure.message);});};refresh();const timer=window.setInterval(()=>{if(!document.hidden)refresh();},5000);return()=>{live=false;window.clearInterval(timer);};},[clientId,roomId,isOpen]);
  const messages=[...olderMessages,...(detail?.messages || [])].filter((message,index,all)=>all.findIndex(item=>item.id===message.id)===index);
  const latestPlan=messages.filter(message=>message.toolName==='update_plan' && Array.isArray(message.toolArgs?.plan)).at(-1)?.toolArgs?.plan as {step:string;status:string}[]|undefined;
  const status=detail?.room.personalAgentTaskStatus;
  const cancelled=status==='cancelled',paused=status==='paused';
  const act=(action:'pause'|'resume'|'retry'|'cancel')=>{setBusy(true);setError('');void controlPersonalAgentTask(clientId,roomId,action).then(()=>load()).catch(failure=>setError(failure.message)).finally(()=>setBusy(false));};
  const requests=status!=='waiting_input'?[]:detail?.requests.filter(request=>!request.answeredAt) || [];
  return <><Modal isOpen={isOpen && !review} onClose={onClose} scrollBehavior="inside" size="3xl" classNames={{base:'max-h-[90dvh] bg-white dark:bg-[#252522]'}}><ModalContent className="personal-agent-theme"><ModalHeader>{detail?.room.name || t('personalTaskDetail')}</ModalHeader><ModalBody><div className="space-y-5 pb-6">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {detail && <><p className="text-xs text-default-500">{t(status==='scheduled'?'personalWatchActive':status==='paused'?'personalAgentPaused':status==='queued'?'personalTaskQueued':status==='waiting_input'?'personalTaskWaitingInput':status==='waiting_review'?'personalGoogleNeedsReview':status==='complete'?'personalTaskSucceeded':status==='error'?'personalAgentTaskFailed':status==='cancelled'?'personalAgentStopped':'personalAgentWorking')}</p><p className="whitespace-pre-wrap text-sm">{detail.task?.prompt || messages.find(message=>message.messageType==='text')?.content}</p>
      <div className="flex flex-wrap gap-2">
        {status && ['scheduled','queued','running','waiting_input','waiting_review'].includes(status) && <Button size="sm" variant="flat" isDisabled={busy} onPress={()=>act('pause')}>{t('personalAgentPause')}</Button>}
        {paused && <Button size="sm" variant="flat" isDisabled={busy} onPress={()=>act('resume')}>{t('personalAgentResume')}</Button>}
        {status==='error' && <Button size="sm" variant="flat" isDisabled={busy} onPress={()=>act('retry')}>{t('personalTaskRetry')}</Button>}
        {status && !['complete','error','cancelled'].includes(status) && <Button size="sm" variant="light" color="danger" isDisabled={busy} onPress={()=>act('cancel')}>{t('personalTaskCancel')}</Button>}
      </div>
      {!cancelled && !paused && detail.actions?.filter(action=>action.status==='awaiting_review').map(action=><section key={action.id} className="space-y-3 rounded-2xl bg-[#eee5f5] p-4 dark:bg-[#392f40]"><h3 className="font-semibold">{t('personalTaskReadyReview')}</h3><p className="text-sm text-default-500">{t('personalTaskReviewHint')}</p><Button color="secondary" size="sm" onPress={()=>setReview(action)}>{t('personalTaskReviewAction')}</Button></section>)}
      {requests.map(request=><InputRequest key={request.id} request={request} onSubmit={async(...args)=>{await onSubmit(...args);await load();}} />)}
      {detail.watch && <section className="space-y-3 rounded-2xl bg-[#f0f1f2] p-4 dark:bg-[#292b2d]"><div className="flex items-center gap-2"><Icon icon="lucide:eye"/><h3 className="font-semibold">{t('personalAgentTracking')}</h3></div><p className="break-all text-xs text-default-500">{detail.watch.url}</p><p className="text-xs text-default-500">{t('personalWatchSourceChecks',{minutes:detail.watch.intervalMinutes,count:detail.watch.checks})}</p><p className="text-xs text-default-500">{t('personalWatchLastChecked',{time:detail.watch.lastCheckedAt?new Date(detail.watch.lastCheckedAt).toLocaleString():'—'})}</p>{detail.watch.lastExcerpt && <p className="whitespace-pre-wrap text-sm text-default-500">{detail.watch.lastExcerpt}</p>}{detail.watch.error && <p role="alert" className="text-sm text-danger">{detail.watch.error}</p>}</section>}
      {latestPlan && <section className="space-y-2"><h3 className="text-sm font-semibold">{t('personalTaskSteps')}</h3>{latestPlan.map((step,index)=><p key={index} className="text-sm">{step.status==='completed' ? '✓' : `${index+1}.`} {step.step}</p>)}</section>}
      {(hasMoreOlder ?? detail.hasMore) && <Button size="sm" variant="light" isLoading={loadingMore} onPress={()=>{const beforeMessageId=messages[0]?.id;if(!beforeMessageId)return;setLoadingMore(true);void readPersonalAgentTask(clientId,roomId,beforeMessageId).then(page=>{setOlderMessages(previous=>[...page.messages,...previous]);setHasMoreOlder(page.hasMore);}).catch(failure=>setError(failure.message)).finally(()=>setLoadingMore(false));}}>{t('personalTaskMoreHistory')}</Button>}
      <PersonalAgentTaskArtifacts clientId={clientId} detail={detail} showResults={false}/>
      <section className="space-y-4"><h3 className="text-sm font-semibold">{t('personalTaskRuns')}</h3>{[...detail.turns].reverse().map(turn=><article key={turn.id} className="space-y-3 rounded-2xl border border-default-200 p-4"><div className="flex flex-wrap justify-between gap-2 text-xs text-default-500"><span>{t(requests.some(request=>request.turnId===turn.id) ? 'personalTaskWaitingInput' : turnStatus(turn))}</span><time>{new Date(turn.startedAt).toLocaleString()}</time></div>
        <PersonalAgentResults clientId={clientId} turn={turn} canInteract /><PersonalAgentBrowserVisits clientId={clientId} turn={turn} canInteract />
        {messages.filter(message=>message.turnId===turn.id && message.messageType==='ai' && message.content.trim()).map(message=><div key={message.id} className="border-l-2 border-default-200 pl-4"><p className="whitespace-pre-wrap break-words text-sm text-default-500">{message.content}</p></div>)}
      </article>)}</section></>}
  </div></ModalBody></ModalContent></Modal>{review && <PersonalAgentGoogleReview clientId={clientId} action={review} onClose={()=>setReview(undefined)} onDone={()=>void load()}/>}</>;
};
