import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Message } from '../types';
import { buildCodeAgentPriorMessages } from './codeAgentTranscript';

const message = (overrides: Partial<Message>): Message => ({
  id: overrides.id || 'message-1',
  clientId: overrides.clientId || 'client-1',
  content: overrides.content || '',
  roomId: 'room-1',
  timestamp: overrides.timestamp || '2026-05-03T00:00:00.000Z',
  messageType: overrides.messageType || 'text',
  ...overrides,
});

describe('code-agent transcript projection', () => {
  it('projects RoomTalk user, assistant, and tool messages into code-agent prior_messages', () => {
    const transcript = buildCodeAgentPriorMessages([
      message({ id: 'u1', content: 'list files' }),
      message({ id: 'ai1', clientId: 'ai_assistant', messageType: 'ai', content: 'I will inspect.', status: 'complete' }),
      message({
        id: 'call1',
        clientId: 'code_agent_runner',
        messageType: 'tool_call',
        content: 'Glob {"pattern":"**/*"}',
        toolCallId: 'tool-1',
        toolName: 'Glob',
        toolArgs: { pattern: '**/*' },
      }),
      message({
        id: 'result1',
        clientId: 'code_agent_runner',
        messageType: 'tool_result',
        content: 'No files found matching the pattern.',
        toolCallId: 'tool-1',
        toolName: 'Glob',
        toolOutputPreview: 'No files found matching the pattern.',
      }),
      message({ id: 'ai2', clientId: 'ai_assistant', messageType: 'ai', content: 'The directory is empty.', status: 'complete' }),
    ]);

    assert.deepEqual(transcript, [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect.' },
          { type: 'tool_use', id: 'tool-1', name: 'Glob', input: { pattern: '**/*' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'No files found matching the pattern.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The directory is empty.' },
        ],
      },
    ]);
  });

  it('groups adjacent tool calls and tool results in deterministic code-agent message blocks', () => {
    const transcript = buildCodeAgentPriorMessages([
      message({ id: 'ai1', clientId: 'ai_assistant', messageType: 'ai', content: 'I will run two checks.', status: 'complete' }),
      message({
        id: 'call1',
        clientId: 'code_agent_runner',
        messageType: 'tool_call',
        content: 'Read',
        toolCallId: 'tool-1',
        toolName: 'Read',
        toolArgs: { file_path: 'README.md' },
      }),
      message({
        id: 'call2',
        clientId: 'code_agent_runner',
        messageType: 'tool_call',
        content: 'Grep',
        toolCallId: 'tool-2',
        toolName: 'Grep',
        toolArgs: { pattern: 'RoomTalk' },
      }),
      message({
        id: 'result1',
        clientId: 'code_agent_runner',
        messageType: 'tool_result',
        content: '# RoomTalk',
        toolCallId: 'tool-1',
        toolName: 'Read',
      }),
      message({
        id: 'result2',
        clientId: 'code_agent_runner',
        messageType: 'tool_result',
        content: 'Error: missing pattern',
        toolCallId: 'tool-2',
        toolName: 'Grep',
        status: 'error',
        isError: true,
      }),
    ]);

    assert.deepEqual(transcript, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run two checks.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'RoomTalk' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: '# RoomTalk' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'Error: missing pattern', is_error: true },
        ],
      },
    ]);
  });

  it('uses full tool result content instead of the UI preview when both exist', () => {
    const transcript = buildCodeAgentPriorMessages([
      message({
        id: 'call1',
        clientId: 'code_agent_runner',
        messageType: 'tool_call',
        content: 'Read',
        toolCallId: 'tool-1',
        toolName: 'Read',
        toolArgs: { file_path: 'README.md' },
      }),
      message({
        id: 'result1',
        clientId: 'code_agent_runner',
        messageType: 'tool_result',
        content: 'full output'.repeat(100),
        toolOutputPreview: 'full output',
        toolCallId: 'tool-1',
      }),
    ]);

    const content = transcript[1].content;
    const firstBlock = Array.isArray(content) ? content[0] : null;
    assert.equal(firstBlock?.type === 'tool_result' ? firstBlock.content : '', 'full output'.repeat(100));
  });

  it('skips non-terminal and failed AI placeholders', () => {
    const transcript = buildCodeAgentPriorMessages([
      message({ id: 'ai-streaming', clientId: 'ai_assistant', messageType: 'ai', content: 'partial', status: 'streaming' }),
      message({ id: 'ai-error', clientId: 'ai_assistant', messageType: 'ai', content: 'Coco Agent task failed', status: 'error' }),
      message({ id: 'ai-complete', clientId: 'ai_assistant', messageType: 'ai', content: 'Recovered answer.', status: 'complete' }),
    ]);

    assert.deepEqual(transcript, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Recovered answer.' },
        ],
      },
    ]);
  });

  it('skips dangling tool calls and tool results that would make provider history invalid', () => {
    const transcript = buildCodeAgentPriorMessages([
      message({ id: 'ai1', clientId: 'ai_assistant', messageType: 'ai', content: 'I will inspect.', status: 'complete' }),
      message({
        id: 'dangling-call',
        clientId: 'code_agent_runner',
        messageType: 'tool_call',
        content: 'Read',
        toolCallId: 'tool-dangling',
        toolName: 'Read',
        toolArgs: { file_path: 'README.md' },
      }),
      message({
        id: 'dangling-result',
        clientId: 'code_agent_runner',
        messageType: 'tool_result',
        content: 'orphan output',
        toolCallId: 'tool-orphan',
        toolName: 'Read',
      }),
    ]);

    assert.deepEqual(transcript, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect.' },
        ],
      },
    ]);
  });
});
