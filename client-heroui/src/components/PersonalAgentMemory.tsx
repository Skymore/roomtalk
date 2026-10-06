import React from 'react';
import { Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { createPersonalAgentThread, forgetPersonalAgentMemory, mergePersonalAgentMemories, readPersonalAgentMemories, savePersonalAgentMemory, type PersonalAgentMemory as Memory } from '../utils/personalAgent';
import { formatDate } from '../utils/formatters';
import type { Room } from '../utils/types';

interface MemoryAction { (): Promise<void> }

export const PersonalAgentMemory: React.FC<{
  clientId: string; rooms: Room[]; onRoomSelect: (room: Room) => void;
  showError: (message: string) => void; showSuccess: (message: string) => void;
}> = ({ clientId, rooms, onRoomSelect, showError, showSuccess }) => {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = React.useState<Memory[]>([]);
  const [total, setTotal] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Memory>();
  const [organizing, setOrganizing] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [merging, setMerging] = React.useState<Memory[]>([]);
  const [draft, setDraft] = React.useState<Pick<Memory, 'kind' | 'title' | 'content'>>({ kind: 'preference', title: '', content: '' });
  const requestVersion = React.useRef(0);
  const load = React.useCallback(async (offset = 0) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const result = await readPersonalAgentMemories(clientId, query, offset);
      if (version === requestVersion.current) { setEntries(previous => offset ? [...previous, ...result.memories] : result.memories); setTotal(result.total); }
    } catch (error) { if (version === requestVersion.current) showError(error instanceof Error ? error.message : t('personalAgentLoadFailed')); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [clientId, query, showError, t]);
  const invalidateRequest = React.useCallback(() => { requestVersion.current++; }, []);
  React.useEffect(() => { const timeout = window.setTimeout(() => void load(), 250); return () => { window.clearTimeout(timeout); invalidateRequest(); }; }, [invalidateRequest, load]);
  const mutate = async (action: MemoryAction) => {
    if (busy) return;
    setBusy(true);
    try { await action(); await load(); }
    catch (error) { showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed')); if ((error as { status?: number }).status === 409) await load(); }
    finally { setBusy(false); }
  };
  const edit = (entry?: Memory) => { setMerging([]); setEditing(entry); setDraft(entry ? { kind: entry.kind, title: entry.title, content: entry.content } : { kind: 'preference', title: '', content: '' }); setOpen(true); };
  const selectedKind = entries.find(entry => entry.id === selected[0])?.kind;
  return <section className="space-y-4" data-testid="personal-memory-library">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-lg text-sm text-default-600">{t('personalMemoryLibraryDescription')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="light" isDisabled={busy || entries.length < 2} onPress={() => { setOrganizing(!organizing); setSelected([]); }}>{t(organizing ? 'cancel' : 'personalMemoryOrganize')}</Button>
        <Button size="sm" color="secondary" isDisabled={busy} onPress={() => edit()} startContent={<Icon icon="lucide:plus" />}>{t('personalMemoryAdd')}</Button>
      </div>
    </div>
    <Input aria-label={t('personalMemorySearch')} placeholder={t('personalMemorySearch')} value={query} onValueChange={value => { setQuery(value); setSelected([]); }} startContent={<Icon icon="lucide:search" />} isClearable onClear={() => { setQuery(''); setSelected([]); }} />
    {organizing && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-default-600">{t('personalMemorySelectRelated')}</p><Button size="sm" color="secondary" isDisabled={busy || selected.length < 2} onPress={() => {
      const notes = selected.map(id => entries.find(entry => entry.id === id)!);
      setMerging(notes); setEditing(notes[0]); setDraft({ kind: notes[0].kind, title: notes[0].title, content: notes[0].content }); setOpen(true);
    }}>{t('personalMemoryMergeSelected', { count: selected.length })}</Button></div>}
    {!loading && entries.length === 0 && <p className="rounded-2xl bg-default-100 p-6 text-sm text-default-600">{t(query ? 'personalMemoryNoResults' : 'personalMemoryEmpty')}</p>}
    {entries.map(entry => <article key={entry.id} className="rounded-2xl border border-default-200 bg-background p-5" data-testid="personal-memory-entry">
      <p className="mb-1 text-xs text-default-500">{t(`personalMemoryKind_${entry.kind}`)}</p>
      <h3 className="font-medium">{organizing ? <Checkbox isSelected={selected.includes(entry.id)} isDisabled={busy || (!selected.includes(entry.id) && (selected.length >= 20 || Boolean(selectedKind && selectedKind !== entry.kind)))} onValueChange={checked => setSelected(previous => checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id))}>{entry.title}</Checkbox> : entry.title}</h3>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{entry.content}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-default-500">
        <span>{t(entry.source === 'Remembered in conversation' ? 'personalMemoryFromChat' : 'personalMemoryFromYou')} · {formatDate(entry.updatedAt, i18n.language)}</span>
        {entry.sourceRoomId && rooms.find(room => room.id === entry.sourceRoomId) && <button type="button" className="text-secondary underline underline-offset-2" onClick={() => onRoomSelect(rooms.find(room => room.id === entry.sourceRoomId)!)}>{t('personalMemoryOpenSource')}</button>}
      </div>
      {Boolean(entry.provenance?.length) && <details className="mt-2 text-xs text-default-500"><summary className="cursor-pointer">{t('personalMemorySources', { count: entry.provenance!.length })}</summary><ul className="mt-2 space-y-2">{entry.provenance!.map((source, index) => {
        const room = rooms.find(item => item.id === source.roomId);
        return <li key={index}>{room ? <button type="button" className="text-secondary underline underline-offset-2" onClick={() => onRoomSelect(room)}>{room.name}</button> : t(source.label === 'Remembered in conversation' ? 'personalMemoryFromChat' : 'personalMemoryFromYou')} · {formatDate(source.recordedAt, i18n.language)}</li>;
      })}</ul></details>}
      {!organizing && <div className="mt-3 flex flex-wrap gap-2">
        {entry.kind === 'topic' && <Button size="sm" variant="flat" color="secondary" isDisabled={busy} onPress={() => void mutate(async () => { const { room } = await createPersonalAgentThread(clientId, entry.title.slice(0, 100), entry.id); onRoomSelect(room); })}>{t('personalMemoryContinueTopic')}</Button>}
        <Button size="sm" variant="light" isDisabled={busy} onPress={() => edit(entry)}>{t('edit')}</Button><Button size="sm" variant="light" color="danger" isDisabled={busy} onPress={() => void mutate(async () => { await forgetPersonalAgentMemory(clientId, entry); showSuccess(t('personalMemoryForgotten')); })}>{t('personalMemoryForget')}</Button>
      </div>}
    </article>)}
    {entries.length < total && <Button variant="light" isLoading={loading} onPress={() => void load(entries.length)}>{t('loadMore')}</Button>}
    <Modal isOpen={open} onOpenChange={setOpen} scrollBehavior="inside"><ModalContent><ModalHeader>{t(merging.length ? 'personalMemoryMerge' : editing ? 'personalMemoryEdit' : 'personalMemoryAdd')}</ModalHeader><ModalBody>
      {merging.length ? <><p className="text-sm text-default-600">{t('personalMemoryMergeHint')}</p>{merging.map(entry => <details key={entry.id} className="rounded-xl bg-default-100 p-3"><summary className="cursor-pointer font-medium">{entry.title}</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.content}</p></details>)}</> : <Select label={t('personalMemoryKind')} selectedKeys={[draft.kind]} onSelectionChange={keys => { const kind = Array.from(keys)[0]; if (kind === 'preference' || kind === 'fact' || kind === 'topic') setDraft({ ...draft, kind }); }}>{(['preference', 'fact', 'topic'] as const).map(kind => <SelectItem key={kind}>{t(`personalMemoryKind_${kind}`)}</SelectItem>)}</Select>}
      <Input autoFocus label={t('personalMemoryTitle')} value={draft.title} maxLength={200} onValueChange={title => setDraft({ ...draft, title })} />
      <Textarea label={t('personalMemoryContent')} description={draft.kind === 'topic' ? t('personalMemoryTopicHint') : undefined} placeholder={draft.kind === 'topic' ? t('personalMemoryTopicTemplate') : undefined} value={draft.content} minRows={5} maxLength={8000} onValueChange={content => setDraft({ ...draft, content })} />
    </ModalBody><ModalFooter><Button variant="light" onPress={() => setOpen(false)}>{t('cancel')}</Button><Button color="secondary" isLoading={busy} isDisabled={!draft.title.trim() || !draft.content.trim()} onPress={() => void mutate(async () => {
      if (merging.length) { await mergePersonalAgentMemories(clientId, draft, merging); setSelected([]); setOrganizing(false); }
      else await savePersonalAgentMemory(clientId, draft, editing);
      setOpen(false); showSuccess(t('personalMemorySaved'));
    })}>{t('save')}</Button></ModalFooter></ModalContent></Modal>
  </section>;
};
