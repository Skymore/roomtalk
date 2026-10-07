import React from 'react';
import {Button,Spinner} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {readComputer,changeComputer,type ComputerSnapshot} from '../../utils/personalComputer';
import type {PersonalDesktopStep} from '../../utils/personalDesktopSteps';
import {DesktopStream} from './DesktopStream';

// OpenMuse desktop-tool-card.tsx. Only the newest step mounts a live VNC viewer.
// MIT notice is in drafts.tsx in this directory.
export function DesktopToolCard({clientId,step,live,onOpen}:{clientId:string;step:PersonalDesktopStep;live:boolean;onOpen?:()=>void}){
  const {t}=useTranslation();
  const [snapshot,setSnapshot]=React.useState<ComputerSnapshot>();
  const [error,setError]=React.useState('');
  const [starting,setStarting]=React.useState(false);
  React.useEffect(()=>{
    if(!live || starting)return;let alive=true,pending=false;
    const refresh=async()=>{
      if(pending || document.hidden)return;pending=true;
      try{const value=await readComputer(clientId);if(alive){setSnapshot(value);setError('');}}
      catch(error){if(alive)setError(error instanceof Error?error.message:String(error));}finally{pending=false;}
    };
    void refresh();const interval=step.loading || snapshot?.status==='running'?setInterval(()=>void refresh(),5000):undefined;
    document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;clearInterval(interval);document.removeEventListener('visibilitychange',refresh);};
  },[clientId,live,starting,step.loading,snapshot?.status]);
  const running=snapshot?.status==='running';
  return <section className="mx-auto w-full max-w-3xl space-y-3 rounded-2xl bg-content2 p-4" data-testid="personal-desktop-step">
    <div className="flex items-center gap-3"><Icon icon="lucide:monitor" className="h-6 w-6"/><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{t('personalComputerTab_Desktop')}</h3><p className="truncate text-xs text-default-500">{step.loading?t('personalDesktopWorking'):step.error?t('personalDesktopFailed'):step.action || t('personalDesktopStep')}</p></div>{step.loading && <Spinner size="sm"/>}</div>
    {(step.error || error) && <p role="alert" className="text-sm text-danger">{step.error || error}</p>}
    {live && snapshot && !running?<div className="space-y-3 rounded-xl bg-content1 p-4"><p className="text-xs text-default-500">{t('personalDesktopOffline')}</p>{snapshot.enabled && <Button size="sm" isLoading={starting} onPress={()=>{setStarting(true);setError('');void changeComputer(clientId,'start').then(setSnapshot).catch(error=>setError(error.message)).finally(()=>setStarting(false));}}>{t('personalComputerStart')}</Button>}</div>:live && running?<DesktopStream clientId={clientId} running/>:null}
    {onOpen && <Button size="sm" onPress={onOpen}>{t('personalDesktopOpenTab')}</Button>}
  </section>;
}
