// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message, Room } from '../utils/types';
import { CocoWorkspacePanel } from './CocoWorkspacePanel';

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

describe('CocoWorkspacePanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders plan mode as read-only workspace state', () => {
    render(
      <CocoWorkspacePanel
        room={room}
        messages={[]}
        cocoMode="plan"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('codeAgentReadOnlyMode')).toBeTruthy();
    expect(screen.getByText('codeAgentReadOnlyDescription')).toBeTruthy();
    expect(screen.getByText('codeAgentNoActivity')).toBeTruthy();
  });

  it('renders acceptEdits mode and derived tool activity', () => {
    render(
      <CocoWorkspacePanel
        room={{ ...room, cocoStatus: 'running' }}
        messages={[toolCall]}
        cocoMode="acceptEdits"
        sessionCostUsd={0.25}
      />
    );

    expect(screen.getByText('codeAgentEditMode')).toBeTruthy();
    expect(screen.getByText('codeAgentEditDescription')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
  });

  it('indicates when the touched file list is truncated', () => {
    const messages = Array.from({ length: 10 }, (_, index): Message => ({
      ...toolCall,
      id: `tool-${index}`,
      toolArgs: { file_path: `/workspace/src/file-${index}.ts` },
    }));

    render(
      <CocoWorkspacePanel
        room={room}
        messages={messages}
        cocoMode="plan"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('src/file-0.ts')).toBeTruthy();
    expect(screen.queryByText('src/file-9.ts')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
