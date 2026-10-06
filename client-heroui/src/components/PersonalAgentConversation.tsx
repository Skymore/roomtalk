import React from 'react';
import { PersonalAgentBrowserControl } from './PersonalAgentBrowser';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { MessageList, type MessageListHandle } from './MessageList';
import { getPersonalAgent, type PersonalAgentProfile } from '../utils/personalAgent';
import { getAvatarColor, getAvatarText } from '../utils/userProfile';
import { interruptCodeAgentTurn, queueCodeAgentInput, requestCodeWorkspaceAssetUrl, requestCodeWorkspaceFile, sendMessageAndAskAI, uploadMediaMessage } from '../utils/socket';
import type { Message, Room, RoomPermissions } from '../utils/types';
import type { EnsureRoomSessionReady } from '../utils/roomSessionController';
import { apiPath } from '../utils/apiBase';
import { isWorkspaceBrowserPreviewPath, isWorkspaceImagePreviewPath } from '../utils/codeWorkspaceFilePreview';
import { useRoomTextDraft } from '../hooks/useRoomTextDraft';

export const PersonalAgentConversation: React.FC<{
  room: Room; clientId: string; username: string; roomPermissions: RoomPermissions | null;
  isRoomSessionReady: boolean; canUseRetainedRoomAccess: boolean; ensureRoomSessionReady: EnsureRoomSessionReady;
  messageSyncRequestId?: number; onRoomUpdated: (room: Room) => void; onRoomDeleted: (roomId: string) => void;
  onRoomAccessDenied: (roomId: string) => void; onBack: () => void; showError: (message: string) => void;
}> = props => {
  const { t } = useTranslation();
  const { room, clientId, username, ensureRoomSessionReady, showError } = props;
  const [profile, setProfile] = React.useState<PersonalAgentProfile>();
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [attachments, setAttachments] = React.useState<Message[]>([]);
  const list = React.useRef<MessageListHandle>(null);
  const editor = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const mounted = React.useRef(true);
  const restoreDraft = React.useCallback((value: string) => setText(value), []);
  const { saveDraft, beginDraftSend } = useRoomTextDraft(clientId, room.id, editor, restoreDraft);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { let live = true; void getPersonalAgent(clientId).then(result => { if (live) setProfile(result.profile); }).catch(error => { if (live) showError(error.message); }); return () => { live = false; }; }, [clientId, showError]);
  const running = room.codeAgentStatus === 'running';
  const canSend = props.canUseRetainedRoomAccess && Boolean(props.roomPermissions?.canPost && props.roomPermissions?.canUseCodeAgent);
  const send = async () => {
    if (!text.trim() || sending || !canSend) return;
    let clientMessageId: string | undefined;
    setSending(true);
    try {
      await ensureRoomSessionReady(room.id);
      if (!mounted.current) return;
      const content = text.trim();
      clientMessageId = crypto.randomUUID();
      const avatar = { text: getAvatarText(username), color: getAvatarColor(clientId) };
      const timestamp = new Date().toISOString();
      const message: Message = { id: clientMessageId, clientMessageId, clientId, roomId: room.id, content, timestamp,
        username, avatar, messageType: 'text', deliveryStatus: 'pending', deliveryAction: 'ask-ai' };
      list.current?.addOptimisticMessage(message);
      const completeDraft = beginDraftSend();
      if (editor.current) editor.current.textContent = '';
      setText('');
      const imageMessageIds = attachments.filter(item => item.mediaAsset?.kind === 'image').map(item => item.id);
      const params = { roomId: room.id, content, username, avatar, clientMessageId, imageMessageIds,
        codeAgentMode: 'fullAccess' as const, codexPermissionMode: 'fullAccess' as const };
      const saved = running ? await queueCodeAgentInput(params) : await sendMessageAndAskAI(params);
      completeDraft();
      if (!mounted.current) return;
      const userMessage = 'userMessage' in saved ? saved.userMessage : saved;
      list.current?.replaceOptimisticMessage(clientMessageId, userMessage);
      list.current?.scrollToBottom();
      setAttachments([]);
      if ('aiError' in saved && saved.aiError) showError(saved.aiError);
    } catch (error) {
      if (mounted.current) { const message = error instanceof Error ? error.message : t('errorSendingMessage'); if (clientMessageId) list.current?.markOptimisticMessageFailed(clientMessageId, message); showError(message); }
    } finally { if (mounted.current) setSending(false); }
  };
  const upload = async (files: File[]) => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      await ensureRoomSessionReady(room.id);
      for (const file of files) {
        if (!mounted.current) break;
        const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
        const saved = await uploadMediaMessage({ file, roomId: room.id, kind, filename: file.name, username, avatar: { text: getAvatarText(username), color: getAvatarColor(clientId) } });
        if (mounted.current) setAttachments(previous => [...previous, saved]);
      }
    } catch (error) { if (mounted.current) showError(error instanceof Error ? error.message : t('errorSendingMessage')); }
    finally { if (mounted.current) setSending(false); }
  };
  const openFile = async (path: string) => {
    try {
      await ensureRoomSessionReady(room.id);
      if (isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path)) {
        const asset = await requestCodeWorkspaceAssetUrl(room.id, path) as { relativeUrl: string };
        if (mounted.current) window.open(apiPath(asset.relativeUrl), '_blank', 'noopener,noreferrer');
      } else {
        const file = await requestCodeWorkspaceFile(room.id, path) as { content: string; encoding: 'utf-8' | 'base64'; truncated: boolean };
        if (!mounted.current) return;
        if (file.truncated) throw new Error(t('personalAgentFileTooLarge'));
        const bytes = file.encoding === 'base64' ? Uint8Array.from(atob(file.content), character => character.charCodeAt(0)) : file.content;
        const url = URL.createObjectURL(new Blob([bytes]));
        const link = document.createElement('a'); link.href = url; link.download = path.split('/').at(-1) || 'download'; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { if (mounted.current) showError(error instanceof Error ? error.message : t('personalAgentLoadFailed')); }
  };
  return <section className="flex h-full min-h-0 w-full flex-col bg-[#f7f6f2] dark:bg-[#191917]" data-testid="personal-agent-conversation">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-default-200 px-4 py-4 sm:px-8">
      <Button isIconOnly variant="light" aria-label={t('personalAgentBack')} onPress={props.onBack}><Icon icon="lucide:arrow-left" className="h-5 w-5" /></Button>
      <button type="button" className="flex min-w-0 items-center gap-3 rounded-full px-2 py-1 text-left" onClick={props.onBack} aria-label={t('personalAgentBack')}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e9e5da] text-xl dark:bg-[#34332f]">{profile?.avatar || '✦'}</span>
        <span className="min-w-0"><span className="block truncate font-medium">{profile?.name || t('personalAgent')}</span>{room.personalAgentThreadKind !== 'main' && <span className="block truncate text-xs text-default-500">{room.name}</span>}</span>
      </button>
      <Button isIconOnly variant="light" aria-label={t('personalBrowser')} isDisabled={!canSend || running} onPress={() => setBrowserOpen(true)}><Icon icon="lucide:globe" className="h-5 w-5" /></Button>
    </header>
    <div className="relative flex min-h-0 flex-1 flex-col px-1 pt-4 sm:px-6">
      <MessageList key={room.id} ref={list} roomId={room.id} room={room} currentRoom={room} presentation="personal-agent"
        roomPermissions={props.roomPermissions} isRoomSessionReady={props.isRoomSessionReady} canUseRetainedRoomAccess={props.canUseRetainedRoomAccess}
        ensureRoomSessionReady={ensureRoomSessionReady} messageSyncRequestId={props.messageSyncRequestId} onRoomUpdated={props.onRoomUpdated}
        onRoomDeleted={props.onRoomDeleted} onRoomAccessDenied={props.onRoomAccessDenied} onOpenWorkspaceFile={path => void openFile(path)} />
    </div>
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-5 pt-3 sm:px-6">
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map(item => <span key={item.id} className="flex items-center gap-1 rounded-full bg-default-100 px-3 py-1 text-xs">{item.mediaAsset?.filename || t('attachment')}<button type="button" aria-label={t('remove')} onClick={() => setAttachments(previous => previous.filter(entry => entry.id !== item.id))}><Icon icon="lucide:x" /></button></span>)}</div>}
      <div className="flex items-end gap-2 rounded-3xl border border-default-200 bg-white p-2 shadow-sm dark:bg-[#252522]">
        <input ref={fileInput} type="file" multiple className="hidden" onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <Button isIconOnly variant="light" radius="full" aria-label={t('personalAgentAttach')} isDisabled={!canSend || sending} onPress={() => fileInput.current?.click()}><Icon icon="lucide:plus" className="h-5 w-5" /></Button>
        <div ref={editor} contentEditable={canSend && !sending} role="textbox" aria-label={t('personalAgentMessageInput')} aria-multiline="true" data-testid="message-editor" data-placeholder={t('personalAgentMessagePlaceholder')}
          className="max-h-40 min-h-10 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-1 py-2 text-sm outline-none empty:before:pointer-events-none empty:before:text-default-400 empty:before:content-[attr(data-placeholder)] focus-visible:ring-2 focus-visible:ring-secondary"
          onInput={event => { const value = event.currentTarget.innerText; setText(value); saveDraft(value); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        {running && <Button isIconOnly radius="full" color="secondary" aria-label={t('personalAgentStop')} isLoading={stopping} isDisabled={!canSend} onPress={() => { setStopping(true); void ensureRoomSessionReady(room.id).then(() => interruptCodeAgentTurn(room.id)).catch(error => showError(error.message)).finally(() => { if (mounted.current) setStopping(false); }); }}><Icon icon="lucide:square" className="h-4 w-4 fill-current" /></Button>}
        {(!running || text.trim()) && <Button isIconOnly radius="full" color="secondary" aria-label={t('sendMessage')} isLoading={sending} isDisabled={!canSend || !text.trim()} onPress={() => void send()}><Icon icon="lucide:arrow-up" className="h-5 w-5" /></Button>}
      </div>
    </div>
    <PersonalAgentBrowserControl clientId={clientId} roomId={room.id} isOpen={browserOpen} onClose={() => setBrowserOpen(false)} />
  </section>;
};
