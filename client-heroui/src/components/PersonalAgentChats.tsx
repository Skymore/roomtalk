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

Ported from OpenMuse ThreadsSheet in threads.tsx (73a7149).
*/
import React from 'react';
import {Button,Dropdown,DropdownTrigger,DropdownMenu,DropdownItem,Input,Modal,ModalBody,ModalContent,ModalHeader} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {createPersonalAgentThread,updatePersonalAgentThread,generatePersonalAgentChatTitle} from '../utils/personalAgent';
import type {Room} from '../utils/types';
interface ChatAction { ():Promise<void> }
interface PersonalAgentChatsProps {
  clientId:string;rooms:Room[];mainRoom?:Room;selectedRoomId?:string|null;isOpen:boolean;onClose:()=>void;
  onRoomSelect:(room:Room)=>void;onRoomUpdated:(room:Room)=>void;
  onNavigate:(section:'calendar'|'files'|'apps')=>void;onDelegate:()=>void;onComputer:()=>void;onRefresh:()=>void;onBack?:()=>void;
  showSuccess:(message:string)=>void;showError:(message:string)=>void;
}
export const PersonalAgentChats:React.FC<PersonalAgentChatsProps>=({clientId,rooms,mainRoom,selectedRoomId,isOpen,onClose,onRoomSelect,onRoomUpdated,onNavigate,onDelegate,onComputer,onRefresh,onBack,showSuccess,showError})=>{
  const {t}=useTranslation();
  const [archived,setArchived]=React.useState(false),[editing,setEditing]=React.useState<string>(),[name,setName]=React.useState(''),[limit,setLimit]=React.useState(20),[busy,setBusy]=React.useState(false);
  const threads=rooms.filter(room=>room.id!==mainRoom?.id && room.personalAgentThreadKind==='task' && !room.personalAgentTaskKind && !room.personalAgentGoalId && Boolean(room.personalAgentArchivedAt)===archived);
  const mutate=async(action:ChatAction)=>{setBusy(true);try{await action();setEditing(undefined);}catch(error){showError(error instanceof Error?error.message:t('personalAgentUpdateFailed'));}finally{setBusy(false);}};
  const select=(room:Room)=>{onRoomSelect(room);onClose();};
  const titleRequests = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!isOpen) return;
    for (const room of threads.filter(item => item.personalAgentAutoTitle)) {
      if (titleRequests.current.has(room.id)) continue;
      titleRequests.current.add(room.id);
      void generatePersonalAgentChatTitle(clientId, room.id).then(({room: updated}) => onRoomUpdated(updated))
        .catch(() => titleRequests.current.delete(room.id));
    }
  }, [isOpen, threads, clientId, onRoomUpdated]);
  const rowClass = 'flex min-h-12 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm transition-colors hover:bg-content3/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-secondary';
  return <Modal isOpen={isOpen} onClose={onClose} placement="top" scrollBehavior="inside" size="lg" classNames={{base:'mx-3 my-4 max-h-[85dvh] rounded-[24px] bg-content1',header:'px-5 pb-3 pt-5',body:'px-4 pb-5 shrink min-h-0'}}><ModalContent className="personal-agent-theme"><ModalHeader>{t('personalAgentConversations')}</ModalHeader><ModalBody><div className="space-y-5">
    <div className="rounded-[24px] bg-content2 p-1">
      <button type="button" aria-current={mainRoom?.id===selectedRoomId?'true':undefined} className={`${rowClass} ${mainRoom?.id===selectedRoomId?'bg-content3/60':''}`} disabled={!mainRoom} onClick={()=>{if(mainRoom)select(mainRoom);}}><Icon icon="lucide:message-circle" className="h-5 w-5 shrink-0"/><span className="min-w-0 flex-1"><span className="block font-medium">{t('personalAgentMainChat')}</span><span className="block text-xs text-default-500">{t('personalAgentMainChatDescription')}</span></span>{mainRoom?.id===selectedRoomId && <Icon icon="lucide:check" className="h-4 w-4 text-secondary"/>}</button>
      <Button variant="light" className="h-12 w-full justify-start gap-3 rounded-2xl px-3 text-secondary" isLoading={busy} startContent={<Icon icon="lucide:plus" className="h-5 w-5"/>} onPress={()=>{void mutate(async()=>{const {room}=await createPersonalAgentThread(clientId,t('personalAgentSideChat'));onRoomUpdated(room);select(room);});}}>{t('personalAgentNewSideChat')}</Button>
    </div>
    <section className="space-y-2">
      <div className="flex items-center justify-between px-3"><h3 className="text-xs font-medium text-default-500">{t('personalAgentSideChats')}</h3><Button size="sm" variant="light" className="min-h-11 text-xs text-default-500" onPress={()=>{setArchived(!archived);setLimit(20);setEditing(undefined);}}>{t(archived?'personalAgentShowActiveChats':'personalAgentArchivedChats')}</Button></div>
      {!!threads.length && <div className="rounded-[24px] bg-content2 p-1">
      {threads.slice(0,limit).map(room=><article key={room.id} data-testid="personal-agent-chat-card">
        <div className={`flex items-center rounded-2xl ${room.id===selectedRoomId?'bg-content3/60':''}`}>
          <button type="button" aria-label={`${t('personalAgentOpenConversation')}: ${room.name}`} aria-current={room.id===selectedRoomId?'true':undefined} className={`${rowClass} min-w-0 flex-1`} onClick={()=>select(room)}><Icon icon="lucide:message-circle" className="h-5 w-5 shrink-0"/><span className="truncate font-medium">{room.name}</span>{room.id===selectedRoomId && <Icon icon="lucide:check" className="ml-auto h-4 w-4 shrink-0 text-secondary"/>}</button>
          <Dropdown placement="bottom-end"><DropdownTrigger><Button isIconOnly variant="light" className="mr-1 h-11 min-w-11" aria-label={`${t('personalAgentChatActions')}: ${room.name}`} isDisabled={busy}><Icon icon="lucide:ellipsis" className="h-5 w-5"/></Button></DropdownTrigger><DropdownMenu aria-label={t('personalAgentChatActions')}>
            <DropdownItem key="rename" startContent={<Icon icon="lucide:pencil" className="h-4 w-4"/>} onPress={()=>{setEditing(room.id);setName(room.name);}}>{t('personalAgentRenameChat')}</DropdownItem>
            <DropdownItem key="archive" startContent={<Icon icon={archived?'lucide:archive-restore':'lucide:archive'} className="h-4 w-4"/>} onPress={()=>{void mutate(async()=>{const {room:updated}=await updatePersonalAgentThread(clientId,room.id,{archived:!room.personalAgentArchivedAt});onRoomUpdated(updated);showSuccess(t(updated.personalAgentArchivedAt?'personalAgentConversationArchived':'personalAgentConversationRestored'));});}}>{t(archived?'personalAgentRestoreChat':'personalAgentArchiveChat')}</DropdownItem>
          </DropdownMenu></Dropdown>
        </div>
        {editing===room.id && <form className="space-y-2 px-3 pb-3" onSubmit={event=>{event.preventDefault();if(!name.trim() || busy)return;void mutate(async()=>{const {room:updated}=await updatePersonalAgentThread(clientId,room.id,{name:name.trim()});onRoomUpdated(updated);showSuccess(t('personalAgentConversationRenamed'));});}}>
          <Input autoFocus variant="flat" labelPlacement="outside" label={t('personalAgentConversationName')} value={name} onValueChange={setName} maxLength={100}/>
          <div className="flex justify-end gap-2"><Button size="sm" variant="light" onPress={()=>setEditing(undefined)}>{t('cancel')}</Button><Button type="submit" size="sm" color="secondary" isDisabled={busy || !name.trim()}>{t('personalAgentSaveName')}</Button></div>
        </form>}
      </article>)}
      </div>}
      {!threads.length && <p className="px-3 py-2 text-xs text-default-500">{t(archived?'personalAgentNoArchivedChats':'personalAgentSideChatHint')}</p>}
      {threads.length>limit && <Button size="sm" variant="light" onPress={()=>setLimit(limit+20)}>{t('personalAgentMoreChats')}</Button>}
      <p className="px-3 pt-1 text-xs leading-relaxed text-default-500">{t('personalAgentSharedMemoryHint')}</p>
    </section>
    <div className="rounded-[24px] bg-content2 p-1">{[
      {key:'delegate',title:'personalDelegateTask',icon:'lucide:plus',action:onDelegate},
      {key:'computer',title:'personalAgentComputer',icon:'lucide:monitor',action:onComputer},
      {key:'calendar',title:'personalGoogleCalendar',icon:'lucide:calendar-days',action:()=>onNavigate('calendar')},
      {key:'files',title:'personalAgentFiles',icon:'lucide:file-text',action:()=>onNavigate('files')},
      {key:'apps',title:'personalAgentAppsSettings',icon:'lucide:settings',action:()=>onNavigate('apps')},
    ].map(item=><button key={item.key} type="button" className={rowClass} onClick={()=>{onClose();item.action();}}><Icon icon={item.icon} className="h-5 w-5 shrink-0"/><span className="flex-1">{t(item.title)}</span><Icon icon="lucide:chevron-right" className="h-4 w-4 text-default-500"/></button>)}</div>
    <div className="flex flex-wrap items-center justify-between gap-1 px-1">
      <Button size="sm" variant="light" className="text-xs text-default-500" startContent={<Icon icon="lucide:refresh-cw" className="h-4 w-4"/>} onPress={onRefresh}>{t('personalAgentRefreshWorkspace')}</Button>
      {onBack && <Button size="sm" variant="light" className="text-xs text-default-500" onPress={()=>{onClose();onBack();}} startContent={<Icon icon="lucide:arrow-left" className="h-4 w-4"/>}>RoomTalk</Button>}
    </div>
  </div></ModalBody></ModalContent></Modal>;
};
