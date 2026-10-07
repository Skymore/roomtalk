import React from 'react';
import {Button,Input,Modal,ModalBody,ModalContent,ModalHeader} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {requestPersonalAgent,readPersonalBrowserPreview,readPersonalAgentFiles,type PersonalAgentFile,type PersonalBrowserFrame} from '../utils/personalAgent';
import type {ComputerSnapshot} from '../utils/personalComputer';
import {PersonalAgentBrowserControl} from './PersonalAgentBrowser';
import {ComputerDraftProvider,useComputerDraft} from './personalComputer/drafts';
import {LinuxWorkspace} from './personalComputer/Workspace';

// OpenMuse ComputerSheet. Native sheets use the existing web modal; all tabs and
// workspace controls follow its source. MIT notice is in personalComputer/drafts.tsx.
export function PersonalAgentComputer(props:{clientId:string;mainRoomId:string;available:boolean;initialTab?:'Desktop';isOpen:boolean;onClose:()=>void;onFiles:(file?:PersonalAgentFile)=>void}){
  return <ComputerDraftProvider><ComputerSheet {...props}/></ComputerDraftProvider>;
}
function ComputerSheet({clientId,available,initialTab,isOpen,onClose,onFiles}:{clientId:string;mainRoomId:string;available:boolean;initialTab?:'Desktop';isOpen:boolean;onClose:()=>void;onFiles:(file?:PersonalAgentFile)=>void}){
  const {t}=useTranslation();const [tab,setTab]=useComputerDraft('tab');
  React.useEffect(()=>{if(isOpen && initialTab)setTab(initialTab);},[isOpen,initialTab,setTab]);
  const [desktop,setDesktop]=React.useState<boolean>();
  const [busy,setBusy]=React.useState(false);
  const [url,setUrl]=React.useState('');
  const [error,setError]=React.useState('');
  const [sessions,setSessions]=React.useState<PersonalBrowserFrame['session'][]>([]);
  const [files,setFiles]=React.useState<PersonalAgentFile[]>([]);
  const [browser,setBrowser]=React.useState<{roomId:string;url?:string}>();
  const onSnapshot=React.useCallback((value:ComputerSnapshot)=>{if(value.status!=='error')setDesktop(value.provider==='e2b-desktop' && value.status==='running');},[]);
  const refresh=React.useCallback(async()=>{
    try{const [browsers,documents]=await Promise.all([requestPersonalAgent<{sessions:PersonalBrowserFrame['session'][]}>(clientId,'/browsers'),readPersonalAgentFiles(clientId)]);setSessions(browsers.sessions);setFiles(documents.files);setError('');}catch(error){setError(error instanceof Error?error.message:String(error));}
  },[clientId]);
  React.useEffect(()=>{if(!isOpen)return;void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);return()=>clearInterval(timer);},[isOpen,refresh]);
  const shown=desktop===false && tab==='Desktop'?'Terminal':tab;
  const tabs=desktop?['Browser','Desktop','Terminal','Files'] as const:['Browser','Terminal','Files'] as const;
  const openBrowser=async()=>{if(busy || !url.trim())return;setBusy(true);setError('');try{const saved=await requestPersonalAgent<PersonalBrowserFrame>(clientId,'/browsers','POST',{url:/^https?:\/\//i.test(url)?url:`https://${url}`});await refresh();setBrowser({roomId:saved.session.roomId});}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
  return <>
    <Modal isOpen={isOpen && !browser} onClose={onClose} size="4xl" scrollBehavior="inside" classNames={{base:'max-h-[90dvh] bg-content1'}}>
      <ModalContent className="personal-agent-theme"><ModalHeader className="block"><h2>{t('personalComputerTitle')}</h2><p className="mt-1 text-sm font-normal text-default-500">{t('personalComputerSubtitle')}</p></ModalHeader><ModalBody className="pb-6"><div className="space-y-5">
        {shown==='Browser' && <section className="flex items-center gap-3 rounded-2xl bg-secondary/10 p-4"><Icon icon="lucide:monitor" className="h-7 w-7"/><div><h3 className="font-semibold">{t(available?'personalComputerBrowserConnected':'personalComputerBrowserOffline')}</h3><p className="text-sm text-default-600">{t(available?'personalComputerBrowserHint':'personalComputerBrowserOfflineHint')}</p></div></section>}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('personalComputerTabs')}>{tabs.map(item=><Button key={item} role="tab" aria-selected={shown===item} variant={shown===item?'flat':'light'} color={shown===item?'secondary':'default'} onPress={()=>setTab(item)} startContent={<Icon icon={{Browser:'lucide:globe',Desktop:'lucide:monitor',Terminal:'lucide:terminal',Files:'lucide:folder-open'}[item]}/>}>{t(`personalComputerTab_${item}`)}</Button>)}</div>
        <div className={shown==='Browser'?'hidden':''}>{isOpen && <LinuxWorkspace clientId={clientId} tab={shown==='Browser'?'Terminal':shown} onSnapshot={onSnapshot} onDocument={file=>{onClose();onFiles(file);}}/>}</div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {shown==='Browser'?<>
          <form className="space-y-3" onSubmit={event=>{event.preventDefault();void openBrowser();}}><Input variant="bordered" labelPlacement="outside" label={t('personalComputerWebsiteAddress')} value={url} onValueChange={setUrl} placeholder="https://example.com" autoCapitalize="none" type="url"/><Button type="submit" color="secondary" isLoading={busy} isDisabled={!available || !url.trim()}>{t('personalComputerOpenBrowser')}</Button></form>
          {[...sessions].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(session=><PersonalAgentBrowserSessionCard key={session.id} clientId={clientId} session={session} onOpen={()=>setBrowser({roomId:session.roomId})}/>)}
          {!sessions.length && <p className="text-sm text-default-500">{t('personalComputerBrowsersEmpty')}</p>}<p className="text-xs text-default-500">{t('personalComputerBrowserSessionsHint')}</p>
        </>:shown==='Files'?<section className="space-y-3"><h3 className="font-semibold">{t('personalComputerDocuments')}</h3><p className="text-xs text-default-500">{t('personalComputerDocumentsHint')}</p>{files.map(file=><Button key={file.id} variant="light" className="w-full justify-start" onPress={()=>{onClose();onFiles(file);}} startContent={<Icon icon="lucide:file-text"/>}>{file.name}</Button>)}<Button onPress={()=>{onClose();onFiles();}}>{t('personalFilesImport')}</Button></section>:null}
        <Button size="sm" variant="light" onPress={()=>void refresh()} startContent={<Icon icon="lucide:refresh-cw"/>}>{t('personalComputerRefresh')}</Button>
      </div></ModalBody></ModalContent>
    </Modal>
    {browser && <PersonalAgentBrowserControl clientId={clientId} roomId={browser.roomId} initialUrl={browser.url} isOpen={isOpen} onClose={()=>{setBrowser(undefined);onClose();void refresh();}}/>}
  </>;
}

export function PersonalAgentBrowserSessionCard({clientId,session,onOpen}:{clientId:string;session:PersonalBrowserFrame['session'];onOpen:()=>void}){
  const {t}=useTranslation(),[preview,setPreview]=React.useState<string>(),[failed,setFailed]=React.useState(false);
  React.useEffect(()=>{
    let live=true,objectUrl:string|undefined;setPreview(undefined);setFailed(false);
    if(session.previewUrl && session.status!=='closed')void readPersonalBrowserPreview(clientId,session.previewUrl).then(blob=>{objectUrl=URL.createObjectURL(blob);if(live)setPreview(objectUrl);else URL.revokeObjectURL(objectUrl);}).catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[clientId,session.previewUrl,session.updatedAt,session.status]);
  return <section className="space-y-3 rounded-[22px] bg-content2 p-4"><div className="flex items-center gap-3"><Icon icon="lucide:globe" className="h-6 w-6"/><div className="min-w-0"><h3 className="font-semibold">{t('personalBrowser')}</h3><p className="truncate text-xs text-default-500">{session.status==='closed'?t('personalBrowserSessionClosed'):session.status==='error'?t('personalBrowserSessionReconnect'):session.title}</p></div></div>{preview?<img src={preview} alt={t('personalBrowserSessionPreview',{title:session.title})} className="h-auto w-full rounded-xl"/>:<p className="break-all rounded-xl bg-content1 p-4 text-sm text-default-500">{failed?t('personalBrowserSessionPreviewFailed'):session.url}</p>}<Button onPress={onOpen}>{t(session.status==='closed'?'personalBrowserSessionReopen':session.status==='error'?'personalBrowserSessionReconnectButton':'personalBrowserTakeControl')}</Button></section>;
}
