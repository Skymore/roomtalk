import React from 'react';
import {Button,Input,Spinner,Textarea} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {readComputer,changeComputer,type ComputerSnapshot,type ComputerCommand,type ComputerDirectory} from '../../utils/personalComputer';
import {readPersonalAgentFiles,type PersonalAgentFile} from '../../utils/personalAgent';
import {useComputerDraft} from './drafts';
import {DesktopStream} from './DesktopStream';

// OpenMuse computer-workspace.tsx, with native controls mapped to the existing web components.
// MIT notice is in drafts.tsx in this directory.
interface ComputerFileAction { (): Promise<void> }
const panel='space-y-3 rounded-2xl border border-default-200 bg-content1 p-4';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export function LinuxWorkspace({clientId,tab,onSnapshot,onDocument}:{clientId:string;tab:'Terminal'|'Files'|'Desktop';onSnapshot:(snapshot:ComputerSnapshot)=>void;onDocument:(file:PersonalAgentFile)=>void}){
  const {t}=useTranslation();
  const [snapshot,setSnapshot]=React.useState<ComputerSnapshot>();
  const [error,setError]=React.useState('');
  const [connectionError,setConnectionError]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [executing,setExecuting]=React.useState(false);
  const [showHistory,setShowHistory]=React.useState(false);
  const [editingCommand,setEditingCommand]=React.useState(false);
  const [command,setCommand]=useComputerDraft('command');
  const [cwd,setCwd]=useComputerDraft('cwd');
  const version=React.useRef(0),polling=React.useRef(false),mutations=React.useRef(0);
  const refresh=React.useCallback(async()=>{
    if(polling.current || mutations.current)return;polling.current=true;const request=++version.current;
    try{const next=await readComputer(clientId);if(request===version.current){setSnapshot(next);setConnectionError('');}}
    catch(error){if(request===version.current)setConnectionError(message(error));}
    finally{polling.current=false;}
  },[clientId]);
  const commandActive=snapshot?.commands.some(item=>item.status==='running');
  React.useEffect(()=>{
    const poll=()=>{if(!document.hidden)void refresh();};void refresh();document.addEventListener('visibilitychange',poll);
    const interval=(tab==='Desktop' && snapshot?.status==='running') || executing || busy || commandActive ?setInterval(poll,5000):undefined;
    return()=>{clearInterval(interval);document.removeEventListener('visibilitychange',poll);};
  },[refresh,tab,executing,busy,snapshot?.status,commandActive]);
  React.useEffect(()=>()=>{version.current++;},[refresh]);
  React.useEffect(()=>{if(snapshot)onSnapshot(snapshot);},[snapshot,onSnapshot]);
  async function control(action:'start'|'stop'){
    if(busy)return;setBusy(true);setError('');mutations.current++;const operation=++version.current;
    try{const next=await changeComputer(clientId,action);if(operation===version.current)setSnapshot(next);}
    catch(error){setError(message(error));}finally{setBusy(false);mutations.current--;void refresh();}
  }
  async function run(){
    if(!command.trim() || executing || busy)return;const sent=command;setExecuting(true);setError('');mutations.current++;const operation=++version.current;
    try{
      const result=await changeComputer<ComputerCommand>(clientId,'run',{command:sent,cwd,operationId:crypto.randomUUID()});
      if(operation===version.current)setSnapshot(current=>current?{...current,commands:[result,...current.commands.filter(item=>item.id!==result.id)]}:current);
      setCommand(current=>current===sent?'':current);setEditingCommand(false);
    }catch(error){setError(message(error));}finally{setExecuting(false);mutations.current--;void refresh();}
  }
  const running=snapshot?.status==='running',commandRunning=executing || commandActive;
  return <div className="space-y-4" data-testid="personal-computer-workspace">
    <section className="space-y-3 rounded-2xl bg-secondary/10 p-4">
      <div className="flex items-center gap-3"><Icon icon="lucide:terminal" className="h-6 w-6"/><div><h3 className="font-semibold">{t('personalComputerLinux')}</h3><p className="text-sm text-default-600">{t(running?'personalComputerRunning':snapshot?.status==='stopped'?'personalComputerStopped':snapshot?.status==='unconfigured'?'personalComputerUnconfigured':snapshot?.status==='error'?'personalComputerConnectionError':'loading')}</p></div>{!snapshot && !error && <Spinner size="sm"/>}</div>
      {snapshot?.message && <p className="text-xs text-default-600">{snapshot.message}</p>}
      {snapshot?.enabled && <div className="flex flex-wrap gap-2"><Button color={running?'default':'secondary'} isLoading={busy} onPress={()=>void control(running?'stop':'start')}>{t(running?'personalComputerStop':'personalComputerStart')}</Button><Button isDisabled={busy} onPress={()=>{void refresh();setError('');}}>{t('refresh')}</Button></div>}
    </section>
    {(error || connectionError) && <p role="alert" className="text-sm text-danger">{error || connectionError}</p>}
    {!snapshot && (error || connectionError) && <Button onPress={()=>{void refresh();setError('');}}>{t('retry')}</Button>}
    {snapshot?.enabled && <>
      <div className={tab==='Terminal'?'space-y-4':'hidden'}>
        {editingCommand || command.length!==0 || snapshot.commands.length===0 ?
        <div className="space-y-3 rounded-2xl bg-content2 p-4">
          <p className="font-mono text-xs text-default-500">{t('personalComputerTab_Terminal').toUpperCase()}</p>
          <Input label={t('personalComputerCwd')} value={cwd} onValueChange={setCwd} classNames={{input:'font-mono'}} autoCapitalize="none" autoCorrect="off"/>
          <Textarea label={t('personalComputerCommand')} placeholder={t('personalComputerCommandExample')} value={command} onValueChange={setCommand} maxLength={16000} minRows={3} classNames={{input:'font-mono'}} autoCapitalize="none" autoCorrect="off" spellCheck="false"/>
          {/[‘’“”]/.test(command) && <Button size="sm" onPress={()=>setCommand(text=>text.replace(/[‘’]/g,"'").replace(/[“”]/g,'"'))}>{t('personalComputerStraightQuotes')}</Button>}
          <Button color="secondary" isLoading={Boolean(commandRunning)} isDisabled={!running || !command.trim() || busy} onPress={()=>void run()}>{t('personalComputerRun')}</Button>
          <p className="text-xs text-default-500">{t(snapshot.network==='enabled'?'personalComputerInternetHint':'personalComputerNetworkOff')}</p>
        </div>:<Button color="secondary" isDisabled={!running || busy || commandRunning} onPress={()=>setEditingCommand(true)}>{t('personalComputerNewCommand')}</Button>}
        {commandRunning && <p className="text-sm text-default-500">{t('personalComputerWorking')}</p>}
        {snapshot.commands.length===0?<Empty title={t('personalComputerFirstCommand')} detail={t('personalComputerFirstHint')}/>: [...snapshot.commands].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,showHistory?undefined:5).map(run=><CommandReceipt key={run.id} run={run}/>)}
        {snapshot.commands.length>5 && <Button size="sm" onPress={()=>setShowHistory(!showHistory)}>{t(showHistory?'personalComputerRecent':'personalComputerEarlier')}</Button>}
      </div>
      <div className={tab==='Files'?'':'hidden'}><ComputerFiles clientId={clientId} running={Boolean(running)} active={tab==='Files'} onDocument={onDocument}/></div>
      {snapshot.provider==='e2b-desktop' && tab==='Desktop' && (running?<div className="space-y-3"><DesktopStream clientId={clientId} running/><p className="text-xs text-default-500">{t('personalComputerDesktopHint')}</p></div>:<Empty title={t('personalComputerDesktopOff')} detail={t('personalComputerDesktopOffHint')}/>)}
    </>}
  </div>;
}
function Empty({title,detail}:{title:string;detail:string}){return <div className="py-6 text-center"><p className="font-medium">{title}</p><p className="mt-2 text-sm text-default-500">{detail}</p></div>;}
function CommandReceipt({run}:{run:ComputerCommand}){
  const {t}=useTranslation();const [expanded,setExpanded]=React.useState(true);
  return <article className={panel} data-testid="personal-computer-command">
    <div className="flex justify-between gap-2 text-xs"><span className={run.status==='succeeded'?'text-success':run.status==='running'?'text-secondary':'text-danger'}>{t(`personalComputerCommand_${run.status}`)}{run.exitCode!==undefined?` · exit ${run.exitCode}`:''}</span><time>{new Date(run.startedAt).toLocaleString()}</time></div>
    <pre className="whitespace-pre-wrap break-words font-mono text-sm">{`$ ${run.command}`}</pre><p className="font-mono text-xs text-default-500">{run.cwd}</p>
    {expanded && <>{run.stdout && <pre className="whitespace-pre-wrap break-words text-xs">{run.stdout}</pre>}{run.stderr && <pre className="whitespace-pre-wrap break-words text-xs text-danger">{run.stderr}</pre>}{!run.stdout && !run.stderr && run.status!=='running' && <p className="text-xs text-default-500">{t('personalComputerNoOutput')}</p>}{run.truncated && <p className="text-xs text-default-500">{t('personalComputerTruncated')}</p>}</>}
    {(run.stdout || run.stderr) && <Button size="sm" variant="light" onPress={()=>setExpanded(!expanded)}>{t(expanded?'personalComputerHideOutput':'personalComputerShowOutput')}</Button>}
  </article>;
}
function ComputerFiles({clientId,running,active,onDocument}:{clientId:string;running:boolean;active:boolean;onDocument:(file:PersonalAgentFile)=>void}){
  const {t}=useTranslation();const [path,setPath]=useComputerDraft('path');
  const [editor,setEditor]=useComputerDraft('editor');
  const [directory,setDirectory]=React.useState<ComputerDirectory>();
  const [files,setFiles]=React.useState<PersonalAgentFile[]>([]);
  const [error,setError]=React.useState('');
  const [notice,setNotice]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [loading,setLoading]=React.useState(false);
  const [retry,setRetry]=React.useState(0);
  const [folder,setFolder]=React.useState<string>();
  const [importing,setImporting]=React.useState(false);
  const mounted=React.useRef(true);React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const dirty=Boolean(editor && (editor.text!==editor.saved || editor.path!==editor.savedPath));
  React.useEffect(()=>{
    if(!active || !running){setLoading(false);return;}
    let alive=true;setLoading(true);setError('');
    void readComputer<ComputerDirectory>(clientId,'list',{path}).then(value=>{if(alive)setDirectory(value);}).catch(error=>{if(alive)setError(message(error));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[clientId,active,running,path,retry]);
  React.useEffect(()=>{if(!importing)return;let alive=true;void readPersonalAgentFiles(clientId).then(value=>{if(alive)setFiles(value.files);}).catch(error=>{if(alive)setError(message(error));});return()=>{alive=false;};},[clientId,importing]);
  async function act(action:ComputerFileAction){if(busy || loading)return;setBusy(true);setError('');setNotice('');try{await action();}catch(error){if(mounted.current)setError(message(error));}finally{if(mounted.current)setBusy(false);}}
  const read=(file:string)=>act(async()=>{const content=await readComputer<{path:string;text:string}>(clientId,'read',{path:file});if(mounted.current)setEditor({...content,saved:content.text,savedPath:content.path});});
  const importDocument=(file:PersonalAgentFile)=>act(async()=>{await changeComputer(clientId,'copy-document',{fileId:file.id,path:`${path}/${file.name.replace(/[\\/]/g,'_')}`});if(mounted.current){setImporting(false);setNotice(t('personalComputerCopied'));setRetry(value=>value+1);}});
  const openPdf=(path:string)=>act(async()=>{const {file}=await changeComputer<{file:PersonalAgentFile}>(clientId,'import-pdf',{path});if(mounted.current)onDocument(file);});
  const save=()=>act(async()=>{if(!editor)return;const sent=editor;await changeComputer(clientId,'write',{path:sent.path,text:sent.text});if(mounted.current){setEditor(current=>current?.path===sent.path?{...current,saved:sent.text,savedPath:sent.path}:current);setNotice(t('personalComputerSaved'));setRetry(value=>value+1);}});
  const mkdir=()=>act(async()=>{await changeComputer(clientId,'mkdir',{path:`${path}/${folder?.trim()}`});if(mounted.current){setFolder(undefined);setRetry(value=>value+1);}});
  return <section className="space-y-3" data-testid="personal-computer-files">
    <div className="flex justify-between"><h3 className="font-semibold">{t('personalComputerWorkspaceFiles')}</h3>{(busy || loading) && <Spinner size="sm"/>}</div><p className="break-all font-mono text-xs text-default-500">{editor?.path || path}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-success">{notice}</p>}{!running && <p className="text-sm text-default-500">{t('personalComputerStartFiles')}</p>}
    {editor?<>
      <Input label={t('personalComputerFilePath')} value={editor.path} onValueChange={path=>setEditor({...editor,path})} classNames={{input:'font-mono'}} autoCorrect="off" autoCapitalize="none"/>
      <Textarea label={t('personalComputerFileContents')} value={editor.text} onValueChange={text=>setEditor({...editor,text})} minRows={10} classNames={{input:'font-mono'}} autoCorrect="off" autoCapitalize="none" spellCheck="false"/>
      <div className="flex flex-wrap gap-2"><Button color="secondary" isLoading={busy} isDisabled={!running || !editor.path.trim()} onPress={()=>void save()}>{t('personalComputerSaveFile')}</Button><Button isDisabled={busy} onPress={()=>{setEditor(undefined);setNotice('');}}>{t(dirty?'personalComputerDiscard':'personalComputerBackFiles')}</Button></div>
    </>:<>
      <div className="flex flex-wrap gap-2">
        {path!=='/workspace' && <Button size="sm" isDisabled={busy} onPress={()=>setPath(path.slice(0,path.lastIndexOf('/')) || '/workspace')}>{t('personalComputerUp')}</Button>}
        <Button size="sm" isDisabled={!running || busy} onPress={()=>{setNotice('');setEditor({path:`${path}/note-${Date.now()}.txt`,text:'',saved:'',savedPath:''});}}>{t('personalComputerNewFile')}</Button>
        <Button size="sm" isDisabled={!running || busy} onPress={()=>setFolder('')}>{t('personalComputerNewFolder')}</Button><Button size="sm" isDisabled={!running || busy} onPress={()=>setRetry(retry+1)}>{t('personalComputerRefreshFiles')}</Button><Button size="sm" isDisabled={!running || busy} onPress={()=>setImporting(!importing)}>{t(importing?'personalComputerHideDocuments':'personalComputerCopyDocument')}</Button>
      </div>
      {importing && <section className={panel}><h4 className="font-semibold">{t('personalComputerChoosePdf')}</h4><p className="text-xs text-default-500">{t('personalComputerReplaceHint')}</p>{files.map(file=><Button key={file.id} variant="light" className="w-full justify-start" isDisabled={busy} onPress={()=>void importDocument(file)}>{file.name}</Button>)}{!files.length && <p className="text-sm text-default-500">{t('personalComputerNoDocuments')}</p>}</section>}
      {folder!==undefined && <section className={panel}><Input label={t('personalComputerFolderName')} value={folder} onValueChange={setFolder} autoCapitalize="none" autoCorrect="off"/><div className="flex gap-2"><Button color="secondary" isDisabled={!running || loading || !folder.trim()} isLoading={busy} onPress={()=>void mkdir()}>{t('personalComputerCreateFolder')}</Button><Button isDisabled={busy} onPress={()=>setFolder(undefined)}>{t('cancel')}</Button></div></section>}
      {running && directory?.path===path && directory.entries.map(entry=><button key={entry.path} type="button" disabled={busy || loading} className="flex w-full items-center gap-3 border-b border-default-200 py-3 text-left" onClick={()=>{
        if(entry.type==='directory'){setNotice('');setPath(entry.path);}else if(/\.pdf$/i.test(entry.name))void openPdf(entry.path);else void read(entry.path);
      }}><Icon icon={entry.type==='directory'?'lucide:folder':'lucide:file-text'}/><span className="min-w-0 flex-1 break-all text-sm">{entry.name}</span><span className="text-xs text-default-500">{entry.type==='directory'?t('personalComputerFolder'):entry.type==='symlink'?t('personalComputerSymlink'):`${Math.max(1,Math.ceil(entry.size/1024))} KB`}</span></button>)}
      {running && !busy && !loading && !error && directory?.path===path && directory.entries.length===0 && <Empty title={t('personalComputerFilesEmpty')} detail={t('personalComputerFilesEmptyHint')}/>}
    </>}
  </section>;
}
