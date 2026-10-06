// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalAgentView } from './PersonalAgentView';
import type { PersonalAgentSnapshot } from '../utils/personalAgent';

const api = vi.hoisted(() => ({
  getPersonalAgent: vi.fn(), getCodexConnectionStatus: vi.fn(), createPersonalAgentThread: vi.fn(), updatePersonalAgentThread: vi.fn(),
  cancelPersonalAgentGoal: vi.fn(), createPersonalAgentGoal: vi.fn(), updatePersonalAgentGoal: vi.fn(), deletePersonalAgentGoal: vi.fn(),
  mergePersonalAgentMemories: vi.fn(), readPersonalAgentMemories: vi.fn(), savePersonalAgentMemory: vi.fn(), forgetPersonalAgentMemory: vi.fn(), runPersonalAgentGoal: vi.fn(), updatePersonalAgentProfile: vi.fn(),
}));
vi.mock('../utils/personalAgent', () => api);
vi.mock('../utils/codexConnection', () => api);
vi.mock('react-i18next', () => { const t = (key: string) => key; return { useTranslation: () => ({ t, i18n: { language: 'en' } }) }; });
vi.mock('@iconify/react', () => ({ Icon: () => <span /> }));
vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, isDisabled, type = 'button', ...props }: Record<string, any>) => <button type={type} disabled={isDisabled} onClick={onPress} aria-label={props['aria-label']}>{children}</button>,
  Checkbox: ({ children, isSelected, isDisabled, onValueChange }: Record<string, any>) => <label><input type="checkbox" checked={isSelected} disabled={isDisabled} onChange={event => onValueChange(event.target.checked)} />{children}</label>,
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Spinner: ({ label }: { label: string }) => <span>{label}</span>,
  Input: ({ label, value, onValueChange, type, ...props }: Record<string, any>) => <label>{label}<input aria-label={label || props['aria-label']} value={value} type={type} onChange={event => onValueChange(event.target.value)} /></label>,
  Textarea: ({ label, value, onValueChange }: Record<string, any>) => <label>{label}<textarea aria-label={label} value={value} onChange={event => onValueChange(event.target.value)} /></label>,
  Modal: ({ children, isOpen }: Record<string, any>) => isOpen ? <div role="dialog">{children}</div> : null,
  ModalContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: ({ children, label, selectedKeys, onSelectionChange }: Record<string, any>) => <label>{label}<select aria-label={label} value={selectedKeys[0]} onChange={event => onSelectionChange(new Set([event.target.value]))}>{React.Children.map(children, child => React.isValidElement(child) ? React.cloneElement(child as React.ReactElement<any>, { value: String(child.key).replace(/^\.\$/, '') }) : child)}</select></label>,
  SelectItem: ({ children, value }: Record<string, any>) => <option value={value}>{children}</option>,
}));

const snapshot: PersonalAgentSnapshot = {
  profile: { clientId: 'client-1', name: 'Muse', avatar: '🌱', instructions: '', memory: '', mainRoomId: 'main-1', createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z' },
  rooms: [{ id: 'main-1', name: 'Main chat', type: 'codeAgent', codeAgentBackend: 'codex-app-server', personalAgentOwnerId: 'client-1', personalAgentThreadKind: 'main', createdAt: '2026-10-05T12:00:00Z', creatorId: 'client-1' }],
  goals: [{ id: 'goal-1', clientId: 'client-1', title: 'Morning brief', prompt: 'Review my plan', schedule: 'daily', time: '09:00', timezone: 'America/Los_Angeles', enabled: true, createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z' }],
};
const props = () => ({ clientId: 'client-1', roomUpdates: [], onRoomSelect: vi.fn(), onOpenConnections: vi.fn(), showSuccess: vi.fn(), showError: vi.fn() });

describe('PersonalAgentView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.getPersonalAgent.mockResolvedValue(snapshot);
    api.readPersonalAgentMemories.mockResolvedValue({ memories: [], total: 0 });
    api.getCodexConnectionStatus.mockResolvedValue({ status: 'connected' });
  });
  afterEach(cleanup);

  it('opens the private main chat and provides the subscription connection action', async () => {
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentOpenMainChat' }));
    expect(callbacks.onRoomSelect).toHaveBeenCalledWith(snapshot.rooms[0]);
    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    expect(callbacks.onOpenConnections).toHaveBeenCalled();
  });

  it('creates a distinct task conversation through the API', async () => {
    const room = { ...snapshot.rooms[0], id: 'task-1', name: 'Trip planning', personalAgentThreadKind: 'task' };
    api.createPersonalAgentThread.mockResolvedValue({ room });
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentNewTask' }));
    fireEvent.change(screen.getByLabelText('personalAgentTaskName'), { target: { value: 'Trip planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentStartTask' }));
    await waitFor(() => expect(callbacks.onRoomSelect).toHaveBeenCalledWith(room));
    expect(api.createPersonalAgentThread).toHaveBeenCalledWith('client-1', 'Trip planning');
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
    await screen.findByTestId('personal-agent-chat-card');
    fireEvent.change(screen.getByLabelText('personalAgentSearchChats'), { target: { value: 'unmatched' } });
    expect(screen.queryByTestId('personal-agent-chat-card')).toBeNull();
    expect(screen.getByText('personalAgentNoMatchingChats')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('personalAgentSearchChats'), { target: { value: 'TRIP' } });
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentRenameChat'));
    fireEvent.change(screen.getByLabelText('personalAgentTaskName'), { target: { value: 'Summer trip' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'save' }));
    await screen.findByText('Summer trip');
    expect(api.updatePersonalAgentThread).toHaveBeenCalledWith('client-1', 'task-1', { name: 'Summer trip' });
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentArchiveChat'));
    await waitFor(() => expect(screen.queryByTestId('personal-agent-chat-card')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentArchivedChats' }));
    await screen.findByText('Summer trip');
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByText('personalAgentRestoreChat'));
    await screen.findByText('personalAgentNoMatchingChats');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentShowActiveChats' }));
    fireEvent.click(within(screen.getByTestId('personal-agent-chat-card')).getByRole('button', { name: /Summer trip/ }));
    expect(callbacks.onRoomSelect).toHaveBeenCalledWith(expect.objectContaining({ id: room.id, name: 'Summer trip', personalAgentArchivedAt: undefined }));
    expect(callbacks.showSuccess).toHaveBeenCalledWith('personalAgentConversationRestored');
    expect(screen.getByRole('button', { name: 'personalAgentOpenMainChat' })).toBeTruthy();
  });

  it('keeps a conversation visible when archiving fails', async () => {
    const room = { ...snapshot.rooms[0], id: 'task-1', name: 'Trip planning', personalAgentThreadKind: 'task' as const };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, rooms: [...snapshot.rooms, room] });
    api.updatePersonalAgentThread.mockRejectedValue(new Error('Unable to archive'));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Trip planning');
    fireEvent.click(screen.getByText('personalAgentArchiveChat'));
    await waitFor(() => expect(callbacks.showError).toHaveBeenCalledWith('Unable to archive'));
    expect(screen.getByText('Trip planning')).toBeTruthy();
  });

  it('pauses goals and opens their real execution room', async () => {
    const callbacks = props();
    api.updatePersonalAgentGoal.mockResolvedValue({ goal: { ...snapshot.goals[0], enabled: false } });
    api.runPersonalAgentGoal.mockResolvedValue({ room: snapshot.rooms[0] });
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentPause' }));
    await screen.findByText('personalAgentPaused');
    expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', 'goal-1', { enabled: false }, snapshot.goals[0].updatedAt);
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentRunNow' }));
    await waitFor(() => expect(callbacks.onRoomSelect).toHaveBeenCalledWith(snapshot.rooms[0]));
    expect(api.runPersonalAgentGoal).toHaveBeenCalledWith('client-1', 'goal-1');
  });

  it('tracks milestones independently from actual run state and requests cancellation', async () => {
    const goal = { ...snapshot.goals[0], milestones: [{ id: 'm1', title: 'Read sources', done: false }], lastRun: { status: 'running' as const } };
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, goals: [goal] });
    api.updatePersonalAgentGoal.mockImplementation(async (_client: string, _id: string, update: object) => ({ goal: { ...goal, ...update } }));
    api.cancelPersonalAgentGoal.mockResolvedValue({ goal: { ...goal, enabled: false }, cancellationRequested: true });
    const callbacks = props(); render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse'); fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read sources' }));
    await waitFor(() => expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', goal.id, { milestones: [{ id: 'm1', title: 'Read sources', done: true }] }, goal.updatedAt));
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentCancelWork' }));
    await waitFor(() => expect(api.cancelPersonalAgentGoal).toHaveBeenCalledWith('client-1', goal.id, goal.updatedAt));
    expect(callbacks.showSuccess).toHaveBeenCalledWith('personalAgentCancellationRequested');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentCompleteGoal' }));
    await waitFor(() => expect(api.updatePersonalAgentGoal).toHaveBeenCalledWith('client-1', goal.id, expect.objectContaining({ completed: true }), goal.updatedAt));
  });

  it('saves user memory and preferences without losing draft changes to refresh', async () => {
    api.updatePersonalAgentProfile.mockImplementation(async (_id: string, profile: object) => ({ profile: { ...snapshot.profile, ...profile } }));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentMemory' }));
    fireEvent.change(screen.getByLabelText('personalAgentAboutYou'), { target: { value: 'I prefer Chinese.' } });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(api.getPersonalAgent).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText('personalAgentAboutYou') as HTMLTextAreaElement).value).toBe('I prefer Chinese.');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.updatePersonalAgentProfile).toHaveBeenCalledWith('client-1', expect.objectContaining({ memory: 'I prefer Chinese.' }), snapshot.profile.updatedAt));
    expect(callbacks.showSuccess).toHaveBeenCalledWith('personalAgentProfileSaved');
  });

  it('does not show an unavailable connection as connected or allow a goal run', async () => {
    api.getCodexConnectionStatus.mockRejectedValue(new Error('unavailable'));
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('personalAgentConnectAccount');
    expect(screen.queryByText('personalAgentReadyToHelp')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentGoals' }));
    expect((screen.getByRole('button', { name: 'personalAgentRunNow' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refreshes clean memory from the agent after a background update', async () => {
    render(<PersonalAgentView {...props()} />);
    await screen.findByText('Muse');
    fireEvent.click(screen.getByRole('button', { name: 'personalAgentMemory' }));
    api.getPersonalAgent.mockResolvedValue({ ...snapshot, profile: { ...snapshot.profile, memory: 'A newly remembered preference.' } });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect((screen.getByLabelText('personalAgentAboutYou') as HTMLTextAreaElement).value).toBe('A newly remembered preference.'));
  });

  it('guides guest accounts to sign in when private provisioning fails', async () => {
    api.getPersonalAgent.mockRejectedValue(Object.assign(new Error('Sign in required'), { status: 401 }));
    const callbacks = props();
    render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('personalAgentSignInHint');
    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    expect(callbacks.onOpenConnections).toHaveBeenCalled();
  });
  it('continues a topic using its persistent document and merges reviewed notes with captured revisions', async () => {
    const first = { id: 'memory-1', clientId: 'client-1', kind: 'topic', title: 'Trip plan', content: 'Earlier plan', source: 'Added by you', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' };
    const second = { ...first, id: 'memory-2', title: 'Travel research', content: 'New confirmed destination' };
    api.readPersonalAgentMemories.mockResolvedValue({ memories: [first, second], total: 2 });
    api.createPersonalAgentThread.mockResolvedValue({ room: { ...snapshot.rooms[0], id: 'topic-room', personalAgentMemoryId: first.id } });
    api.mergePersonalAgentMemories.mockResolvedValue({ memory: first });
    const callbacks = props(); render(<PersonalAgentView {...callbacks} />);
    await screen.findByText('Muse'); fireEvent.click(screen.getByRole('button', { name: 'personalAgentMemory' }));
    await screen.findByText('Trip plan');
    fireEvent.click(screen.getAllByRole('button', { name: 'personalMemoryContinueTopic' })[0]);
    await waitFor(() => expect(api.createPersonalAgentThread).toHaveBeenCalledWith('client-1', 'Trip plan', first.id));
    await waitFor(() => expect(callbacks.onRoomSelect).toHaveBeenCalledWith(expect.objectContaining({ personalAgentMemoryId: first.id })));
    fireEvent.click(screen.getByRole('button', { name: 'personalMemoryOrganize' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trip plan' })); fireEvent.click(screen.getByRole('checkbox', { name: 'Travel research' }));
    fireEvent.click(screen.getByRole('button', { name: 'personalMemoryMergeSelected' }));
    fireEvent.change(screen.getByLabelText('personalMemoryContent'), { target: { value: 'Confirmed destination and next steps' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.mergePersonalAgentMemories).toHaveBeenCalledWith('client-1', { kind: 'topic', title: 'Trip plan', content: 'Confirmed destination and next steps' }, [first, second]));
  });

});
