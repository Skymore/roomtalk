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
import {Button,Input,Modal,ModalBody,ModalContent,ModalHeader} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {createPersonalAgentThread,updatePersonalAgentThread} from '../utils/personalAgent';
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
  return <Modal isOpen={isOpen} onClose={onClose} placement="top" scrollBehavior="inside" size="lg" classNames={{base:'max-h-[90dvh] bg-white dark:bg-[#252522]'}}><ModalContent className="personal-agent-theme"><ModalHeader>{t('personalAgentConversations')}</ModalHeader><ModalBody><div className="space-y-4 pb-6">
    <button type="button" className="flex items-center gap-3 py-3 text-left" disabled={!mainRoom} onClick={()=>{if(mainRoom)select(mainRoom);}}><Icon icon="lucide:message-circle" className="h-5 w-5"/><span><span className="block text-sm font-semibold">{t('personalAgentMainChat')}</span><span className="text-xs text-default-500">{t('personalAgentMainChatDescription')}</span></span></button>
    <Button color="secondary" isLoading={busy} startContent={<Icon icon="lucide:plus"/>} onPress={()=>{void mutate(async()=>{const {room}=await createPersonalAgentThread(clientId,t('personalAgentSideChat'));onRoomUpdated(room);select(room);});}}>{t('personalAgentNewSideChat')}</Button>
    <div className="flex items-center justify-between pt-3"><h3 className="text-base font-semibold">{t('personalAgentSideChats')}</h3><Button size="sm" variant="light" onPress={()=>{setArchived(!archived);setLimit(20);}}>{t(archived?'personalAgentShowActiveChats':'personalAgentArchivedChats')}</Button></div>
    {threads.slice(0,limit).map(room=><article key={room.id} data-testid="personal-agent-chat-card" className="space-y-3 border-b border-default-200 py-3">
      <button type="button" aria-label={`${t('personalAgentOpenConversation')}: ${room.name}`} aria-current={room.id===selectedRoomId?'true':undefined} className="flex w-full items-center gap-3 text-left" onClick={()=>select(room)}><Icon icon="lucide:message-circle" className="h-5 w-5 shrink-0"/><span className="break-words text-sm">{room.name}</span></button>
      {editing===room.id && <Input label={t('personalAgentConversationName')} value={name} onValueChange={setName} maxLength={100}/>}
      <div className="flex gap-2"><Button size="sm" variant="flat" isDisabled={busy || (editing===room.id && !name.trim())} onPress={()=>{if(editing===room.id){void mutate(async()=>{const {room:updated}=await updatePersonalAgentThread(clientId,room.id,{name:name.trim()});onRoomUpdated(updated);showSuccess(t('personalAgentConversationRenamed'));});}else{setEditing(room.id);setName(room.name);}}}>{t(editing===room.id?'personalAgentSaveName':'personalAgentRenameChat')}</Button>
        <Button size="sm" variant="light" isDisabled={busy} startContent={<Icon icon="lucide:archive"/>} onPress={()=>{void mutate(async()=>{const {room:updated}=await updatePersonalAgentThread(clientId,room.id,{archived:!room.personalAgentArchivedAt});onRoomUpdated(updated);showSuccess(t(updated.personalAgentArchivedAt?'personalAgentConversationArchived':'personalAgentConversationRestored'));});}}>{t(archived?'personalAgentRestoreChat':'personalAgentArchiveChat')}</Button></div>
    </article>)}
    {!threads.length && <p className="text-sm text-default-500">{t(archived?'personalAgentNoArchivedChats':'personalAgentSideChatHint')}</p>}
    {threads.length>limit && <Button size="sm" variant="light" onPress={()=>setLimit(limit+20)}>{t('personalAgentMoreChats')}</Button>}
    <p className="text-xs text-default-500">{t('personalAgentSharedMemoryHint')}</p>
    <div className="border-t border-default-200 pt-3">{[
      {key:'delegate',title:'personalDelegateTask',icon:'lucide:plus',action:onDelegate},
      {key:'computer',title:'personalAgentComputer',icon:'lucide:monitor',action:onComputer},
      {key:'calendar',title:'personalGoogleCalendar',icon:'lucide:calendar-days',action:()=>onNavigate('calendar')},
      {key:'files',title:'personalAgentFiles',icon:'lucide:file-text',action:()=>onNavigate('files')},
      {key:'apps',title:'personalAgentAppsSettings',icon:'lucide:settings',action:()=>onNavigate('apps')},
    ].map(item=><button key={item.key} type="button" className="flex w-full items-center gap-3 py-3 text-left text-sm" onClick={()=>{onClose();item.action();}}><Icon icon={item.icon} className="h-5 w-5"/>{t(item.title)}</button>)}</div>
    <Button size="sm" variant="light" startContent={<Icon icon="lucide:refresh-cw"/>} onPress={onRefresh}>{t('personalAgentRefreshWorkspace')}</Button>
    {onBack && <Button size="sm" variant="light" onPress={()=>{onClose();onBack();}} startContent={<Icon icon="lucide:arrow-left"/>}>RoomTalk</Button>}
  </div></ModalBody></ModalContent></Modal>;
};
