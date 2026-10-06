import React from 'react';
import { Button, Input, Select, SelectItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { PersonalAgentBrowserControl } from './PersonalAgentBrowser';
import { readPersonalAgentWatches, createPersonalAgentWatch, controlPersonalAgentWatch, removePersonalAgentWatch, type PersonalAgentWatch } from '../utils/personalAgent';

export const PersonalAgentTracking: React.FC<{clientId: string; showError: (message: string)=>void; showSuccess: (message: string)=>void}> = ({clientId,showError,showSuccess}) => {
  const {t}=useTranslation();
  const [watches,setWatches]=React.useState<PersonalAgentWatch[]>([]),[total,setTotal]=React.useState(0);
  const [loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState<string>(),[creating,setCreating]=React.useState(false);
  const [browser,setBrowser]=React.useState<PersonalAgentWatch>();
  const [removing,setRemoving]=React.useState<PersonalAgentWatch>();
  const [title,setTitle]=React.useState(''),[url,setUrl]=React.useState(''),[condition,setCondition]=React.useState<PersonalAgentWatch['condition']>('change');
  const [value,setValue]=React.useState(''),[interval,setInterval]=React.useState('30');
  const live=React.useRef(true),pending=React.useRef(false),loaded=React.useRef(50);loaded.current=Math.max(50,watches.length);
  React.useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);
  const refresh=React.useCallback(async (offset=0,background=false)=>{
    if(pending.current)return;pending.current=true;if(!background)setLoading(true);
    try {const found=await readPersonalAgentWatches(clientId,offset);
      if(background)while(found.watches.length<loaded.current&&found.watches.length<found.total){
        const next=await readPersonalAgentWatches(clientId,found.watches.length);if(!next.watches.length)break;found.watches.push(...next.watches);found.total=next.total;
      }
      if(!live.current)return;
      setWatches(previous=>offset ? [...previous,...found.watches.filter(watch=>!previous.some(item=>item.id===watch.id))] : found.watches);setTotal(found.total);
    }catch(error){if(live.current&&!background)showError(error instanceof Error ? error.message : String(error));}
    finally{pending.current=false;if(live.current&&!background)setLoading(false)}
  },[clientId,showError]);
  React.useEffect(()=>{void refresh();const timer=window.setInterval(()=>{if(!document.hidden&&!pending.current)void refresh(0,true)},15000);return()=>window.clearInterval(timer)},[refresh]);
  const act=async(watch:PersonalAgentWatch,action:'pause'|'resume'|'check')=>{
    if(busy)return;setBusy(watch.id);
    try {const saved=await controlPersonalAgentWatch(clientId,watch,action);if(!live.current)return;
      setWatches(previous=>previous.map(item=>item.id===watch.id ? saved.watch : item));showSuccess(t(action==='check' ? 'personalWatchCheckRequested' : action==='pause' ? 'personalWatchPausedNotice' : 'personalWatchResumedNotice'));
    }catch(error){if(live.current)showError(error instanceof Error ? error.message : String(error));}finally{if(live.current)setBusy(undefined)}
  };
  return <section className="space-y-4" aria-label={t('personalAgentTracking')}>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-default-500">{t('personalWatchDescription')}</p>
      <div className="flex gap-2"><Button size="sm" variant="light" isLoading={loading} onPress={()=>void refresh()}>{t('refresh')}</Button>
        <Button size="sm" color="secondary" onPress={()=>{setTitle('');setUrl('');setValue('');setCondition('change');setInterval('30');setCreating(true)}}>{t('personalWatchAdd')}</Button></div></div>
    {!loading&&!watches.length&&<p className="rounded-2xl bg-default-50 p-6 text-center text-sm text-default-500">{t('personalWatchEmpty')}</p>}
    {watches.map(watch=><article key={watch.id} data-testid="personal-watch-card" className="space-y-3 rounded-2xl border border-default-200 bg-white p-5 dark:bg-[#252522]">
      <div className="flex justify-between gap-3"><h3 className="break-words font-medium">{watch.title}</h3><span className="shrink-0 text-xs text-default-500">{t(watch.status==='active' ? 'personalWatchActive' : 'personalWatchPaused')}</span></div>
      <p className="break-all text-xs text-default-500">{watch.url}</p>
      <p className="text-sm text-default-600">{t(watch.condition==='change' ? 'personalWatchChange' : watch.condition==='contains' ? 'personalWatchContainsSummary' : 'personalWatchPriceSummary',{value:watch.value})}</p>
      {watch.lastCheckedAt&&<p className="text-xs text-default-500">{t('personalWatchLastChecked',{time:new Date(watch.lastCheckedAt).toLocaleString()})}</p>}
      {watch.error&&<p className="rounded-xl bg-warning-50 p-3 text-sm text-warning-800">{watch.error}<span className="mt-1 block text-xs">{t(watch.status==='paused' ? 'personalWatchFailurePaused' : 'personalWatchRetryScheduled')}</span></p>}
      {watch.lastExcerpt!==undefined&&<details className="rounded-xl bg-default-50 p-3 text-xs text-default-500"><summary className="cursor-pointer">{t('personalWatchLastSource')}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">{watch.lastExcerpt}</p>{watch.lastUrl&&<p className="mt-2 break-all">{watch.lastUrl}</p>}</details>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="light" isDisabled={Boolean(busy)||loading} onPress={()=>void act(watch,watch.status==='active' ? 'pause' : 'resume')}>{t(watch.status==='active' ? 'personalAgentPause' : 'personalAgentResume')}</Button>
        <Button size="sm" variant="light" isDisabled={Boolean(busy)||loading||watch.status!=='active'} onPress={()=>void act(watch,'check')}>{t('personalWatchCheckNow')}</Button>
        <Button size="sm" variant="light" onPress={()=>setBrowser(watch)}>{t('personalWatchOpenPage')}</Button>
        <Button size="sm" variant="light" isDisabled={Boolean(busy)} onPress={()=>setRemoving(watch)}>{t('delete')}</Button></div>
    </article>)}
    {watches.length<total&&<Button variant="light" isLoading={loading} onPress={()=>void refresh(watches.length)}>{t('loadMore')}</Button>}
    <Modal isOpen={creating} onClose={()=>{if(!busy)setCreating(false)}}><ModalContent><form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy('create');
      void createPersonalAgentWatch(clientId,{title,url,condition,value,intervalMinutes:Number(interval)}).then(saved=>{
        if(!live.current)return;setWatches(previous=>previous.some(watch=>watch.id===saved.watch.id) ? previous : [saved.watch,...previous]);setCreating(false);void refresh();showSuccess(t('personalWatchSaved'));
      }).catch(error=>{if(live.current)showError(error.message)}).finally(()=>{if(live.current)setBusy(undefined)});
    }}><ModalHeader>{t('personalWatchAdd')}</ModalHeader><ModalBody>
      <Input label={t('personalWatchTitle')} value={title} onValueChange={setTitle} maxLength={100} isRequired isDisabled={Boolean(busy)} />
      <Input label={t('personalWatchURL')} value={url} onValueChange={setUrl} type="url" maxLength={2000} isRequired isDisabled={Boolean(busy)} />
      <Select label={t('personalWatchCondition')} selectedKeys={[condition]} onSelectionChange={keys=>setCondition(Array.from(keys)[0] as PersonalAgentWatch['condition'])} isDisabled={Boolean(busy)}>
        <SelectItem key="change">{t('personalWatchChange')}</SelectItem><SelectItem key="contains">{t('personalWatchContains')}</SelectItem><SelectItem key="price_below">{t('personalWatchPrice')}</SelectItem></Select>
      {condition!=='change'&&<Input label={t(condition==='contains' ? 'personalWatchText' : 'personalWatchPriceValue')} value={value} onValueChange={setValue} type={condition==='price_below' ? 'number' : 'text'} min="0.01" step="0.01" isRequired isDisabled={Boolean(busy)} />}
      <Select label={t('personalWatchInterval')} selectedKeys={[interval]} onSelectionChange={keys=>setInterval(String(Array.from(keys)[0]))} isDisabled={Boolean(busy)}>
        {['5','30','60','360','1440'].map(minutes=><SelectItem key={minutes}>{t('personalWatchMinutes',{count:Number(minutes)})}</SelectItem>)}</Select>
      <p className="text-xs text-default-500">{t('personalWatchBrowserHint')}</p>
    </ModalBody><ModalFooter><Button variant="light" isDisabled={Boolean(busy)} onPress={()=>setCreating(false)}>{t('cancel')}</Button>
      <Button type="submit" color="secondary" isLoading={busy==='create'} isDisabled={!title.trim()||!url.trim()||(condition!=='change'&&!value.trim())}>{t('personalWatchStart')}</Button></ModalFooter></form></ModalContent></Modal>
    <Modal isOpen={Boolean(removing)} onClose={()=>{if(!busy)setRemoving(undefined)}}><ModalContent><ModalHeader>{t('personalWatchRemove')}</ModalHeader><ModalBody><p>{t('personalWatchRemoveHint',{title:removing?.title})}</p></ModalBody><ModalFooter>
      <Button variant="light" isDisabled={Boolean(busy)} onPress={()=>setRemoving(undefined)}>{t('cancel')}</Button><Button color="danger" isLoading={Boolean(busy)} onPress={()=>{
        if(!removing||busy)return;const watch=removing;setBusy(watch.id);void removePersonalAgentWatch(clientId,watch.id).then(()=>{if(live.current){setWatches(previous=>previous.filter(item=>item.id!==watch.id));setRemoving(undefined);void refresh()}}).catch(error=>{if(live.current)showError(error.message)}).finally(()=>{if(live.current)setBusy(undefined)});
      }}>{t('delete')}</Button></ModalFooter></ModalContent></Modal>
    {browser&&<PersonalAgentBrowserControl key={browser.roomId} clientId={clientId} roomId={browser.roomId} isOpen onClose={()=>{setBrowser(undefined);void refresh()}} />}
  </section>;
};
