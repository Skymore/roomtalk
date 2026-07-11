import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveGitHubConnectionConfig } from './githubConnectionConfig';

describe('resolveGitHubConnectionConfig', () => {
  it('is disabled by default', () => {
    assert.deepEqual(resolveGitHubConnectionConfig({}), { enabled: false, authEncryptionKey: undefined });
  });

  it('requires a key when enabled and can reuse the Codex encryption key', () => {
    assert.throws(() => resolveGitHubConnectionConfig({ GITHUB_CONNECTIONS_ENABLED: 'true' }), /AUTH_ENCRYPTION_KEY.*is required/i);
    assert.deepEqual(resolveGitHubConnectionConfig({
      GITHUB_CONNECTIONS_ENABLED: 'true',
      CODEX_AUTH_ENCRYPTION_KEY: ' shared-key ',
    }), { enabled: true, authEncryptionKey: 'shared-key' });
  });
});
