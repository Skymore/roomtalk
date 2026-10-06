import React from 'react';
import { Button, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { acceptPersonalAgentIdea, dismissPersonalAgentIdea, readPersonalAgentIdeas, refreshPersonalAgentIdeas, type PersonalAgentIdea } from '../utils/personalAgent';
import type { Room } from '../utils/types';

interface Props {
  clientId: string;
  ideas: PersonalAgentIdea[];
  rooms: Room[];
  isConnected: boolean;
  onRoomSelect: (room: Room) => void;
  onIdeasChange: (ideas: PersonalAgentIdea[]) => void;
  onIdeaChange: (idea: PersonalAgentIdea) => void;
  onIdeasAppend: (ideas: PersonalAgentIdea[]) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

const IdeaCard: React.FC<{ idea: PersonalAgentIdea; props: Props }> = ({ idea, props }) => {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [prompt, setPrompt] = React.useState(() => idea.automatic ? t('personalIdeaPlanPrompt', { title: idea.source.title }) : idea.prompt);
  const [busy, setBusy] = React.useState(false);
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const change = props.onIdeaChange;
  const accept = async () => {
    if (busy) return; setBusy(true);
    try {
      const saved = await acceptPersonalAgentIdea(props.clientId, idea, prompt);
      if (!active.current) return;
      change(saved.idea); props.onRoomSelect(saved.room);
    } catch (error) { if (active.current) props.showError(error instanceof Error ? error.message : String(error)); }
    finally { if (active.current) setBusy(false); }
  };
  const dismiss = async () => {
    if (busy) return; setBusy(true);
    try {
      const saved = await dismissPersonalAgentIdea(props.clientId, idea);
      if (!active.current) return;
      change(saved.idea); props.showSuccess(t(saved.idea.status === 'dismissed' ? 'personalIdeaDismissed' : 'personalIdeaAlreadyAccepted'));
    } catch (error) { if (active.current) props.showError(error instanceof Error ? error.message : String(error)); }
    finally { if (active.current) setBusy(false); }
  };
  const room = props.rooms.find(value => value.id === idea.source.roomId);
  return <article className="space-y-3 rounded-2xl border border-default-200 bg-white p-5 dark:bg-[#252522]" data-testid="personal-idea-card">
    <div className="flex gap-2"><Icon icon="lucide:lightbulb" className="mt-1 shrink-0 text-secondary" /><h3 className="break-words font-medium">{idea.automatic ? t('personalIdeaPlanTitle', { title: idea.title }) : idea.title}</h3></div>
    <p className="text-sm text-default-600">{idea.automatic ? t('personalIdeaPlanReason') : idea.reason}</p>
    <details className="rounded-xl bg-default-50 px-3 py-2 text-sm">
      <summary className="cursor-pointer break-words text-default-600">{t('personalIdeaSource')}: {idea.source.title}</summary>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs text-default-600">{idea.source.excerpt}</p>
      {idea.source.url && <p className="mt-1 break-all text-xs text-default-500">{idea.source.url}</p>}
      <p className="mt-2 text-xs text-default-400">{new Date(idea.source.recordedAt).toLocaleString()}</p>
      {room && <Button size="sm" variant="light" className="mt-2" onPress={() => props.onRoomSelect(room)}>{t('personalIdeaViewSource')}</Button>}
    </details>
    {editing && <Textarea label={t('personalIdeaInstructions')} value={prompt} onValueChange={setPrompt} maxLength={16000} minRows={3} isDisabled={busy} />}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" color="secondary" isDisabled={!props.isConnected || busy || !prompt.trim()} isLoading={busy} onPress={() => void accept()}>{t('personalIdeaAccept')}</Button>
      <Button size="sm" variant="light" isDisabled={busy} onPress={() => setEditing(value => !value)}>{t('personalIdeaEdit')}</Button>
      <Button size="sm" variant="light" isDisabled={busy} onPress={() => void dismiss()}>{t('personalIdeaDismiss')}</Button>
    </div>
  </article>;
};

export const PersonalAgentIdeas: React.FC<Props> = props => {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(props.ideas.length >= 50);
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const pending = props.ideas.filter(idea => idea.status === 'new');
  return <section className="space-y-4" aria-label={t('personalAgentIdeas')}>
    <div className="flex items-start justify-between gap-3">
      <p className="text-sm text-default-500">{t('personalIdeaDescription')}</p>
      <Button size="sm" variant="light" isLoading={refreshing} onPress={() => {
        if (refreshing) return; setRefreshing(true);
        void refreshPersonalAgentIdeas(props.clientId).then(saved => { if (active.current) { props.onIdeasChange(saved.ideas); setHasMore(saved.total > saved.ideas.length); } })
          .catch(error => { if (active.current) props.showError(error.message); }).finally(() => { if (active.current) setRefreshing(false); });
      }}>{t('refresh')}</Button>
    </div>
    {!pending.length && <p className="rounded-2xl bg-default-50 p-6 text-center text-sm text-default-500">{t('personalIdeaEmpty')}</p>}
    {pending.map(idea => <IdeaCard key={`${props.clientId}:${idea.id}`} idea={idea} props={props} />)}
    {hasMore && <Button variant="light" isLoading={refreshing} isDisabled={refreshing} onPress={() => {
      if (refreshing) return; setRefreshing(true);
      void readPersonalAgentIdeas(props.clientId, pending.length).then(saved => {
        if (!active.current) return;
        props.onIdeasAppend(saved.ideas); setHasMore(saved.total > pending.length + saved.ideas.length);
      }).catch(error => { if (active.current) props.showError(error.message); }).finally(() => { if (active.current) setRefreshing(false); });
    }}>{t('loadMore')}</Button>}
  </section>;
};
