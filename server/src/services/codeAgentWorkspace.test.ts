import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCodeAgentWorkspaceSnapshot, sanitizeWorkspaceFileRef } from './codeAgentWorkspace';
import { Message, Room } from '../types';

const room: Room = {
  id: 'room-1',
  name: 'Coco',
  description: '',
  createdAt: '2026-05-29T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'coco',
  sandboxStatus: 'ready',
  cocoStatus: 'idle',
  cocoSessionId: 'session-1',
};

const toolCall = (overrides: Partial<Message> = {}): Message => ({
  id: 'tool-call-1',
  clientId: 'coco_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-29T00:00:00.000Z',
  messageType: 'tool_call',
  toolCallId: 'tool-1',
  toolName: 'Read',
  toolArgs: { file_path: '/workspace/project/src/App.tsx' },
  ...overrides,
});

const toolResult = (overrides: Partial<Message> = {}): Message => ({
  id: 'tool-result-1',
  clientId: 'coco_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-29T00:00:01.000Z',
  messageType: 'tool_result',
  toolCallId: 'tool-1',
  toolName: 'Read',
  toolOutputPreview: '# RoomTalk',
  ...overrides,
});

describe('code-agent workspace snapshots', () => {
  it('sanitizes workspace, relative, and absolute file references', () => {
    assert.equal(sanitizeWorkspaceFileRef('/workspace/project/src/App.tsx'), 'project/src/App.tsx');
    assert.equal(sanitizeWorkspaceFileRef('../src/../package.json'), 'src/package.json');
    assert.equal(sanitizeWorkspaceFileRef('/private/var/folders/secret/workspace/file.ts'), '.../secret/workspace/file.ts');
    assert.equal(sanitizeWorkspaceFileRef('/workspace'), '.');
  });

  it('derives read-only workspace state from persisted Coco messages', () => {
    const snapshot = buildCodeAgentWorkspaceSnapshot(room, [
      toolCall(),
      toolResult({ isError: true, exitCode: 2, toolOutputPreview: 'failed\nwith details' }),
    ], new Date('2026-05-29T01:00:00.000Z'));

    assert.equal(snapshot.roomId, 'room-1');
    assert.equal(snapshot.backend, 'coco');
    assert.equal(snapshot.source, 'sandbox');
    assert.equal(snapshot.generatedAt, '2026-05-29T01:00:00.000Z');
    assert.deepEqual(snapshot.status, {
      sandboxStatus: 'ready',
      agentStatus: 'idle',
      hasSession: true,
    });
    assert.deepEqual(snapshot.summary, {
      toolCalls: 1,
      toolResults: 1,
      toolErrors: 1,
      touchedFiles: [],
      lastToolName: 'Read',
    });
    assert.deepEqual(snapshot.files, { touched: [], hiddenCount: 0 });
    assert.deepEqual(snapshot.changes, { available: false, changedFiles: [], diffSummary: null });
    assert.deepEqual(snapshot.commands, [{
      id: 'tool-1',
      name: 'Read',
      status: 'failed',
      exitCode: 2,
      preview: 'failed with details',
    }]);
  });

  it('does not show failed file tool calls as touched files', () => {
    const snapshot = buildCodeAgentWorkspaceSnapshot(room, [
      toolCall({
        id: 'write-call',
        toolCallId: 'write-1',
        toolName: 'Write',
        toolArgs: { file_path: 'hello.py', content: 'print(1 + 1)' },
      }),
      toolResult({
        id: 'write-result',
        toolCallId: 'write-1',
        toolName: 'Write',
        isError: true,
        toolOutputPreview: "Error: unknown tool 'Write'",
      }),
      toolCall({
        id: 'read-call',
        toolCallId: 'read-1',
        toolName: 'Read',
        toolArgs: { file_path: '.' },
      }),
      toolResult({
        id: 'read-result',
        toolCallId: 'read-1',
        toolName: 'Read',
        isError: true,
        toolOutputPreview: 'Error: Not a file: .',
      }),
    ]);

    assert.deepEqual(snapshot.summary.touchedFiles, []);
    assert.deepEqual(snapshot.files, { touched: [], hiddenCount: 0 });
    assert.equal(snapshot.summary.toolErrors, 2);
  });

  it('limits file refs and command history for browser payloads', () => {
    const messages = Array.from({ length: 45 }, (_, index): Message => toolCall({
      id: `tool-call-${index}`,
      toolCallId: `tool-${index}`,
      toolArgs: { file_path: `/workspace/src/file-${index}.ts` },
    }));

    const workspaceFiles = Array.from({ length: 45 }, (_, index) => `/workspace/output/file-${index}.txt`);
    const snapshot = buildCodeAgentWorkspaceSnapshot(room, messages, new Date(), workspaceFiles);

    assert.equal(snapshot.files.touched.length, 40);
    assert.equal(snapshot.files.hiddenCount, 5);
    assert.equal(snapshot.commands.length, 20);
    assert.equal(snapshot.commands[0].id, 'tool-25');
    assert.ok(snapshot.files.touched.includes('output/file-0.txt'));
    assert.equal(snapshot.files.touched.includes('src/file-0.ts'), false);
  });

  it('uses real workspace files instead of inferring files from tool messages', () => {
    const snapshot = buildCodeAgentWorkspaceSnapshot(room, [
      toolCall({
        toolName: 'Read',
        toolArgs: { file_path: '/workspace/src/App.tsx' },
      }),
      toolResult({ toolName: 'Read', toolOutputPreview: 'ok' }),
      toolCall({
        id: 'shell-call',
        toolCallId: 'shell-1',
        toolName: 'Shell',
        toolArgs: { command: 'python plot.py' },
      }),
      toolResult({
        id: 'shell-result',
        toolCallId: 'shell-1',
        toolName: 'Shell',
        toolOutputPreview: 'wrote /workspace/plot_output.png',
      }),
    ], new Date(), ['/workspace/plot_output.png', '/workspace/output/report.html']);

    assert.deepEqual(snapshot.summary.touchedFiles, ['output/report.html', 'plot_output.png']);
    assert.deepEqual(snapshot.files, { touched: ['output/report.html', 'plot_output.png'], hiddenCount: 0 });
  });

  it('redacts common secret-shaped values from command previews', () => {
    const snapshot = buildCodeAgentWorkspaceSnapshot(room, [
      toolCall({ toolArgs: { command: 'echo API_KEY=sk-testsecretvalue123456 token=e2b_testsecretvalue123456' } }),
      toolCall({
        id: 'tool-call-2',
        toolCallId: 'tool-2',
        toolArgs: { secret: 'plain-text-secret', path: 'src/App.tsx' },
      }),
    ]);

    assert.equal(snapshot.commands[0].preview, 'echo API_KEY=[redacted] token=[redacted]');
    assert.equal(snapshot.commands[1].preview, '{"secret":"[redacted]","path":"src/App.tsx"}');
  });
});
