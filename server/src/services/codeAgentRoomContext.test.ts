import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { RoomStore } from '../repositories/store';
import { Message, Room } from '../types';
import { CodeAgentRoomContextService } from './codeAgentRoomContext';

const room: Room = {
  id: 'room-1', name: 'Workspace', description: '', createdAt: '2026-07-10T00:00:00.000Z',
  creatorId: 'client-1', type: 'codeAgent',
};

const messages: Message[] = [
  { id: 'm1', roomId: room.id, clientId: 'client-2', username: 'Sky', content: 'Earlier deployment discussion', timestamp: '2026-07-10T00:00:01.000Z', messageType: 'text' },
  { id: 'm2', roomId: room.id, clientId: 'ai_assistant', username: 'Codex', content: 'I will inspect it.', timestamp: '2026-07-10T00:00:02.000Z', messageType: 'ai', status: 'complete' },
  { id: 'm3', roomId: room.id, clientId: 'code_agent_runner', username: 'Codex', content: 'secret output', timestamp: '2026-07-10T00:00:03.000Z', messageType: 'tool_call', toolCallId: 'call-1', toolName: 'shell', toolArgs: { token: 'must-not-leak' } },
  { id: 'm4', roomId: room.id, clientId: 'ai_assistant', username: 'Codex', content: 'partial', timestamp: '2026-07-10T00:00:04.000Z', messageType: 'ai', status: 'streaming' },
  { id: 'm5', roomId: room.id, clientId: 'client-1', username: 'Owner', content: 'Please check deployment logs', timestamp: '2026-07-10T00:00:05.000Z', messageType: 'text', replyTo: { messageId: 'm1', messageType: 'text', preview: 'Earlier deployment discussion' } },
];

const createStore = () => ({
  async getRoomById(roomId: string) { return roomId === room.id ? room : null; },
  async getRoomMember() { return null; },
  async readMessagesByRoom(roomId: string) { return roomId === room.id ? messages : []; },
  async readMessagePageByRoom(roomId: string, input: { limit?: number; beforeMessageId?: string } = {}) {
    let end = messages.length;
    if (input.beforeMessageId) end = messages.findIndex(message => message.id === input.beforeMessageId);
    const limit = input.limit || 20;
    const start = Math.max(0, end - limit);
    return { roomId, messages: messages.slice(start, end), historyVersion: 5, hasMore: start > 0, oldestMessageId: messages[start]?.id };
  },
}) as unknown as RoomStore;

const createService = (nowMs = Date.parse('2026-07-10T00:10:00.000Z')) => new CodeAgentRoomContextService(createStore(), {
  tokenSecret: 'room-context-secret', nowMs: () => nowMs, createId: () => 'token-1', tokenTtlSeconds: 60,
});

const claims = (service: CodeAgentRoomContextService) => service.verifyTurnToken(service.issueTurnToken({
  roomId: room.id, clientId: 'client-1', turnId: 'turn-1', mode: 'plan',
}))!;

describe('CodeAgentRoomContextService', () => {
  it('issues a room-scoped expiring token', () => {
    const service = createService();
    const token = service.issueTurnToken({ roomId: room.id, clientId: 'client-1', turnId: 'turn-1', mode: 'plan' });
    assert.deepEqual(service.verifyTurnToken(token), {
      v: 1, jti: 'token-1', roomId: room.id, clientId: 'client-1', turnId: 'turn-1', mode: 'plan',
      exp: Math.floor(Date.parse('2026-07-10T00:10:00.000Z') / 1000) + 60,
    });
    assert.equal(service.verifyTurnToken(`${token}x`), null);
  });

  it('projects history without streaming messages or tool arguments', async () => {
    const service = createService();
    const result = await service.history(claims(service), { limit: 10 });
    assert.deepEqual(result.messages.map(message => message.id), ['m1', 'm2', 'm3', 'm5']);
    assert.equal(result.messages[2].tool?.name, 'shell');
    assert.equal('toolArgs' in result.messages[2], false);
    assert.equal(result.messages[3].replyTo?.messageId, 'm1');
  });

  it('supports delta, search, and exact reads', async () => {
    const service = createService();
    const tokenClaims = claims(service);
    const delta = await service.delta(tokenClaims, { sinceMessageId: 'm2', limit: 10 });
    assert.deepEqual(delta.messages.map(message => message.id), ['m3', 'm5']);
    const search = await service.search(tokenClaims, { query: 'DEPLOYMENT', limit: 10 });
    assert.deepEqual(search.messages.map(message => message.id), ['m5', 'm1']);
    assert.equal((await service.message(tokenClaims, 'm2')).message.content, 'I will inspect it.');
    await assert.rejects(() => service.message(tokenClaims, 'missing'), /Message not found/);
  });

  it('rechecks room access instead of trusting an unexpired token forever', async () => {
    const service = createService();
    const memberClaims = service.verifyTurnToken(service.issueTurnToken({
      roomId: room.id, clientId: 'client-2', turnId: 'turn-2', mode: 'plan',
    }))!;
    await assert.rejects(() => service.history(memberClaims, {}), /access has been revoked/);
  });
});
