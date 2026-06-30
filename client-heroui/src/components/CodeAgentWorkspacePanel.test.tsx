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
    fireEvent.click(screen.getByText('codeAgentArtifacts'));
    expect(screen.getByText('codeAgentNoArtifacts')).toBeTruthy();
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

  it('collapses workspace details while keeping the sticky summary available', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[toolCall]}
        mode="plan"
        sessionCostUsd={0.1}
      />
    );

    const toggle = screen.getByTestId('code-agent-workspace-toggle');
    const details = screen.getByTestId('code-agent-workspace-details');

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.getAttribute('hidden')).toBeNull();
    expect(screen.getByText('codeAgentOverview')).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.getAttribute('hidden')).toBe('');
    expect(screen.getByText('codeAgentWorkspace')).toBeTruthy();
    expect(screen.getByText('codeAgentReadOnlyMode')).toBeTruthy();
    expect(screen.getByText('sandboxStatusReady')).toBeTruthy();
    expect(screen.getByText('cocoStatusIdle')).toBeTruthy();
    expect(screen.queryByText('codeAgentReadOnlyDescription')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.getAttribute('hidden')).toBeNull();
    expect(screen.getByText('codeAgentOverview')).toBeTruthy();
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
          source: 'sandbox',
          generatedAt: '2026-05-29T00:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
          summary: {
            toolCalls: 1,
            toolResults: 1,
            toolErrors: 0,
            lastToolName: 'Shell',
          },
          artifacts: [
            {
              slug: 'roomtalk-demo',
              title: 'RoomTalk Demo',
              url: 'https://room.ruit.me/p/roomtalk-demo/',
              entry: 'index.html',
              versionId: '20260630T120000Z_aaaaaaaa',
              fileCount: 1,
              totalBytes: 128,
              createdAt: '2026-06-30T12:00:00.000Z',
              updatedAt: '2026-06-30T12:00:00.000Z',
            },
          ],
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

    fireEvent.click(screen.getByText('codeAgentArtifacts'));
    const link = screen.getByText('RoomTalk Demo').closest('a');
    expect(link?.getAttribute('href')).toBe('https://room.ruit.me/p/roomtalk-demo/');
  });
});
