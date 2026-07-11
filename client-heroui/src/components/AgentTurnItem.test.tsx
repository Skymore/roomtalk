// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message, RoomAgentTurn } from '../utils/types';
import { AgentTurnItem, formatAgentTurnDuration } from './AgentTurnItem';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { duration?: string }) => values?.duration ? `${key} ${values.duration}` : key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const message = (overrides: Partial<Message>): Message => ({
  id: 'message-1',
  clientId: 'ai_assistant',
  content: 'content',
  timestamp: '2026-05-03T00:00:01.000Z',
  roomId: 'room-1',
  messageType: 'ai',
  turnId: 'turn-1',
  status: 'complete',
  ...overrides,
});

const turn = (overrides: Partial<RoomAgentTurn> = {}): RoomAgentTurn => ({
  id: 'turn-1',
  roomId: 'room-1',
  status: 'complete',
  startedAt: '2026-05-03T00:00:00.000Z',
  completedAt: '2026-05-03T00:00:08.000Z',
  finalMessageId: 'ai-final',
  backend: 'code-agent',
  assistantName: 'Coco',
  updatedAt: '2026-05-03T00:00:08.000Z',
  ...overrides,
});

afterEach(cleanup);

describe('AgentTurnItem', () => {
  it('shows one working header and one avatar for a running turn', () => {
    const messages = [
      message({ id: 'ai-first', content: 'first update', status: 'complete' }),
      message({ id: 'tool', clientId: 'code_agent_runner', messageType: 'tool_call', content: 'Reading file', timestamp: '2026-05-03T00:00:02.000Z' }),
      message({ id: 'ai-final', content: 'latest update', status: 'streaming', timestamp: '2026-05-03T00:00:03.000Z' }),
    ];
    render(
      <AgentTurnItem
        turn={turn({ status: 'running', completedAt: undefined })}
        messages={messages}
        renderAgentMessage={item => <div>{item.content}</div>}
        renderStandaloneMessage={item => <div>{item.content}</div>}
      />,
    );

    expect(screen.getAllByTestId('turn-avatar')).toHaveLength(1);
    expect(screen.getByTestId('turn-avatar').getAttribute('data-agent-brand')).toBe('coco');
    expect(screen.getAllByText(/agentWorkingFor/)).toHaveLength(1);
    expect(screen.getByText('first update')).toBeTruthy();
    expect(screen.getByText('Reading file')).toBeTruthy();
    expect(screen.getByText('latest update')).toBeTruthy();
  });

  it('uses the Codex brand avatar for Codex turns', () => {
    render(
      <AgentTurnItem
        turn={turn({ backend: 'codex-app-server', assistantName: 'Codex' })}
        messages={[message({ id: 'ai-final', content: 'done' })]}
        renderAgentMessage={item => <div>{item.content}</div>}
        renderStandaloneMessage={item => <div>{item.content}</div>}
      />,
    );

    expect(screen.getByTestId('turn-avatar').getAttribute('data-agent-brand')).toBe('codex');
    expect(screen.getByTestId('turn-avatar').getAttribute('aria-label')).toBe('Codex');
  });

  it('collapses earlier work after completion and keeps the final message visible', () => {
    const messages = [
      message({ id: 'ai-first', content: 'first update' }),
      message({ id: 'tool', clientId: 'code_agent_runner', messageType: 'tool_call', content: 'Reading file' }),
      message({ id: 'ai-final', content: 'final answer', timestamp: '2026-05-03T00:00:08.000Z' }),
    ];
    render(
      <AgentTurnItem
        turn={turn()}
        messages={messages}
        renderAgentMessage={item => <div>{item.content}</div>}
        renderStandaloneMessage={item => <div>{item.content}</div>}
      />,
    );

    const disclosure = screen.getByRole('button', { name: 'agentExpandWork' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('first update')).toBeNull();
    expect(screen.queryByText('Reading file')).toBeNull();
    expect(screen.getByText('final answer')).toBeTruthy();
    expect(screen.getByText('agentWorkedFor 8s')).toBeTruthy();

    fireEvent.click(disclosure);
    expect(screen.getByText('first update')).toBeTruthy();
    expect(screen.getByText('Reading file')).toBeTruthy();
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });

  it('formats second, minute, and hour durations', () => {
    expect(formatAgentTurnDuration(12_900)).toBe('12s');
    expect(formatAgentTurnDuration(270_000)).toBe('4m 30s');
    expect(formatAgentTurnDuration(3_661_000)).toBe('1h 1m 1s');
  });
});
