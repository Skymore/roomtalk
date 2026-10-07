// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalAgentView } from './PersonalAgentView';
import type { PersonalAgentSnapshot } from '../utils/personalAgent';

const api = vi.hoisted(() => ({
  personalGoogleRequest:vi.fn(),readPersonalAgentNotifications: vi.fn(), markPersonalAgentNotificationRead: vi.fn(), readPersonalAgentWatches: vi.fn(), createPersonalAgentWatch: vi.fn(), controlPersonalAgentWatch: vi.fn(), removePersonalAgentWatch: vi.fn(),
  readPersonalAgentIdeas: vi.fn(), refreshPersonalAgentIdeas: vi.fn(), acceptPersonalAgentIdea: vi.fn(), dismissPersonalAgentIdea: vi.fn(),
  generatePersonalAgentChatTitle: vi.fn(), delegatePersonalAgentTask: vi.fn(), getPersonalAgent: vi.fn(), getCodexConnectionStatus: vi.fn(), createPersonalAgentThread: vi.fn(), updatePersonalAgentThread: vi.fn(),
  cancelPersonalAgentGoal: vi.fn(), createPersonalAgentGoal: vi.fn(), updatePersonalAgentGoal: vi.fn(), deletePersonalAgentGoal: vi.fn(),
  mergePersonalAgentMemories: vi.fn(), readPersonalAgentMemories: vi.fn(), savePersonalAgentMemory: vi.fn(), forgetPersonalAgentMemory: vi.fn(), runPersonalAgentGoal: vi.fn(), updatePersonalAgentProfile: vi.fn(),
}));
vi.mock('../utils/personalAgent', () => api);
vi.mock('../utils/codexConnection', () => api);
vi.mock('./PersonalAgentTaskDetail',()=>({PersonalAgentTaskDetailView:({roomId}:{roomId:string})=><div data-testid="source-task-detail">{roomId}</div>}));
vi.mock('react-i18next', () => { const t = (key: string) => key; return { useTranslation: () => ({ t, i18n: { language: 'en' } }) }; });
vi.mock('@iconify/react', () => ({ Icon: () => <span /> }));
vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, isDisabled, type = 'button', ...props }: Record<string, any>) => <button type={type} disabled={isDisabled} onClick={onPress} aria-label={props['aria-label']}>{children}</button>,
  Checkbox: ({ children, isSelected, isDisabled, onValueChange }: Record<string, any>) => <label><input type="checkbox" checked={isSelected} disabled={isDisabled} onChange={event => onValueChange(event.target.checked)} />{children}</label>,
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Spinner: ({ label }: { label: string }) => <span>{label}</span>,
  Input: ({ label, value, onValueChange, type, ...props }: Record<string, any>) => <label>{label}<input aria-label={label || props['aria-label']} value={value} type={type} onChange={event => onValueChange(event.target.value)} /></label>,
  Textarea: ({ label, value, onValueChange }: Record<string, any>) => <label>{label}<textarea aria-label={label} value={value} onChange={event => onValueChange(event.target.value)} /></label>,
  Dropdown: ({ children }: any) => <div>{children}</div>,
  DropdownTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownItem: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
  Modal: ({ children, isOpen }: Record<string, any>) => isOpen ? <div role="dialog">{children}</div> : null,
  ModalContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: ({ children, label, selectedKeys, onSelectionChange }: Record<string, any>) => <label>{label}<select aria-label={label} value={selectedKeys[0]} onChange={event => onSelectionChange(new Set([event.target.value]))}>{React.Children.map(children, child => React.isValidElement(child) ? React.cloneElement(child as React.ReactElement<any>, { value: String(child.key).replace(/^\.\$/, '') }) : child)}</select></label>,
  SelectItem: ({ children, value }: Record<string, any>) => <option value={value}>{children}</option>,
}));

const snapshot: PersonalAgentSnapshot = {
  ideas: [],
  profile: { clientId: 'client-1', name: 'Muse', avatar: 'sky', instructions: '', memory: '', mainRoomId: 'main-1', createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z' },
  rooms: [{ id: 'main-1', name: 'Main chat', type: 'codeAgent', codeAgentBackend: 'codex-app-server', personalAgentOwnerId: 'client-1', personalAgentThreadKind: 'main', createdAt: '2026-10-05T12:00:00Z', creatorId: 'client-1' }],
  goals: [{ id: 'goal-1', clientId: 'client-1', title: 'Morning brief', prompt: 'Review my plan', schedule: 'daily', time: '09:00', timezone: 'America/Los_Angeles', enabled: true, createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z' }],
};
const props = () => ({ clientId: 'client-1', roomUpdates: [], onRoomSelect: vi.fn(), onOpenConnections: vi.fn(), showSuccess: vi.fn(), showError: vi.fn() });

describe('PersonalAgentView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.personalGoogleRequest.mockResolvedValue({actions:[]});
    api.getPersonalAgent.mockResolvedValue(snapshot);
    api.readPersonalAgentNotifications.mockResolvedValue({ notifications: [], total: 0, unread: 0 });
    api.readPersonalAgentWatches.mockResolvedValue({ watches: [], total: 0 });
    api.readPersonalAgentMemories.mockResolvedValue({ memories: [], total: 0 });
    api.getCodexConnectionStatus.mockResolvedValue({ status: 'connected' });
  });
  afterEach(cleanup);

  const openMemorySettings = () => {
    fireEvent.click(screen.getByRole('button',{name:'personalAgentApps'}));
    fireEvent.click(screen.getByRole('button',{name:/personalAgentPersonalityMemory/}));
    expect(screen.queryByLabelText('personalAgentName')).toBeNull();
    expect(screen.getByTestId('personal-memory-library')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('personal-agent-profile-summary')).getByRole('button',{name:'edit'}));
  };


  const suggestion = (id: string) => ({ id, title: `Suggestion ${id}`, reason: 'A saved decision needs a next step', prompt: 'Read the saved topic',
    source: { kind: 'memory' as const, id: `note-${id}`, title: 'Actual topic', excerpt: 'Confirmed source text', recordedAt: snapshot.profile.updatedAt },
    automatic: false, status: 'new' as const, createdAt: snapshot.profile.createdAt, updatedAt: snapshot.profile.updatedAt });

  it.each(['main', 'task'] as const)('shows work status without repeating the %s conversation title before a plan exists', async kind => {
    const room = { ...snapshot.rooms[0], id: kind === 'main' ? 'main-1' : 'side-1', name: kind === 'main' ? 'Main chat' : 'Side chat', personalAgentThreadKind: kind, personalAgentTaskStatus: 'running' as const };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, rooms: kind === 'main' ? [room] : [...snapshot.rooms, room] });
    render(<PersonalAgentView {...props()} selectedRoomId={room.id} conversation={() => <p>{room.name}</p>} />);
    await screen.findByText('personalAgentThinking');
    expect(screen.getAllByText(room.name)).toHaveLength(1);
  });

  it('preserves a failed tracking draft and controls the saved watch with its current revision', async () => {
    const callbacks = props();
    const watch = { id: 'watch', roomId: 'watch-room', title: 'Availability', url: 'https://example.org/stock', condition: 'change', value: '',
      intervalMinutes: 30, status: 'active', updatedAt: snapshot.profile.updatedAt };
    api.createPersonalAgentWatch.mockRejectedValueOnce(new Error('Try again'));
    render(<PersonalAgentView {...callbacks} />); await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    fireEvent.click(screen.getByRole('button', { name: 'personalWatchTrack' }));
    fireEvent.change(screen.getByLabelText('personalWatchSourceTitle'), { target: { value: watch.title } });
    fireEvent.change(screen.getByLabelText('personalWatchSourceURL'), { target: { value: watch.url } });
    fireEvent.click(screen.getByRole('button', { name: 'personalWatchStart' }));
    await screen.findByText('Try again');
    expect((screen.getByLabelText('personalWatchSourceURL') as HTMLInputElement).value).toBe(watch.url);
    api.createPersonalAgentWatch.mockResolvedValue({ watch });
    api.readPersonalAgentWatches.mockResolvedValue({ watches: [watch], total: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'personalWatchStart' }));
    await screen.findByTestId('personal-watch-card');
    api.controlPersonalAgentWatch.mockResolvedValue({ watch: { ...watch, status: 'paused', updatedAt: '2026-10-06T12:00:00Z' } });
    fireEvent.click(screen.getByTestId('personal-watch-card'));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentPause'}));
    await screen.findByRole('button',{name:'personalAgentResume'});
    expect(api.controlPersonalAgentWatch).toHaveBeenLastCalledWith('client-1', watch, 'pause');
    expect((screen.getByRole('button', { name: 'personalWatchCheckNow' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('retains failed notification reads and saves display preferences', async () => {
    const callbacks = props();
    const notice = { id: 'notice', title: 'Completed', body: 'Actual finished response', kind: 'task_complete', createdAt: snapshot.profile.createdAt };
    api.readPersonalAgentNotifications.mockResolvedValue({ notifications: [notice], total: 1, unread: 1 });
    api.markPersonalAgentNotificationRead.mockRejectedValueOnce(new Error('Read failed'));
    render(<PersonalAgentView {...callbacks} />);await screen.findByText('Muse');fireEvent.click(screen.getByRole('button',{name:'personalUpdates'}));await screen.findByText('Actual finished response');
    fireEvent.click(screen.getByRole('button', { name: 'personalUpdateRead' }));
    await waitFor(() => expect(callbacks.showError).toHaveBeenCalledWith('Read failed'));
    expect(screen.getByTestId('personal-update-card')).toBeTruthy();
    api.markPersonalAgentNotificationRead.mockResolvedValue({ notification: { ...notice, readAt: snapshot.profile.updatedAt } });
    fireEvent.click(screen.getByRole('button', { name: 'personalUpdateRead' }));
    await screen.findByRole('button',{name:'personalNotificationRead'});
    expect(screen.getByTestId('personal-update-card')).toBeTruthy();
    openMemorySettings();
    fireEvent.click(screen.getByLabelText('personalShowUpdates'));
    api.updatePersonalAgentProfile.mockResolvedValue({ profile: { ...snapshot.profile, showUpdates: false, pushEnabled: true } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.updatePersonalAgentProfile).toHaveBeenCalledWith('client-1', expect.objectContaining({ showUpdates: false }), snapshot.profile.updatedAt));
  });

  it('keeps failed edits and only opens a task after acceptance succeeds', async () => {
    const idea = suggestion('one'), callbacks = props();
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, ideas: [idea] });
    api.acceptPersonalAgentIdea.mockRejectedValueOnce(new Error('Source changed'));
    render(<PersonalAgentView {...callbacks} />); await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentIdeas' }));
    expect(screen.queryByText('Confirmed source text')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'personalIdeaOpen'}));
    expect(screen.getByText('Confirmed source text')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByLabelText('personalIdeaSourceInstructions'), { target: { value: 'My revised task' } });
    fireEvent.click(screen.getByRole('button', { name: 'personalIdeaSourceAccept' }));
    await screen.findByText('Source changed');
    expect(callbacks.onRoomSelect).toHaveBeenLastCalledWith(snapshot.rooms[0]);
    expect((screen.getByLabelText('personalIdeaSourceInstructions') as HTMLTextAreaElement).value).toBe('My revised task');
    api.acceptPersonalAgentIdea.mockResolvedValue({ idea: { ...idea, status: 'accepted' }, room: snapshot.rooms[0] });
    fireEvent.click(screen.getByRole('button', { name: 'personalIdeaSourceAccept' }));
    await waitFor(() => expect(callbacks.onRoomSelect).toHaveBeenCalledWith(snapshot.rooms[0]));
    expect(api.acceptPersonalAgentIdea).toHaveBeenLastCalledWith('client-1', idea, 'My revised task');
    expect(screen.queryByTestId('personal-idea-card')).toBeNull();
  });

  it('preserves both decisions when different cards resolve concurrently', async () => {
    const one = suggestion('one'), two = suggestion('two');
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, ideas: [one, two] });
    let resolveOne!: (value: unknown) => void, resolveTwo!: (value: unknown) => void;
    api.dismissPersonalAgentIdea.mockImplementation((_client: string, idea: typeof one) => new Promise(resolve => {
      if (idea.id === one.id) resolveOne = resolve; else resolveTwo = resolve;
    }));
    render(<PersonalAgentView {...props()} />); await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentIdeas' }));
    for (const card of screen.getAllByTestId('personal-idea-card')) {fireEvent.click(within(card).getByRole('button',{name:'personalIdeaOpen'}));fireEvent.click(within(card).getByRole('button', { name: 'personalIdeaDismiss' }));}
    resolveOne({ idea: { ...one, status: 'dismissed' } });
    await waitFor(() => expect(screen.getAllByTestId('personal-idea-card')).toHaveLength(1));
    resolveTwo({ idea: { ...two, status: 'dismissed' } });
    await waitFor(() => expect(screen.queryByTestId('personal-idea-card')).toBeNull());
  });

  it('loads source-backed suggestions beyond the first page', async () => {
    const first = Array.from({ length: 50 }, (_, index) => suggestion(String(index)));
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, ideas: first });
    api.readPersonalAgentIdeas.mockResolvedValue({ ideas: [suggestion('last')], total: 51 });
    render(<PersonalAgentView {...props()} />); await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentIdeas' }));
    fireEvent.click(screen.getByRole('button', { name: 'loadMore' }));
    await screen.findByText('Suggestion last');
    expect(api.readPersonalAgentIdeas).toHaveBeenCalledWith('client-1', 50);
    expect(screen.queryByRole('button', { name: 'loadMore' })).toBeNull();
  });

  it('opens the private main chat and provides the connection action when disconnected', async () => {
    api.getCodexConnectionStatus.mockResolvedValue({status:'disconnected'});
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    await waitFor(()=>expect(callbacks.onRoomSelect).toHaveBeenCalledWith(snapshot.rooms[0]));
    expect(callbacks.onRoomSelect).toHaveBeenCalledWith(snapshot.rooms[0]);
    fireEvent.click(screen.getByRole('button',{name:'personalAgentApps'}));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentConnectAccount'}));
    expect(callbacks.onOpenConnections).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{name:'personalComputerTitle personalGoogleConnect'}));
    expect(callbacks.onOpenConnections).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fills an existing default chat title when the conversation menu opens', async () => {
    const room = { ...snapshot.rooms[0], id: 'side-title', name: 'Side chat', personalAgentThreadKind: 'task' as const, personalAgentAutoTitle: true };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, rooms: [...snapshot.rooms, room] });
    api.generatePersonalAgentChatTitle.mockResolvedValue({ room: { ...room, name: '十二月滑雪', personalAgentAutoTitle: false } });
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');
    expect(api.generatePersonalAgentChatTitle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentConversations' }));
    await screen.findByText('十二月滑雪');
    expect(api.generatePersonalAgentChatTitle).toHaveBeenCalledOnce();
    expect(api.generatePersonalAgentChatTitle).toHaveBeenCalledWith('client-1', 'side-title');
  });

  it('creates a distinct task conversation through the API', async () => {
    const room = { ...snapshot.rooms[0], id: 'task-1', name: 'Trip planning', personalAgentThreadKind: 'task' };
    api.createPersonalAgentThread.mockResolvedValue({ room });
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button',{name:'personalAgentConversations'}));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentNewSideChat'}));
    await waitFor(() => expect(callbacks.onRoomSelect).toHaveBeenCalledWith(room));
    expect(api.createPersonalAgentThread).toHaveBeenCalledWith('client-1', 'personalAgentSideChat');
  });

  it('searches, renames, archives and restores a topic while keeping the main chat available', async () => {
    const room = { ...snapshot.rooms[0], id: 'task-1', name: 'Trip planning', personalAgentThreadKind: 'task' as const };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, rooms: [...snapshot.rooms, room] });
    let current = room;
    api.updatePersonalAgentThread.mockImplementation(async (_client: string, _id: string, updates: { name?: string; archived?: boolean }) => {
      current = { ...current, ...(updates.name ? { name: updates.name } : {}),
        ...(updates.archived !== undefined ? { personalAgentArchivedAt: updates.archived ? '2026-10-06T12:00:00Z' : undefined } : {}) };
      return { room: current };
    });
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');fireEvent.click(screen.getByRole('button',{name:'personalAgentConversations'}));
    await screen.findByTestId('personal-agent-chat-card');
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentRenameChat'));
    fireEvent.change(screen.getByLabelText('personalAgentConversationName'), { target: { value: 'Summer trip' } });
    fireEvent.click(screen.getByRole('button',{name:'personalAgentSaveName'}));
    await screen.findByText('Summer trip');
    expect(api.updatePersonalAgentThread).toHaveBeenCalledWith('client-1', 'task-1', { name: 'Summer trip' });
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentArchiveChat'));
    await waitFor(() => expect(screen.queryByTestId('personal-agent-chat-card')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentArchivedChats' }));
    await screen.findByText('Summer trip');
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentRestoreChat'));
    await screen.findByText('personalAgentNoArchivedChats');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentShowActiveChats' }));
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByRole('button', { name: /^personalAgentOpenConversation: Summer trip$/ }));
    expect(callbacks.onRoomSelect).toHaveBeenCalledWith(expect.objectContaining({ id: room.id, name: 'Summer trip', personalAgentArchivedAt: undefined }));
    expect(callbacks.showSuccess).toHaveBeenCalledWith('personalAgentConversationRestored');
    expect(screen.queryByRole('button', { name: 'personalAgentOpenMainChat' })).toBeNull();
  });

  it('keeps a conversation visible when archiving fails', async () => {
    const room = { ...snapshot.rooms[0], id: 'task-1', name: 'Trip planning', personalAgentThreadKind: 'task' as const };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, rooms: [...snapshot.rooms, room] });
    api.updatePersonalAgentThread.mockRejectedValue(new Error('Unable to archive'));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');fireEvent.click(screen.getByRole('button',{name:'personalAgentConversations'}));await screen.findByText('Trip planning');
    fireEvent.click(screen.getByText('personalAgentArchiveChat'));
    await waitFor(() => expect(callbacks.showError).toHaveBeenCalledWith('Unable to archive'));
    expect(screen.getByText('Trip planning')).toBeTruthy();
  });

  it('pauses goals and opens their real execution room', async () => {
    const callbacks = props();
    api.updatePersonalAgentGoal.mockResolvedValue({ goal: { ...snapshot.goals[0], enabled: false } });
    api.delegatePersonalAgentTask.mockResolvedValue({room:snapshot.rooms[0]});
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    fireEvent.click(screen.getByRole('button',{name:'personalGoalOpen'}));
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentPause' }));
    await screen.findByText('personalAgentPaused');
    expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', 'goal-1', { enabled: false, completed:false }, snapshot.goals[0].updatedAt);
    fireEvent.click(screen.getByRole('button',{name:'personalGoalPlan'}));
    await screen.findByTestId('source-task-detail');
    expect(api.delegatePersonalAgentTask).toHaveBeenCalledWith('client-1',{kind:'plan',title:'Plan: Morning brief',prompt:'Create a practical plan for this goal: Morning brief. Review my plan',goalId:'goal-1',input:{}});
  });

  it('shows goal details on selection and preserves milestone progress when completed', async () => {
    const goal = { ...snapshot.goals[0], milestones: [{ id: 'm1', title: 'Read sources', done: false }], lastRun: { status: 'running' as const } };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, goals: [goal] });
    api.updatePersonalAgentGoal.mockImplementation(async (_client: string, _id: string, update: object) => ({ goal: { ...goal, ...update } }));
    api.cancelPersonalAgentGoal.mockResolvedValue({ goal: { ...goal, enabled: false }, cancellationRequested: true });
    const callbacks = props(); render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse'); fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    expect(screen.queryByRole('checkbox',{name:'Read sources'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'personalGoalOpen'}));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read sources' }));
    await waitFor(() => expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', goal.id, { milestones: [{ id: 'm1', title: 'Read sources', done: true }] }, goal.updatedAt));
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentCompleteGoal' }));
    await waitFor(() => expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', goal.id, expect.objectContaining({ completed: true }), goal.updatedAt));
  });

  it('keeps completed goals in collapsed history with read-only details and saved work', async () => {
    const goal = { ...snapshot.goals[0], enabled: false, completedAt: snapshot.profile.createdAt, milestones: [] };
    const room = { ...snapshot.rooms[0], personalAgentGoalId: goal.id };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, goals: [goal], rooms: [room] });
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');fireEvent.click(screen.getByRole('button',{name:'personalAgentGoals'}));
    const history=screen.getByTestId('personal-completed-goals') as HTMLDetailsElement;
    expect(history.open).toBe(false);
    expect(history.querySelector('summary')?.textContent).toContain('(1)');
    expect(screen.getByRole('button',{name:'personalGoalOpen'}).closest('details')).toBe(history);
    fireEvent.click(within(history).getByRole('button',{name:'personalGoalOpen',hidden:true}));
    const dialog=screen.getByRole('dialog');
    expect(within(dialog).getByText('personalAgentGoalCompleted')).toBeTruthy();
    expect(within(dialog).queryByRole('button',{name:'personalAgentResume'})).toBeNull();
    expect(within(dialog).queryByRole('button',{name:'personalGoalPlan'})).toBeNull();
    expect(within(dialog).queryByText('personalGoalProgress')).toBeNull();
    fireEvent.click(within(dialog).getByText('personalAgentViewWork'));
    await screen.findByTestId('source-task-detail');
    expect(api.updatePersonalAgentGoal).not.toHaveBeenCalled();
    expect(api.delegatePersonalAgentTask).not.toHaveBeenCalled();
  });

  it('moves a newly completed goal out of the main list and closes its action dialog', async () => {
    const goal=snapshot.goals[0];
    api.updatePersonalAgentGoal.mockImplementation(async()=>{
      const completed={...goal,enabled:false,completedAt:snapshot.profile.createdAt};
      api.getPersonalAgent.mockResolvedValue({...snapshot,goals:[completed]});
      return {goal:completed};
    });
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'personalAgentGoals'}));});
    fireEvent.click(screen.getByRole('button',{name:'personalGoalOpen'}));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentCompleteGoal'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    const history=await screen.findByTestId('personal-completed-goals') as HTMLDetailsElement;
    expect(screen.getByRole('button',{name:'personalGoalOpen'}).closest('details')).toBe(history);
    expect(history.open).toBe(false);
    expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1',goal.id,{completed:true},goal.updatedAt);
  });

  it('saves user memory and preferences without losing draft changes to refresh', async () => {
    api.updatePersonalAgentProfile.mockImplementation(async (_id: string, profile: object) => ({ profile: { ...snapshot.profile, ...profile } }));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    openMemorySettings();
    fireEvent.change(screen.getByLabelText('personalAgentName'), { target: { value: 'Willow' } });
    fireEvent.click(screen.getByRole('button',{name:'personalAgentConversations'}));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentRefreshWorkspace'}));
    await waitFor(() => expect(api.getPersonalAgent).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('personalAgentName') as HTMLTextAreaElement).value).toBe('Willow');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.updatePersonalAgentProfile).toHaveBeenCalledWith('client-1', expect.objectContaining({ name: 'Willow' }), snapshot.profile.updatedAt));
    expect(callbacks.showSuccess).toHaveBeenCalledWith('personalAgentProfileSaved');
  });

  it('does not show an unavailable connection as connected', async () => {
    api.getCodexConnectionStatus.mockRejectedValue(new Error('unavailable'));
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button',{name:'personalAgentApps'}));
    await screen.findByText('personalAgentConnectAccount');
    expect(screen.queryByText('personalAgentReadyToHelp')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    expect(screen.queryByRole('button',{name:'personalAgentRunNow'})).toBeNull();
  });

  it('refreshes clean memory from the agent after a background update', async () => {
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');
    openMemorySettings();
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, profile: { ...snapshot.profile, name: 'Updated name' } });
    fireEvent.click(screen.getByRole('button',{name:'personalAgentConversations'}));
    fireEvent.click(screen.getByRole('button',{name:'personalAgentRefreshWorkspace'}));
    await waitFor(() => expect((screen.getByLabelText('personalAgentName') as HTMLTextAreaElement).value).toBe('Updated name'));
  });

  it('guides guest accounts to sign in when private provisioning fails', async () => {
    api.getPersonalAgent.mockRejectedValue(Object.assign(new Error('Sign in required'), { status: 401 }));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('personalAgentSignInHint');
    fireEvent.click(screen.getByRole('button',{name:'settings'}));
    expect(callbacks.onOpenConnections).toHaveBeenCalled();
  });
  it('shows memory text immediately and edits a correction inline with its saved revision',async()=>{
    const entry={id:'memory-1',clientId:'client-1',kind:'fact',title:'Saved context',content:'Earlier information',source:'Added by you',createdAt:snapshot.profile.createdAt,updatedAt:snapshot.profile.updatedAt};
    api.readPersonalAgentMemories.mockResolvedValue({memories:[entry],total:1});
    api.savePersonalAgentMemory.mockResolvedValue({memory:{...entry,content:'Corrected information'}});
    render(<PersonalAgentView {...props()} />);await screen.findByText('Muse');openMemorySettings();
    const row=await screen.findByTestId('personal-memory-entry');
    expect(within(row).getByText('Earlier information')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button',{name:'edit'}));
    fireEvent.change(within(row).getByLabelText('personalAgentMemory'),{target:{value:'Corrected information'}});
    fireEvent.click(within(row).getByRole('button',{name:'personalMemorySaveCorrection'}));
    await waitFor(()=>expect(api.savePersonalAgentMemory).toHaveBeenCalledWith('client-1',{kind:'fact',title:'Saved context',content:'Corrected information'},entry));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
