import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GitHubConnectionError,
  GitHubConnectionService,
  GitHubTokenCipher,
  InMemoryGitHubConnectionStore,
} from './githubConnection';

const token = 'github_pat_test_token_that_is_long_enough';
const account = { id: 42, login: 'ada', name: 'Ada' };

describe('GitHub connection', () => {
  it('encrypts PATs at rest and never returns them in public status', async () => {
    const store = new InMemoryGitHubConnectionStore();
    const service = new GitHubConnectionService(
      store,
      new GitHubTokenCipher('test-secret', 'key-v1'),
      async candidate => {
        assert.equal(candidate, token);
        return account;
      },
      () => new Date('2026-07-11T12:00:00.000Z')
    );

    const status = await service.connect('client-1', token);
    assert.equal(status.status, 'connected');
    assert.deepEqual(status.account, account);
    assert.equal(JSON.stringify(status).includes(token), false);

    const stored = await store.getConnection('client-1');
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(await service.getAccessToken('client-1'), token);
  });

  it('rejects invalid tokens and disconnects cleanly', async () => {
    const store = new InMemoryGitHubConnectionStore();
    const service = new GitHubConnectionService(
      store,
      new GitHubTokenCipher('test-secret'),
      async () => { throw new GitHubConnectionError('rejected', 'invalid_token'); }
    );

    await assert.rejects(
      () => service.connect('client-1', token),
      (error: unknown) => error instanceof GitHubConnectionError && error.code === 'invalid_token'
    );
    assert.equal((await service.getConnectionStatus('client-1')).status, 'disconnected');
    assert.equal((await service.disconnect('client-1')).status, 'disconnected');
  });

  it('fails closed when the encryption key is missing or wrong', () => {
    assert.throws(() => new GitHubTokenCipher(''), /encryption secret is required/);
    const encrypted = new GitHubTokenCipher('secret-a').encrypt(token);
    assert.throws(() => new GitHubTokenCipher('secret-b').decrypt(encrypted), /Unable to decrypt/);
  });
});
