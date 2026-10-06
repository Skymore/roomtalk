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

Ported from OpenMuse GoalsScreen tracking list, MonitorForm and MonitorCard in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button,Input,Modal,ModalContent,ModalHeader,ModalBody} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {readPersonalAgentWatches,createPersonalAgentWatch,controlPersonalAgentWatch,type PersonalAgentWatch} from '../utils/personalAgent';
export const PersonalAgentTracking:React.FC<{clientId:string;showError:(message:string)=>void;showSuccess:(message:string)=>void;onTask:(id:string)=>void}>=({clientId,showError,onTask})=>{
  const {t}=useTranslation();
  const [watches,setWatches]=React.useState<PersonalAgentWatch[]>([]),[total,setTotal]=React.useState(0);
  const [loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState<string>(),[creating,setCreating]=React.useState(false);
  const [selected,setSelected]=React.useState<string>();
  const [showAll,setShowAll]=React.useState(false);
  const [error,setError]=React.useState('');
  const [title,setTitle]=React.useState(''),[url,setUrl]=React.useState(''),[condition,setCondition]=React.useState<PersonalAgentWatch['condition']>('change');
  const [value,setValue]=React.useState(''),[interval,setInterval]=React.useState('15');
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
  const watch=watches.find(item=>item.id===selected);
  const act=async(watch:PersonalAgentWatch,action:'pause'|'resume'|'check'|'stop')=>{
    if(busy)return;setBusy(watch.id);setError('');
    try{const saved=await controlPersonalAgentWatch(clientId,watch,action);if(live.current)setWatches(previous=>previous.map(item=>item.id===watch.id?saved.watch:item));}
    catch(error){if(live.current)setError(error instanceof Error?error.message:String(error));}finally{if(live.current)setBusy(undefined);}
  };
  return <section className="space-y-2" aria-label={t('personalAgentTracking')}>
    <div className="flex items-center justify-between"><h3 className="flex items-center gap-2 text-lg font-semibold text-[#189a58]"><span className="h-4 w-4 rounded-full border-[5px] border-[#d9f1e2] bg-[#24a46b]"/>{t('personalAgentTracking')}</h3><Button size="sm" startContent={<Icon icon="lucide:plus"/>} onPress={()=>{setTitle('');setUrl('');setValue('');setCondition('change');setInterval('15');setError('');setCreating(true);}}>{t('personalWatchTrack')}</Button></div>
    {(showAll?watches:watches.slice(0,3)).map(item=><button key={item.id} type="button" data-testid="personal-watch-card" aria-label={t('personalWatchOpen',{title:item.title})} className="flex w-full items-center gap-3 py-3 text-left" onClick={()=>{setSelected(item.id);setError('');}}><Icon icon="lucide:square" className="h-5 w-5 shrink-0 text-default-400"/><span className="min-w-0 flex-1"><span className="block">{item.title}</span><span className="mt-1 line-clamp-1 text-sm text-default-500">{item.status==='active'?t('personalWatchChecking',{minutes:item.intervalMinutes}):t(item.status==='stopped'?'personalWatchStopped':'personalWatchPaused')}</span></span><Icon icon="lucide:chevron-right" className="text-default-400"/></button>)}
    {!loading && !watches.length && <p className="py-3 text-sm text-default-500">{t('personalWatchSourceEmpty')}</p>}
    {total>3 && <Button size="sm" isLoading={loading} onPress={()=>{setShowAll(!showAll);if(!showAll && watches.length<total)void refresh(watches.length);}}>{t(showAll?'personalWatchShowLess':'personalWatchShowMore',{count:total-3})}</Button>}
    {showAll && watches.length<total && <Button size="sm" isLoading={loading} onPress={()=>void refresh(watches.length)}>{t('loadMore')}</Button>}
    <Modal isOpen={creating} onClose={()=>setCreating(false)} scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{t('personalWatchCreateTitle')}</ModalHeader><ModalBody className="pb-6"><form className="space-y-4" onSubmit={event=>{event.preventDefault();if(busy)return;const minutes=Number(interval);if(!Number.isInteger(minutes)||minutes<1||minutes>10080){setError(t('personalWatchIntervalError'));return;}setBusy('create');setError('');
      void createPersonalAgentWatch(clientId,{title:title.trim(),url:url.trim(),condition,value,intervalMinutes:minutes}).then(saved=>{if(live.current){setWatches(previous=>[saved.watch,...previous]);setTotal(total=>total+1);setCreating(false);}}).catch(error=>{if(live.current)setError(error.message);}).finally(()=>{if(live.current)setBusy(undefined);});
    }}>
      <Input label={t('personalWatchSourceTitle')} placeholder={t('personalWatchExample')} value={title} onValueChange={setTitle} maxLength={160}/>
      <Input label={t('personalWatchSourceURL')} value={url} onValueChange={setUrl} maxLength={4096} autoCapitalize="none" autoCorrect="off" placeholder="https://example.com/product"/>
      <fieldset className="space-y-2"><legend className="mb-2 text-xs text-default-500">{t('personalWatchNotifyWhen')}</legend><div className="flex flex-wrap gap-2">{(['change','contains','price_below'] as const).map(item=><Button key={item} size="sm" color={condition===item?'secondary':'default'} aria-pressed={condition===item} onPress={()=>setCondition(item)}>{t(item==='change'?'personalWatchSourceChange':item==='contains'?'personalWatchSourceContains':'personalWatchSourcePrice')}</Button>)}</div></fieldset>
      {condition!=='change' && <Input label={t(condition==='contains'?'personalWatchSourceText':'personalWatchSourcePriceValue')} value={value} onValueChange={setValue}/>}<Input label={t('personalWatchSourceInterval')} value={interval} onValueChange={setInterval} inputMode="numeric"/>
      <p className="text-xs text-default-500">{t('personalWatchSourceHint')}</p>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" color="secondary" isLoading={busy==='create'} isDisabled={!title.trim()||!url.trim()||(condition!=='change'&&!value.trim())}>{t('personalWatchStart')}</Button>
    </form></ModalBody></ModalContent></Modal>
    <Modal isOpen={Boolean(watch)} onClose={()=>setSelected(undefined)} scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{watch?.title}</ModalHeader><ModalBody className="pb-6">{watch && <div className="space-y-3 rounded-2xl border border-default-200 p-4">
      <div className="flex justify-between gap-3"><h3 className="font-semibold">{watch.title}</h3><span className="rounded-full bg-[#d7e9fa] px-2 py-1 text-xs dark:bg-[#263744]">{t(watch.status==='active'?'personalWatchActive':watch.status==='stopped'?'personalWatchStopped':'personalWatchPaused')}</span></div><p className="break-all text-xs text-default-500">{watch.url}</p>
      <p className="text-sm">{t(watch.condition==='change'?'personalWatchChange':watch.condition==='contains'?'personalWatchContainsSummary':'personalWatchPriceSummary',{value:watch.value})}</p>
      <p className="text-xs text-default-500">{t('personalWatchSourceChecks',{minutes:watch.intervalMinutes,count:watch.checks})}</p><p className="text-xs text-default-500">{t('personalWatchLastChecked',{time:watch.lastCheckedAt?new Date(watch.lastCheckedAt).toLocaleString():'—'})}</p>
      {watch.status==='active' && <p className="text-xs text-default-500">{t('personalWatchSourceNext',{time:watch.nextCheckAt?new Date(watch.nextCheckAt).toLocaleString():'—'})}</p>}
      {watch.lastExcerpt && <p className="line-clamp-5 whitespace-pre-wrap break-words text-sm text-default-500">{watch.lastExcerpt}</p>}
      {(error || watch.error) && <p role="alert" className="text-sm text-danger">{error || watch.error}</p>}
      {watch.status!=='stopped' && <div className="flex flex-wrap gap-2"><Button size="sm" isLoading={Boolean(busy)} onPress={()=>void act(watch,watch.status==='active'?'pause':'resume')}>{t(watch.status==='active'?'personalAgentPause':'personalAgentResume')}</Button><Button size="sm" isLoading={Boolean(busy)} onPress={()=>void act(watch,'check')}>{t('personalWatchCheckNow')}</Button><Button size="sm" color="danger" isLoading={Boolean(busy)} onPress={()=>void act(watch,'stop')}>{t('personalWatchStop')}</Button></div>}
      <Button size="sm" variant="light" onPress={()=>{setSelected(undefined);onTask(watch.roomId);}}>{t('personalUpdateViewTask')}</Button>
    </div>}</ModalBody></ModalContent></Modal>
  </section>;
};
