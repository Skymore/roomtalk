import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomStore } from '../repositories/store';
import type { Room } from '../types';
import { PersonalAgentChatTitleService } from './personalAgentChatTitles';

const model = { id: 'gpt-6-luna', apiModel: 'openai/gpt-6-luna', provider: 'openrouter' as const,
  label: 'Luna', description: '', pricing: { currency: 'USD' as const, inputPerMillion: 0.1, outputPerMillion: 0.5 } };
const fixture = () => {
  let room: Room = { id: 'side', name: 'Side chat', description: '', creatorId: 'owner', createdAt: '',
    personalAgentOwnerId: 'owner', personalAgentThreadKind: 'task', personalAgentAutoTitle: true };
  let content = '我想计划12月去滑雪，给我几个方案';
  const calls: any[] = [], charges: any[] = [];
  let response = async () => ({ choices: [{ message: { content: '“十二月滑雪计划”' } }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
  const store = { getRoomById: async () => room, readMessagesByRoom: async () => content ? [{ content, messageType: 'text' }] : [],
    updatePersonalAgentThread: async (_owner: string, _id: string, updates: any) => {
      if (!room.personalAgentAutoTitle) return null;
      room = { ...room, name: updates.name, personalAgentAutoTitle: false }; return room;
    }, settleAccountAIUsage: async (input: any) => { charges.push(input); },
  } as unknown as RoomStore;
  const updates: Room[] = [];
  const service = new PersonalAgentChatTitleService(store, model, () => ({ provider: 'openrouter',
    client: { chat: { completions: { create: async (request: any) => { calls.push(request); return response(); } } } } as any }),
    updated => updates.push(updated));
  return { service, calls, charges, updates, get room() { return room; }, set room(value: Room) { room = value; },
    set content(value: string) { content = value; }, set response(value: typeof response) { response = value; } };
};

describe('personal side chat titles', () => {
  it('generates one Luna title in the user language, accounts for usage and emits the update', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.service.generate('owner', 'side'), f.service.generate('owner', 'side')]);
    assert.equal(first?.name, '十二月滑雪计划'); assert.deepEqual(first, second);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, 'openai/gpt-6-luna');
    assert.match(f.calls[0].messages[1].content, /12月去滑雪/);
    assert.equal(f.charges[0].source, 'personal_chat_title'); assert.ok(f.charges[0].costUsd > 0);
    assert.equal(f.updates.length, 1); assert.equal(f.room.personalAgentAutoTitle, false);
    await f.service.generate('owner', 'side'); assert.equal(f.calls.length, 1);
  });

  it('does not call the model for empty, named, main, delegated or foreign chats', async () => {
    const f = fixture(); f.content = '';
    await f.service.generate('owner', 'side'); assert.equal(f.calls.length, 0);
    f.content = 'Ski trip';
    for (const change of [{ personalAgentAutoTitle: false }, { personalAgentThreadKind: 'main' as const },
      { personalAgentGoalId: 'goal' }, { personalAgentTaskKind: 'plan' as const }]) {
      const original = f.room; f.room = { ...original, ...change };
      await f.service.generate('owner', 'side'); f.room = original;
    }
    assert.equal(await f.service.generate('foreign-owner', 'side'), null); assert.equal(f.calls.length, 0);
  });

  it('preserves a manual rename while the provider is running and allows retry after an error', async () => {
    const f = fixture();
    f.response = async () => { throw new Error('Provider unavailable'); };
    await assert.rejects(f.service.generate('owner', 'side'), /Provider unavailable/);
    f.response = async () => {
      f.room = { ...f.room, name: '我的旅行', personalAgentAutoTitle: false };
      return { choices: [{ message: { content: '滑雪计划' } }], usage: { prompt_tokens: 30, completion_tokens: 8 } };
    };
    assert.equal((await f.service.generate('owner', 'side'))?.name, '我的旅行');
    assert.equal(f.updates.length, 0);
  });
});
