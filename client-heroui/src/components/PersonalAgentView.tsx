import type {PersonalWorkspaceOpener} from '../utils/personalToolSteps';
import { PersonalAgentComputer } from './PersonalAgentComputer';
import { PersonalAgentDelegate } from './PersonalAgentDelegate';
import { PersonalAgentActivity } from './PersonalAgentActivity';
import { PersonalAgentTaskDetailView } from './PersonalAgentTaskDetail';
import { PersonalAgentConnections } from './PersonalAgentConnections';
import { PersonalAgentMail } from './PersonalAgentMail';
import { PersonalAgentCalendar } from './PersonalAgentCalendar';
import { PersonalAgentFiles } from './PersonalAgentFiles';
import React from 'react';
import { PersonalAgentTracking } from './PersonalAgentTracking';
import { PersonalAgentUpdates } from './PersonalAgentUpdates';
import { PersonalAgentIdeas } from './PersonalAgentIdeas';
import { PersonalAgentMemory } from './PersonalAgentMemory';
import { PersonalAgentGoals } from './PersonalAgentGoals';
import { PersonalAgentChats } from './PersonalAgentChats';
import { Button, Checkbox, Input, Spinner,Modal,ModalContent,ModalHeader,ModalBody } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { getCodexConnectionStatus, type CodexConnectionStatus } from '../utils/codexConnection';
import { pickNewerRoom, sortRoomsByLastActivityDesc } from '../utils/roomState';
import {
  getPersonalAgent,readPersonalAgentNotifications,personalGoogleRequest, updatePersonalAgentProfile,answerPersonalAgentTaskInput,
  type PersonalAgentProfile, type PersonalAgentSnapshot,type PersonalGoogleAction,type PersonalMail,
} from '../utils/personalAgent';
import type { Room } from '../utils/types';

interface PersonalAgentViewProps {
  conversation?: (openThreads:()=>void,openComputer:(tab?:'Desktop')=>void,openWorkspace:PersonalWorkspaceOpener)=>React.ReactNode;
  selectedRoomId?:string|null;
  conversationSelection?: number;
  clientId: string;
  roomUpdates: Room[];
  onRoomSelect: (room: Room) => void;
  onMainRoomSelect?: (room:Room)=>void;
  onOpenConnections: () => void;
  onBack?: () => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

type AgentTab = 'apps' | 'files' | 'mail' | 'calendar' | 'chats' | 'ideas' | 'tracking' | 'goals' | 'activity' | 'memory';
interface AgentAction { (): Promise<void> }
// OpenMuse App.tsx primary navigation; utility pages are opened from Apps.
const tabs: { key: AgentTab; icon: string; label: string }[] = [
  { key:'chats',icon:'lucide:message-circle',label:'personalAgentChats' },
  { key:'activity',icon:'lucide:panels-top-left',label:'personalAgentActivity' },
  { key:'ideas',icon:'lucide:lightbulb',label:'personalAgentIdeas' },
  { key:'goals',icon:'lucide:square-check',label:'personalAgentGoals' },
  { key:'apps',icon:'lucide:shapes',label:'personalAgentApps' },
];
const panelClass = 'rounded-2xl border border-[#eeeef0] bg-[#ffffff] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const mutedClass = 'text-[#697176] dark:text-[#b0aea5]';


export const PersonalAgentView: React.FC<PersonalAgentViewProps> = ({
  conversation, selectedRoomId, conversationSelection, clientId, roomUpdates, onRoomSelect, onMainRoomSelect, onOpenConnections, onBack, showSuccess, showError,
}) => {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = React.useState<PersonalAgentSnapshot | null>(null);
  const [profileDraft, setProfileDraft] = React.useState<PersonalAgentProfile | null>(null);
  const [connection, setConnection] = React.useState<CodexConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [requiresSignIn, setRequiresSignIn] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [editingProfile,setEditingProfile] = React.useState(false);
  const [threadsOpen,setThreadsOpen]=React.useState(false);
  const [delegateOpen,setDelegateOpen]=React.useState(false);
  const [taskId,setTaskId]=React.useState<string>();
  const [pendingNotifications,setPendingNotifications]=React.useState(0);
  const [pendingReviews,setPendingReviews]=React.useState(0);
  const [notificationsOpen,setNotificationsOpen]=React.useState(false);
  const [computerOpen,setComputerOpen]=React.useState(false);
  const [computerTab,setComputerTab]=React.useState<'Desktop'>();
  const [initialMail,setInitialMail]=React.useState<PersonalMail>();
  const [fileId,setFileId]=React.useState<string>();
  const selectingMain=React.useRef(false);
  const [appSearch,setAppSearch] = React.useState('');
  const [tab, setTab] = React.useState<AgentTab>(() => new URLSearchParams(window.location.search).get('tab') === 'activity' ? 'activity' : 'chats');
  const profileDirty = React.useRef(false);
  React.useEffect(()=>{if(tab !== 'memory')setEditingProfile(false);},[tab]);
  React.useEffect(()=>{if(conversationSelection)setTab('chats');},[conversationSelection]);

  const refresh = React.useCallback(async () => {
    const results = await Promise.allSettled([getPersonalAgent(clientId),getCodexConnectionStatus(clientId),readPersonalAgentNotifications(clientId),personalGoogleRequest<{actions:PersonalGoogleAction[]}>(clientId,'/actions')]);
    const agent = results[0];
    if (agent.status === 'fulfilled') {
      setRequiresSignIn(false);
      setSnapshot(agent.value);
      if (!profileDirty.current) {
        setProfileDraft(agent.value.profile);
      }
    } else {
      setRequiresSignIn(agent.reason?.status === 401);
      showError(agent.reason instanceof Error ? agent.reason.message : t('personalAgentLoadFailed'));
    }
    if(results[2].status==='fulfilled')setPendingNotifications(results[2].value.unread);
    if(results[3].status==='fulfilled')setPendingReviews(results[3].value.actions.filter(action=>action.status==='awaiting_review').length);
    const codex = results[1];
    setConnection(codex.status === 'fulfilled' ? codex.value : null);
    setIsLoading(false);
  }, [clientId, showError, t]);

  React.useEffect(()=>{if(tab === 'goals' || tab === 'activity')void refresh();},[tab,refresh]);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const rooms = React.useMemo(() => sortRoomsByLastActivityDesc((snapshot?.rooms ?? []).map(room => {
    const updated = roomUpdates.find(item => item.id === room.id);
    return updated ? {...room,...pickNewerRoom(updated, room)} : room;
  })), [roomUpdates, snapshot]);
  const mainRoom = rooms.find(room => room.id === snapshot?.profile.mainRoomId);
  React.useEffect(()=>{if(mainRoom && !selectedRoomId && !selectingMain.current){selectingMain.current=true;(onMainRoomSelect || onRoomSelect)(mainRoom);}},[mainRoom,selectedRoomId,onMainRoomSelect,onRoomSelect]);
  const activeTask=rooms.find(room=>room.personalAgentTaskStatus==='waiting_input' || room.personalAgentTaskStatus==='waiting_review') || rooms.find(room=>room.personalAgentTaskStatus==='running');
  const agentStatus=activeTask?activeTask.personalAgentTaskStatus==='waiting_review'?t('personalSourceReadyReview',{title:activeTask.name}):activeTask.personalAgentTaskStatus==='waiting_input'?t('personalSourceNeedsInput',{title:activeTask.name}):activeTask.personalAgentTaskPlan?.find(step=>step.status==='in_progress')?.step || activeTask.name:rooms.some(room=>room.personalAgentTaskStatus==='queued' && room.personalAgentTaskKind)?t('personalSourcePickingUp'):t('personalSourceHere');

  const isConnected = connection?.status === 'connected';

  const mutate = async (action: AgentAction) => {
    if (isBusy) return;
    setIsBusy(true);
    try { await action(); } catch (error) {
      showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed'));
    } finally { setIsBusy(false); }
  };

  const editProfile = (changes: Partial<PersonalAgentProfile>) => {
    profileDirty.current = true;
    setProfileDraft(previous => previous ? { ...previous, ...changes } : previous);
  };

  if (isLoading) return <div className="flex h-full w-full items-center justify-center"><Spinner label={t('personalAgentLoading')} color="secondary" /></div>;
  if (!snapshot || !profileDraft) return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
      <span className="text-4xl" aria-hidden="true">🦊</span>
      <p className={mutedClass}>{t('personalAgentLoadFailed')}</p>
      {requiresSignIn && <><p className={`max-w-md text-center text-sm ${mutedClass}`}>{t('personalAgentSignInHint')}</p><Button color="secondary" onPress={onOpenConnections}>{t('settings')}</Button></>}
      <Button onPress={() => { setIsLoading(true); void refresh(); }}>{t('retry')}</Button>
    </div>
  );

  return (
    <div className="personal-agent-theme flex h-full min-h-0 w-full flex-col bg-background text-[#11191c] dark:text-default-800" style={{paddingTop:'env(safe-area-inset-top)',paddingBottom:'env(safe-area-inset-bottom)'}} data-testid="personal-agent-view">
      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
        <header className="relative mx-5 h-[122px] shrink-0 pt-0.5 sm:h-[146px] sm:pt-3.5">
          <Button isIconOnly size="sm" variant="light" className="absolute left-0 top-4" aria-label={t('personalAgentConversations')} onPress={()=>setThreadsOpen(true)}><Icon icon="lucide:menu" className="h-5 w-5"/></Button>
          <button type="button" className="mx-auto flex max-w-[70%] flex-col items-center gap-1" onClick={()=>setTab('activity')} aria-label={t('personalSourceOpenActivity',{name:snapshot.profile.name})}>
            <span className={`flex h-[49px] w-[49px] items-center justify-center rounded-full text-3xl sm:h-[58px] sm:w-[58px] ${snapshot.profile.avatar==='sand'?'bg-[#ece4d7]':snapshot.profile.avatar==='lilac'?'bg-[#e7e1f1]':'bg-[#d9e9f4]'}`} aria-hidden="true">🦊</span>
            <span className="text-base font-semibold tracking-[-0.4px]">{snapshot.profile.name}</span><span className="max-w-full truncate text-[11px] text-default-500">{agentStatus}</span>
          </button>
          {tab==='chats' && <div className="mt-1 text-center"><Button size="sm" variant="flat" className="h-6 rounded-full text-xs" onPress={()=>{setComputerTab(undefined);setComputerOpen(true);}} startContent={<Icon icon="lucide:monitor"/>}>{t('personalAgentComputer')}</Button></div>}
          <div className="absolute right-0 top-4"><Button isIconOnly size="sm" variant="light" aria-label={t('personalUpdates')} onPress={()=>setNotificationsOpen(true)}><Icon icon="lucide:bell" className="h-5 w-5"/></Button>{pendingNotifications+pendingReviews>0 && <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1.5 h-1.5 w-1.5 rounded-full bg-[#527d99]"/>}</div>
        </header>
        <div className={`min-h-0 flex-1 overflow-y-auto pb-4 sm:px-[42px] ${tab==='chats'?'px-[17px]':'px-[22px]'}`} data-testid="personal-agent-content">
        {(['files','memory','tracking','mail','calendar'] as AgentTab[]).includes(tab) && <Button size="sm" variant="light" className="mb-[18px]" onPress={()=>setTab('apps')} startContent={<Icon icon="lucide:arrow-left" />}>{t('personalAgentBackToApps')}</Button>}
        {tab!=='chats' && <h2 className="mb-[22px] text-[25px] font-semibold">{t(tab==='activity'?'personalAgentActivity':tab==='ideas'?'personalAgentIdeas':tab==='goals'?'personalAgentGoals':tab==='apps'?'personalAgentApps':tab==='mail'?'personalGoogleMail':tab==='calendar'?'personalGoogleCalendar':tab==='files'?'personalAgentFiles':tab==='tracking'?'personalAgentTracking':'personalAgentPersonalityMemory')}</h2>}
        {conversation && tab === 'chats' ? <div className="h-full min-h-0">{conversation(()=>setThreadsOpen(true),tab=>{setComputerTab(tab);setComputerOpen(true);},(target,mail)=>{setInitialMail(mail);setTab(target);})}</div> : <div className="space-y-5">
        {tab === 'apps' && <section className="space-y-5">
          <Input variant="bordered" labelPlacement="outside" label={t('personalAgentSearchApps')} placeholder={t('personalAppsSearchConnectors')} value={appSearch} onValueChange={setAppSearch} />
          {!isConnected && !appSearch.trim() && <div className={`${panelClass} flex items-center gap-3 p-4`}><span className="text-2xl" aria-hidden="true">🦊</span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{t('personalAgentConnection')}</p><p className={`text-xs ${mutedClass}`}>{t(isConnected ? 'codexConnectionStatusConnected' : 'personalAgentConnectionHint')}</p></div>{!isConnected && <Button size="sm" onPress={onOpenConnections}>{t('personalAgentConnectAccount')}</Button>}</div>}
          <PersonalAgentConnections clientId={clientId} query={appSearch} onOpen={setTab} computerAvailable={isConnected} onComputer={()=>{setComputerTab(undefined);setComputerOpen(true);}} showError={showError} />
          <h3 className="text-sm font-semibold">{t('personalAgentOnComputer')}</h3>
          <div className={`${panelClass} divide-y divide-default-200 overflow-hidden`}>{[
            {key:'mail' as const,title:'personalGoogleMail',detail:'personalAgentMailShortcut',icon:'lucide:mail'},
            {key:'calendar' as const,title:'personalGoogleCalendar',detail:'personalAgentCalendarShortcut',icon:'lucide:calendar-days'},
            {key:'computer' as const,title:'personalComputerTitle',detail:'personalAppsBrowserDetail',icon:'lucide:globe'},
            {key:'files' as const,title:'personalAgentFiles',detail:'personalAppsFilesDetail',icon:'lucide:file-text'},
            {key:'memory' as const,title:'personalAgentPersonalityMemory',detail:'personalAgentMemoryDescription',icon:'lucide:brain'},
          ].filter(item=>`${t(item.title)} ${t(item.detail)}`.toLowerCase().includes(appSearch.toLowerCase())).map(item=><button key={item.key} type="button" onClick={()=>{if(item.key==='computer'){setComputerTab(undefined);setComputerOpen(true);}else setTab(item.key);}} className="flex w-full items-center gap-3 p-4 text-left"><Icon icon={item.icon} className="h-5 w-5 shrink-0" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(item.title)}</span><span className={`mt-1 block text-xs ${mutedClass}`}>{t(item.detail)}</span></span><Icon icon="lucide:chevron-right" /></button>)}</div>
        </section>}


        {tab === 'mail' && <PersonalAgentMail initialMail={initialMail} onMailOpened={()=>setInitialMail(undefined)} clientId={clientId} showError={showError} onOpenFiles={()=>setTab('files')} />}
        {tab === 'calendar' && <PersonalAgentCalendar clientId={clientId} />}
        {tab === 'files' && <PersonalAgentFiles key={clientId} clientId={clientId} initialFileId={fileId} showError={showError} />}
        {tab === 'tracking' && <PersonalAgentTracking key={clientId} clientId={clientId} showError={showError} showSuccess={showSuccess} onTask={setTaskId} />}

        {tab === 'chats' && <div className="flex min-h-48 items-center justify-center"><Spinner label={t('personalAgentLoading')}/></div>}

        {tab === 'ideas' && <PersonalAgentIdeas key={clientId} clientId={clientId} ideas={snapshot.ideas} rooms={rooms} isConnected={isConnected}
          onRoomSelect={onRoomSelect} onIdeasChange={ideas => setSnapshot(previous => previous ? { ...previous, ideas } : previous)}
          onIdeaChange={idea => setSnapshot(previous => previous ? { ...previous, ideas: previous.ideas.map(value => value.id === idea.id ? idea : value) } : previous)}
          onIdeasAppend={ideas => setSnapshot(previous => previous ? { ...previous, ideas: [...previous.ideas, ...ideas.filter(idea => !previous.ideas.some(value => value.id === idea.id))] } : previous)}
          showSuccess={showSuccess} showError={showError} />}

        {tab === 'goals' && <><PersonalAgentTracking key={`${clientId}:goals`} clientId={clientId} showError={showError} showSuccess={showSuccess} onTask={setTaskId} /><PersonalAgentGoals clientId={clientId} goals={snapshot.goals} rooms={rooms} isConnected={isConnected}
          onRoomSelect={onRoomSelect} onGoalsChange={goals => setSnapshot(previous => previous ? { ...previous, goals } : previous)}
          showSuccess={showSuccess} showError={showError} /></>}

        {tab === 'activity' && <PersonalAgentActivity clientId={clientId} rooms={rooms} onTask={setTaskId} showError={showError}/>}

        {tab === 'memory' && <section className="space-y-5">
          <div id="personal-personality-memory" className="space-y-5">{!editingProfile ? <section className={`${panelClass} space-y-4 p-5 sm:p-6`} data-testid="personal-agent-profile-summary">
            <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{t('personalAgentYourAgent')}</h3><Button size="sm" variant="light" onPress={()=>{profileDirty.current=false;setProfileDraft(snapshot.profile);setEditingProfile(true);}}>{t('edit')}</Button></div>
            <div className="flex items-center gap-3"><span className={`flex h-16 w-16 items-center justify-center rounded-full text-4xl ${snapshot.profile.avatar==='sand'?'bg-[#ece4d7]':snapshot.profile.avatar==='lilac'?'bg-[#e7e1f1]':'bg-[#d9e9f4]'}`} aria-hidden="true">🦊</span><span className="text-lg font-medium">{snapshot.profile.name}</span><span className="text-xs text-default-500">{t(`personalTone_${snapshot.profile.tone || 'warm'}`)}</span></div>
            <p className="text-xs text-default-500">{t('personalShowUpdates')}: {t(snapshot.profile.showUpdates !== false ? 'personalPreferenceOn' : 'personalPreferenceOff')}</p>
          </section> : <form className={`${panelClass} space-y-5 p-5 sm:p-6`} onSubmit={event => { event.preventDefault(); void mutate(async () => {
          const { profile } = await updatePersonalAgentProfile(clientId, profileDraft, profileDraft.updatedAt);
          profileDirty.current = false;
          setSnapshot(previous => previous ? { ...previous, profile } : previous);
          setProfileDraft(profile);
          setEditingProfile(false);
          showSuccess(t('personalAgentProfileSaved'));
        }); }}>
          <h3 className="text-base font-semibold">{t('personalAgentYourAgent')}</h3>
          <div className="flex justify-center gap-4" role="radiogroup" aria-label={t('personalAgentAvatar')}>{(['sky','sand','lilac'] as const).map(avatar=><button key={avatar} type="button" role="radio" aria-label={t(`personalAvatar_${avatar}`)} aria-checked={profileDraft.avatar===avatar} onClick={()=>editProfile({avatar})} className={`rounded-3xl p-2 ${profileDraft.avatar===avatar?'ring-2 ring-secondary':''}`}><span className={`flex h-16 w-16 items-center justify-center rounded-full text-4xl ${avatar==='sky'?'bg-[#d9e9f4]':avatar==='sand'?'bg-[#ece4d7]':'bg-[#e7e1f1]'}`}>🦊</span></button>)}</div>
          <Input variant="bordered" labelPlacement="outside" label={t('personalAgentName')} value={profileDraft.name} maxLength={100} isRequired onValueChange={name=>editProfile({name})}/>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('personalAgentTone')}>{(['warm','concise','thoughtful'] as const).map(tone=><Button key={tone} size="sm" variant={profileDraft.tone === tone || (!profileDraft.tone && tone === 'warm') ? 'flat' : 'light'} aria-pressed={profileDraft.tone === tone || (!profileDraft.tone && tone === 'warm')} onPress={()=>editProfile({tone})}>{t(`personalTone_${tone}`)}</Button>)}</div>
          <div className="space-y-3">
            <Checkbox isSelected={profileDraft.showUpdates !== false} onValueChange={showUpdates => editProfile({ showUpdates })}>{t('personalShowUpdates')}</Checkbox>
            <p className="text-xs text-default-500">{t('personalNotificationPreferencesHint')}</p>
          </div>
          <Button variant="light" onPress={()=>{profileDirty.current=false;setProfileDraft(snapshot.profile);setEditingProfile(false);}}>{t('cancel')}</Button>
          <Button type="submit" color="secondary" isLoading={isBusy} isDisabled={!profileDraft.name.trim() || !profileDraft.avatar.trim()}>{t('save')}</Button>
        </form>}
            <PersonalAgentMemory clientId={clientId} rooms={rooms} onRoomSelect={onRoomSelect} showError={showError} showSuccess={showSuccess} />
          </div>
        </section>}
        </div>}
        </div>
        <PersonalAgentChats clientId={clientId} rooms={rooms} mainRoom={mainRoom} selectedRoomId={selectedRoomId} isOpen={threadsOpen} onClose={()=>setThreadsOpen(false)} onRoomSelect={onRoomSelect}
          onRoomUpdated={room=>setSnapshot(previous=>previous?{...previous,rooms:previous.rooms.some(item=>item.id===room.id)?previous.rooms.map(item=>item.id===room.id?room:item):[...previous.rooms,room]}:previous)}
          onNavigate={setTab} onDelegate={()=>setDelegateOpen(true)} onComputer={()=>{setComputerTab(undefined);setComputerOpen(true);}} onRefresh={()=>void refresh()} onBack={onBack} showSuccess={showSuccess} showError={showError}/>
        <PersonalAgentComputer clientId={clientId} mainRoomId={selectedRoomId || snapshot.profile.mainRoomId} available={isConnected} initialTab={computerTab} isOpen={computerOpen} onClose={()=>setComputerOpen(false)} onFiles={file=>{setFileId(file?.id);setTab('files');}}/>
        <PersonalAgentDelegate clientId={clientId} isOpen={delegateOpen} onClose={()=>setDelegateOpen(false)} onTask={room=>{setSnapshot(previous=>previous?{...previous,rooms:[...previous.rooms,room]}:previous);setTaskId(room.id);}}/>
        {taskId && <PersonalAgentTaskDetailView clientId={clientId} roomId={taskId} isOpen onClose={()=>{setTaskId(undefined);void refresh();}} onSubmit={async(request,answer)=>{await answerPersonalAgentTaskInput(clientId,taskId,request.id,answer);}}/>}
        <Modal isOpen={notificationsOpen && !taskId} onClose={()=>setNotificationsOpen(false)} scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{t('personalUpdates')}</ModalHeader><ModalBody className="pb-6"><p className="text-sm text-default-500">{t('personalTaskNotificationsHint')}</p><PersonalAgentUpdates clientId={clientId} rooms={rooms} mode="list" enabled={notificationsOpen} onRoomSelect={room=>{setNotificationsOpen(false);setTaskId(room.id);}} onOpenUpdates={()=>{}} showError={showError}/></ModalBody></ModalContent></Modal>
        <nav className="shrink-0 pb-[7px] pt-[10px] sm:pb-[22px]" aria-label={t('personalAgentSections')}>
          <div className="mx-auto flex w-full max-w-[370px] rounded-[40px] border border-[#f8f8f8] bg-white p-[5px] shadow-sm dark:border-[#30302e] dark:bg-[#252522]">{tabs.map(item => {
            const active=tab===item.key || (item.key==='apps' && ['files','memory','tracking','mail','calendar'].includes(tab));
            return <button key={item.key} type="button" className={`flex h-[47px] min-w-0 flex-1 items-center justify-center rounded-[28px] ${active?'bg-[#f0f1f2] dark:bg-[#393937]':''}`} onClick={()=>setTab(item.key)} aria-label={t(item.label)} aria-current={active?'page':undefined}><Icon icon={item.icon} className="h-[23px] w-[23px]"/></button>;
          })}</div>
        </nav>
      </div>
    </div>
  );
};
