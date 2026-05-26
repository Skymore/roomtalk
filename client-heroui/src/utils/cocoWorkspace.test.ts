import { describe, expect, it } from 'vitest';
import { Message } from './types';
import { summarizeCocoMessages } from './cocoWorkspace';

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
        toolName: 'Read',
        toolArgs: { file_path: 'src/App.tsx' },
      }),
      message({
        id: 'call-2',
        messageType: 'tool_call',
        toolName: 'Edit',
        toolArgs: { path: 'src/App.tsx' },
      }),
      message({
        id: 'result-1',
        messageType: 'tool_result',
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
});
