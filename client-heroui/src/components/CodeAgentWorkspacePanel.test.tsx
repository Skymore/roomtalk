// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message, Room } from '../utils/types';
import { CodeAgentWorkspacePanel } from './CodeAgentWorkspacePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const room: Room = {
  id: 'room-1',
  name: 'Coco',
  createdAt: '2026-05-26T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'coco',
  sandboxStatus: 'ready',
  cocoStatus: 'idle',
};

const toolCall: Message = {
  id: 'tool-1',
  clientId: 'coco_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-26T00:00:00.000Z',
  messageType: 'tool_call',
  toolName: 'Read',
  toolArgs: { file_path: '/workspace/src/App.tsx' },
};

describe('CodeAgentWorkspacePanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders plan mode as read-only workspace state', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('codeAgentReadOnlyMode')).toBeTruthy();
    expect(screen.getByText('codeAgentReadOnlyDescription')).toBeTruthy();
    expect(screen.getByText('codeAgentNoActivity')).toBeTruthy();
  });

  it('renders acceptEdits mode and derived tool activity', () => {
    const onRefreshWorkspace = vi.fn();
    render(
      <CodeAgentWorkspacePanel
        room={{ ...room, cocoStatus: 'running' }}
        messages={[toolCall]}
        mode="acceptEdits"
        sessionCostUsd={0.25}
        onRefreshWorkspace={onRefreshWorkspace}
      />
    );

    expect(screen.getByText('codeAgentEditMode')).toBeTruthy();
    expect(screen.getByText('codeAgentEditDescription')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentRefreshWorkspace')).toBeTruthy();
  });

  it('allows workspace refresh and shows non-blocking refresh errors', async () => {
    const onRefreshWorkspace = vi.fn();

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
        workspaceRefreshError="Failed"
        onRefreshWorkspace={onRefreshWorkspace}
      />
    );

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspace'));

    expect(onRefreshWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('codeAgentWorkspaceRefreshFailed');
  });

  it('renders command history from refreshed workspace snapshots', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'coco',
          source: 'messages',
          generatedAt: '2026-05-29T00:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
          summary: {
            toolCalls: 1,
            toolResults: 1,
            toolErrors: 0,
            touchedFiles: ['src/App.tsx'],
            lastToolName: 'Shell',
          },
          files: { touched: ['src/App.tsx'], hiddenCount: 0 },
          changes: { available: false, changedFiles: [], diffSummary: null },
          commands: [{
            id: 'tool-1',
            name: 'Shell',
            status: 'succeeded',
            preview: 'npm test',
          }],
        }}
      />
    );

    expect(screen.getAllByText('Shell').length).toBeGreaterThan(0);
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('indicates when the touched file list is truncated', () => {
    const messages = Array.from({ length: 10 }, (_, index): Message => ({
      ...toolCall,
      id: `tool-${index}`,
      toolArgs: { file_path: `/workspace/src/file-${index}.ts` },
    }));

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={messages}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('src/file-0.ts')).toBeTruthy();
    expect(screen.queryByText('src/file-9.ts')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
