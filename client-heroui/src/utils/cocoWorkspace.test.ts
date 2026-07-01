// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from './types';
import {
  loadCodeAgentWorkspaceDiff,
  loadCodeAgentWorkspaceRefs,
  loadCodeAgentWorkspaceSnapshot,
  summarizeCocoMessages,
} from './cocoWorkspace';

const requestCodeAgentWorkspaceSnapshotMock = vi.hoisted(() => vi.fn());
const requestCodeWorkspaceDiffMock = vi.hoisted(() => vi.fn());
const requestCodeWorkspaceRefsMock = vi.hoisted(() => vi.fn());

vi.mock('./socket', () => ({
  requestCodeAgentWorkspaceSnapshot: requestCodeAgentWorkspaceSnapshotMock,
  requestCodeWorkspaceDiff: requestCodeWorkspaceDiffMock,
  requestCodeWorkspaceRefs: requestCodeWorkspaceRefsMock,
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
    requestCodeWorkspaceDiffMock.mockReset();
    requestCodeWorkspaceRefsMock.mockReset();
  });

  it('returns an empty summary when there is no tool activity', () => {
    expect(summarizeCocoMessages([])).toEqual({
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      lastToolName: undefined,
    });
  });

  it('counts tool calls, results, errors, and latest tool', () => {
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
      lastToolName: 'Glob',
    });
  });

  it('loads and validates a RoomTalk-mediated workspace snapshot over socket', async () => {
    const snapshot = {
      roomId: 'room-1',
      backend: 'coco',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: { toolCalls: 1, toolResults: 0, toolErrors: 0 },
      artifacts: [{
        slug: 'roomtalk-demo',
        title: 'RoomTalk Demo',
        url: 'https://room.ruit.me/p/roomtalk-demo/',
        entry: 'index.html',
        versionId: '20260630T120000Z_aaaaaaaa',
        fileCount: 1,
        totalBytes: 128,
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      }],
      changes: { available: false, changedFiles: [], diffSummary: null },
      commands: [],
    };
    requestCodeAgentWorkspaceSnapshotMock.mockResolvedValue(snapshot);

    await expect(loadCodeAgentWorkspaceSnapshot('room 1')).resolves.toEqual(snapshot);
    expect(requestCodeAgentWorkspaceSnapshotMock).toHaveBeenCalledWith('room 1');
  });

  it('loads workspace diffs over socket with the T3 whitespace option', async () => {
    const diff = {
      available: true,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
      byteSize: 42,
      truncated: false,
    };
    requestCodeWorkspaceDiffMock.mockResolvedValue(diff);

    await expect(loadCodeAgentWorkspaceDiff('room-1', { ignoreWhitespace: true, baseRef: 'origin/main' })).resolves.toEqual(diff);
    expect(requestCodeWorkspaceDiffMock).toHaveBeenCalledWith('room-1', { ignoreWhitespace: true, scope: 'branch', baseRef: 'origin/main' });
  });

  it('loads and validates workspace refs over socket', async () => {
    const refs = {
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'bad', kind: 'tag' },
      ],
    };
    requestCodeWorkspaceRefsMock.mockResolvedValue(refs);

    await expect(loadCodeAgentWorkspaceRefs('room-1', { query: 'main', limit: 25 })).resolves.toEqual({
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
      ],
    });
    expect(requestCodeWorkspaceRefsMock).toHaveBeenCalledWith('room-1', { query: 'main', limit: 25 });
  });

  it('normalizes missing workspace artifacts to an empty list for older servers', async () => {
    const snapshot = {
      roomId: 'room-1',
      backend: 'coco',
      source: 'sandbox',
      generatedAt: '2026-05-29T00:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
      summary: { toolCalls: 1, toolResults: 0, toolErrors: 0 },
      changes: { available: false, changedFiles: [], diffSummary: null },
      commands: [],
    };
    requestCodeAgentWorkspaceSnapshotMock.mockResolvedValue(snapshot);

    await expect(loadCodeAgentWorkspaceSnapshot('room-1')).resolves.toEqual({
      ...snapshot,
      artifacts: [],
    });
  });

  it('rejects invalid workspace snapshot responses', async () => {
    requestCodeAgentWorkspaceSnapshotMock.mockResolvedValue({ backend: 'coco', source: 'messages', summary: {} });

    await expect(loadCodeAgentWorkspaceSnapshot('room-1')).rejects.toThrow('Workspace snapshot response is invalid');
  });
});
