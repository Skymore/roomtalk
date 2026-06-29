// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from './types';
import {
  loadCodeAgentWorkspaceSnapshot,
  mergeCocoWorkspaceSummaries,
  summarizeCocoMessages,
} from './cocoWorkspace';

const requestCodeAgentWorkspaceSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('./socket', () => ({
  requestCodeAgentWorkspaceSnapshot: requestCodeAgentWorkspaceSnapshotMock,
}));

const message = (overrides: Partial<Message>): Message => ({
  id: overrides.id || 'message-1',
  clientId: overrides.clientId || 'coco_runner',
  content: overrides.content || '',
  roomId: 'room-1',
  timestamp: '2026-05-26T00:00:00.000Z',
  messageType: overrides.messageType || 'tool_call',
  ...overrides,
});

describe('summarizeCocoMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    requestCodeAgentWorkspaceSnapshotMock.mockReset();
    localStorage.clear();
  });

  it('returns an empty summary when there is no tool activity', () => {
    expect(summarizeCocoMessages([])).toEqual({
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      touchedFiles: [],
      lastToolName: undefined,
    });
  });

  it('counts tool calls, results, errors, files, and latest tool', () => {
    const summary = summarizeCocoMessages([
      message({
        id: 'call-1',
        messageType: 'tool_call',
        toolCallId: 'read-1',
        toolName: 'Read',
        toolArgs: { file_path: 'src/App.tsx' },
      }),
      message({
        id: 'call-2',
        messageType: 'tool_call',
        toolCallId: 'edit-1',
        toolName: 'Edit',
        toolArgs: { path: 'src/App.tsx' },
      }),
      message({
        id: 'result-1',
        messageType: 'tool_result',
        toolCallId: 'edit-1',
        toolName: 'Edit',
        isError: true,
      }),
      message({
        id: 'result-2',
        messageType: 'tool_result',
        toolName: 'Glob',
      }),
    ]);

    expect(summary).toEqual({
      toolCalls: 2,
      toolResults: 2,
      toolErrors: 1,
      touchedFiles: ['src/App.tsx'],
      lastToolName: 'Glob',
    });
  });

  it('ignores missing args and non-file tool calls', () => {
    const summary = summarizeCocoMessages([
      message({ messageType: 'tool_call', toolName: 'Shell', toolArgs: { command: 'npm test' } }),
      message({ messageType: 'tool_call', toolName: 'Read' }),
      message({ messageType: 'tool_result' }),
    ]);

    expect(summary.touchedFiles).toEqual([]);
    expect(summary.toolCalls).toBe(2);
    expect(summary.lastToolName).toBe('Read');
  });

  it('does not show files from failed file tool calls', () => {
    const summary = summarizeCocoMessages([
      message({
        id: 'write-call',
        messageType: 'tool_call',
        toolCallId: 'write-1',
        toolName: 'Write',
        toolArgs: { file_path: 'hello.py', content: 'print(1 + 1)' },
      }),
      message({
        id: 'write-result',
        messageType: 'tool_result',
        toolCallId: 'write-1',
        toolName: 'Write',
        isError: true,
      }),
      message({
        id: 'read-call',
        messageType: 'tool_call',
        toolCallId: 'read-1',
        toolName: 'Read',
        toolArgs: { file_path: '.' },
      }),
      message({
        id: 'read-result',
        messageType: 'tool_result',
        toolCallId: 'read-1',
        toolName: 'Read',
        isError: true,
      }),
    ]);

    expect(summary.touchedFiles).toEqual([]);
    expect(summary.toolErrors).toBe(2);
  });

  it('normalizes sandbox and absolute file paths for display', () => {
    const summary = summarizeCocoMessages([
      message({
        messageType: 'tool_call',
        toolName: 'Read',
        toolArgs: { file_path: '/workspace/src/server.ts' },
      }),
      message({
        messageType: 'tool_call',
        toolName: 'Read',
        toolArgs: { file_path: '/private/tmp/project/src/App.tsx' },
      }),
      message({
        messageType: 'tool_call',
        toolName: 'Read',
        toolArgs: { file_path: './README.md' },
      }),
      message({
        messageType: 'tool_call',
        toolName: 'Read',
        toolArgs: { file_path: '../../secrets/credentials' },
      }),
    ]);

    expect(summary.touchedFiles).toEqual([
      '.../project/src/App.tsx',
      'README.md',
      'secrets/credentials',
      'src/server.ts',
    ]);
  });

  it('caps client-derived file references to match server snapshots', () => {
    const summary = summarizeCocoMessages([
      message({
        messageType: 'tool_call',
        toolName: 'Read',
        toolArgs: { file_path: `/workspace/${'a'.repeat(180)}/index.ts` },
      }),
    ]);

    expect(summary.touchedFiles[0].length).toBeLessThanOrEqual(140);
    expect(summary.touchedFiles[0]).toContain('...');
  });

  it('merges fetched workspace snapshots with newer local message summaries', () => {
    expect(mergeCocoWorkspaceSummaries(
      {
        toolCalls: 2,
        toolResults: 1,
        toolErrors: 0,
        touchedFiles: ['src/App.tsx'],
        lastToolName: 'Edit',
      },
      {
        toolCalls: 1,
        toolResults: 3,
        toolErrors: 1,
        touchedFiles: ['README.md', 'src/App.tsx'],
        lastToolName: 'Read',
      }
    )).toEqual({
      toolCalls: 2,
      toolResults: 3,
      toolErrors: 1,
      touchedFiles: ['README.md', 'src/App.tsx'],
      lastToolName: 'Edit',
    });
  });

  it('does not use local message-derived files when there is no workspace snapshot', () => {
    expect(mergeCocoWorkspaceSummaries(
      {
        toolCalls: 1,
        toolResults: 0,
        toolErrors: 0,
        touchedFiles: ['src/App.tsx'],
        lastToolName: 'Read',
      },
      null
    )).toEqual({
      toolCalls: 1,
      toolResults: 0,
      toolErrors: 0,
      touchedFiles: [],
      lastToolName: 'Read',
    });
  });

  it('loads and validates a RoomTalk-mediated workspace snapshot over socket', async () => {
    const snapshot = {
      roomId: 'room-1',
      backend: 'coco',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: { toolCalls: 1, toolResults: 0, toolErrors: 0, touchedFiles: ['src/App.tsx'] },
      files: { touched: ['src/App.tsx'], hiddenCount: 0 },
      changes: { available: false, changedFiles: [], diffSummary: null },
      commands: [],
    };
    requestCodeAgentWorkspaceSnapshotMock.mockResolvedValue(snapshot);

    await expect(loadCodeAgentWorkspaceSnapshot('room 1')).resolves.toEqual(snapshot);
    expect(requestCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledWith('room 1');
  });

  it('rejects invalid workspace snapshot responses', async () => {
    requestCodeAgentWorkspaceSnapshotMock.mockResolvedValue({ backend: 'coco', source: 'messages', summary: { touchedFiles: null } });

    await expect(loadCodeAgentWorkspaceSnapshot('room-1')).rejects.toThrow('Workspace snapshot response is invalid');
  });
});
