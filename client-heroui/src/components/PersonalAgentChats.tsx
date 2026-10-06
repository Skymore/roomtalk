import React from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { createPersonalAgentThread, updatePersonalAgentThread } from '../utils/personalAgent';
import { formatDate } from '../utils/formatters';
import { getRoomActivityAt } from '../utils/roomState';
import type { Room } from '../utils/types';

interface PersonalAgentChatsProps {
  clientId: string;
  rooms: Room[];
  mainRoom?: Room;
  onRoomSelect: (room: Room) => void;
  onRoomUpdated: (room: Room) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}
interface ChatAction { (): Promise<void> }

const panelClass = 'rounded-2xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const mutedClass = 'text-[#5e5d59] dark:text-[#b0aea5]';

export const PersonalAgentChats: React.FC<PersonalAgentChatsProps> = ({ clientId, rooms, mainRoom, onRoomSelect, onRoomUpdated, showSuccess, showError }) => {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [archived, setArchived] = React.useState(false);
  const [limit, setLimit] = React.useState(20);
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Room | null>(null);
  const [name, setName] = React.useState('');
  const [isBusy, setIsBusy] = React.useState(false);
  const matchingRooms = rooms.filter(room => room.id !== mainRoom?.id && room.personalAgentThreadKind === 'task'
    && Boolean(room.personalAgentArchivedAt) === archived && room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const mutate = async (action: ChatAction) => {
    if (isBusy) return;
    setIsBusy(true);
    try { await action(); } catch (error) { showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed')); }
    finally { setIsBusy(false); }
  };
  const openName = (room?: Room) => { setEditing(room ?? null); setName(room?.name ?? ''); setIsModalOpen(true); };
  const saveName = () => { void mutate(async () => {
    if (editing) {
      const { room } = await updatePersonalAgentThread(clientId, editing.id, { name: name.trim() });
      onRoomUpdated(room);
      showSuccess(t('personalAgentConversationRenamed'));
    } else {
      const { room } = await createPersonalAgentThread(clientId, name.trim());
      onRoomUpdated(room);
      onRoomSelect(room);
    }
    setIsModalOpen(false);
  }); };
  const setRoomArchived = (room: Room) => { void mutate(async () => {
    const { room: updated } = await updatePersonalAgentThread(clientId, room.id, { archived: !room.personalAgentArchivedAt });
    onRoomUpdated(updated);
    showSuccess(t(updated.personalAgentArchivedAt ? 'personalAgentConversationArchived' : 'personalAgentConversationRestored'));
  }); };

  return <div className="space-y-6">
    <section className={`${panelClass} p-6 sm:p-8`}>
      <Icon icon="lucide:message-circle" className="mb-4 h-7 w-7 text-secondary" />
      <h3 className="font-serif text-2xl">{t('personalAgentMainChat')}</h3>
      <p className={`mt-2 max-w-xl text-sm leading-6 ${mutedClass}`}>{t('personalAgentMainChatDescription')}</p>
      <Button color="secondary" className="mt-5" isDisabled={!mainRoom} onPress={() => { if (mainRoom) onRoomSelect(mainRoom); }} endContent={<Icon icon="lucide:arrow-right" className="h-4 w-4" />}>{t('personalAgentOpenMainChat')}</Button>
    </section>
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t('personalAgentTaskChats')}</h3>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="light" onPress={() => { setArchived(!archived); setLimit(20); }} aria-pressed={archived}>{t(archived ? 'personalAgentShowActiveChats' : 'personalAgentArchivedChats')}</Button>
          <Button size="sm" variant="flat" color="secondary" onPress={() => openName()} startContent={<Icon icon="lucide:plus" className="h-4 w-4" />}>{t('personalAgentNewTask')}</Button>
        </div>
      </div>
      <Input aria-label={t('personalAgentSearchChats')} placeholder={t('personalAgentSearchChats')} value={query} onValueChange={value => { setQuery(value); setLimit(20); }} startContent={<Icon icon="lucide:search" className="h-4 w-4 text-default-500" />} />
      {archived && <p className={`text-xs ${mutedClass}`}>{t('personalAgentArchiveDescription')}</p>}
      {matchingRooms.length === 0 ? <p className={`${panelClass} p-6 text-sm ${mutedClass}`}>{t(query.trim() ? 'personalAgentNoMatchingChats' : archived ? 'personalAgentNoArchivedChats' : 'personalAgentNoTasks')}</p> : <div className="grid gap-3 sm:grid-cols-2">
        {matchingRooms.slice(0, limit).map(room => <article key={room.id} data-testid="personal-agent-chat-card" className={`${panelClass} space-y-3 p-4`}>
          <button type="button" className="block w-full min-w-0 text-left" onClick={() => onRoomSelect(room)}>
            <span className="block truncate text-sm font-medium">{room.name}</span>
            <span className={`mt-2 flex items-center gap-1.5 text-xs ${mutedClass}`}><Icon icon={room.codeAgentStatus === 'running' ? 'lucide:loader-circle' : 'lucide:message-square'} className={`h-3.5 w-3.5 ${room.codeAgentStatus === 'running' ? 'animate-spin' : ''}`} />{t(room.codeAgentStatus === 'running' ? 'personalAgentWorking' : room.codeAgentStatus === 'error' ? 'personalAgentNeedsAttention' : 'personalAgentConversationUpdated')}</span>
            <span className={`mt-1 block text-xs ${mutedClass}`}>{formatDate(getRoomActivityAt(room), i18n.language)}</span>
          </button>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => openName(room)}>{t('personalAgentRenameChat')}</Button>
            <Button size="sm" variant="light" isDisabled={isBusy} onPress={() => setRoomArchived(room)} startContent={<Icon icon={archived ? 'lucide:archive-restore' : 'lucide:archive'} className="h-3.5 w-3.5" />}>{t(archived ? 'personalAgentRestoreChat' : 'personalAgentArchiveChat')}</Button>
          </div>
        </article>)}
      </div>}
      {matchingRooms.length > limit && <Button size="sm" variant="light" onPress={() => setLimit(limit + 20)}>{t('personalAgentMoreChats')}</Button>}
    </section>
    <Modal isOpen={isModalOpen} onOpenChange={setIsModalOpen}>
      <ModalContent><ModalHeader>{t(editing ? 'personalAgentRenameChat' : 'personalAgentNewTask')}</ModalHeader><ModalBody><Input autoFocus label={t('personalAgentTaskName')} value={name} maxLength={100} onValueChange={setName} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && name.trim()) { event.preventDefault(); saveName(); } }} /></ModalBody><ModalFooter>
        <Button variant="light" onPress={() => setIsModalOpen(false)}>{t('cancel')}</Button>
        <Button color="secondary" isLoading={isBusy} isDisabled={!name.trim()} onPress={saveName}>{t(editing ? 'save' : 'personalAgentStartTask')}</Button>
      </ModalFooter></ModalContent>
    </Modal>
  </div>;
};
