import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAIStreamOwnerId } from './aiStreamRecovery';

describe('resolveAIStreamOwnerId', () => {
  it('keeps owners unique per runtime instance even under one deployment namespace', () => {
    const env = { AI_STREAM_OWNER_ID: 'roomtalk-production' } as NodeJS.ProcessEnv;

    const first = resolveAIStreamOwnerId(env, 'instance-a');
    const second = resolveAIStreamOwnerId(env, 'instance-b');

    assert.notEqual(first, second);
    assert.equal(first, resolveAIStreamOwnerId(env, 'instance-a'));
  });
});
