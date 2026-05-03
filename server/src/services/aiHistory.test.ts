import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFinalAIHistory, selectAIHistory } from './aiHistory';
import { Message } from '../types';

const createMessage = (id: string): Message => ({
  id,
  clientId: id.startsWith('ai') ? 'ai_assistant' : 'client-1',
  content: `message ${id}`,
  roomId: 'room-1',
  timestamp: new Date(2026, 0, Number(id.replace(/\D/g, '')) || 1).toISOString(),
  messageType: id.startsWith('ai') ? 'ai' : 'text',
});

describe('selectAIHistory', () => {
  it('limits model context without discarding persistent history', () => {
    const fullHistory = ['m1', 'm2', 'm3', 'm4', 'm5'].map(createMessage);

    const selection = selectAIHistory(fullHistory, { maxContextMessages: 2 });
    const finalHistory = buildFinalAIHistory(selection.historyUsedForContext, createMessage('ai6'));

    assert.deepEqual(selection.contextMessages.map(message => message.id), ['m4', 'm5']);
    assert.deepEqual(selection.historyUsedForContext.map(message => message.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.deepEqual(finalHistory.map(message => message.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'ai6']);
  });

  it('truncates retry context before the retried message', () => {
    const fullHistory = ['m1', 'ai2', 'm3', 'ai4'].map(createMessage);

    const selection = selectAIHistory(fullHistory, { retryForMessageId: 'ai4', maxContextMessages: 10 });

    assert.equal(selection.truncationReason, 'retry');
    assert.deepEqual(selection.historyUsedForContext.map(message => message.id), ['m1', 'ai2', 'm3']);
    assert.deepEqual(selection.contextMessages.map(message => message.id), ['m1', 'ai2', 'm3']);
  });

  it('keeps the edited message and removes following history from the AI context', () => {
    const fullHistory = ['m1', 'ai2', 'm3', 'ai4'].map(createMessage);

    const selection = selectAIHistory(fullHistory, { editedMessageId: 'm3', maxContextMessages: 10 });

    assert.equal(selection.truncationReason, 'edit');
    assert.deepEqual(selection.historyUsedForContext.map(message => message.id), ['m1', 'ai2', 'm3']);
    assert.deepEqual(selection.contextMessages.map(message => message.id), ['m1', 'ai2', 'm3']);
  });
});
