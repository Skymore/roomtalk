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
    expect(screen.getByText('codeAgentTools')).toBeTruthy();
    expect(screen.getByText('codeAgentResults')).toBeTruthy();
    expect(screen.getByText('codeAgentErrors')).toBeTruthy();
    fireEvent.click(screen.getByText('codeAgentActivity'));
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

    fireEvent.click(screen.getByText('codeAgentFiles'));
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentActivity'));
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
          commands: [
            {
              id: 'tool-1',
              name: 'Shell',
              status: 'succeeded',
              preview: 'npm test',
            },
            {
              id: 'tool-2',
              name: 'Write',
              status: 'started',
            },
            {
              id: 'tool-3',
              name: 'Edit',
              status: 'failed',
              preview: 'permission denied',
            },
          ],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentActivity'));
    expect(screen.getAllByText('Shell').length).toBeGreaterThan(0);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandStarted')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandSucceeded')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandFailed')).toBeTruthy();
    expect(screen.getByText('permission denied')).toBeTruthy();
  });

  it('renders root-level touched files with a repo-root directory marker', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[{
          ...toolCall,
          id: 'root-tool',
          toolArgs: { file_path: '/workspace/README.md' },
        }]}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    fireEvent.click(screen.getByText('codeAgentFiles'));
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText('.')).toBeTruthy();
  });

  it('indicates when the touched file list is truncated', () => {
    const messages = Array.from({ length: 12 }, (_, index): Message => ({
      ...toolCall,
      id: `tool-${index}`,
      toolArgs: { file_path: `/workspace/src/file-${String(index).padStart(2, '0')}.ts` },
    }));

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={messages}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    fireEvent.click(screen.getByText('codeAgentFiles'));
    expect(screen.getByText('file-00.ts')).toBeTruthy();
    expect(screen.queryByText('file-11.ts')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
