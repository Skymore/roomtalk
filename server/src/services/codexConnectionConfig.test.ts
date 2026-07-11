import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoCodexApiKeyAuthEnv,
  resolveCodexConnectionConfig,
  sanitizeCodexChildEnv,
} from './codexConnectionConfig';

describe('resolveCodexConnectionConfig', () => {
  it('is disabled by default and does not require an encryption key', () => {
    assert.deepEqual(resolveCodexConnectionConfig({}), {
      enabled: false,
      authEncryptionKey: undefined,
      cliBin: 'codex',
      authScriptBin: undefined,
      authLoginTimeoutMs: 900_000,
      authRefreshLockTtlMs: 30_000,
      authRefreshWaitMs: 30_000,
      refreshTokenUrl: undefined,
      oauthClientId: undefined,
    });
  });

  it('requires an encryption key when Codex connections are enabled', () => {
    assert.throws(
      () => resolveCodexConnectionConfig({ CODEX_CONNECTIONS_ENABLED: 'true' }),
      /CODEX_AUTH_ENCRYPTION_KEY is required/
    );
  });

  it('resolves enabled config values', () => {
    assert.deepEqual(resolveCodexConnectionConfig({
      CODEX_CONNECTIONS_ENABLED: 'true',
      CODEX_AUTH_ENCRYPTION_KEY: ' secret ',
      CODEX_CLI_BIN: '/usr/local/bin/codex',
      CODEX_DEVICE_AUTH_SCRIPT_BIN: '/tmp/fake-script',
      CODEX_AUTH_LOGIN_TIMEOUT_MS: '120000',
      CODEX_AUTH_REFRESH_LOCK_TTL_MS: '15000',
      CODEX_AUTH_REFRESH_WAIT_MS: '45000',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://auth.example/token',
      CODEX_APP_SERVER_LOGIN_CLIENT_ID: 'codex-client',
    }), {
      enabled: true,
      authEncryptionKey: 'secret',
      cliBin: '/usr/local/bin/codex',
      authScriptBin: '/tmp/fake-script',
      authLoginTimeoutMs: 120_000,
      authRefreshLockTtlMs: 15_000,
      authRefreshWaitMs: 45_000,
      refreshTokenUrl: 'https://auth.example/token',
      oauthClientId: 'codex-client',
    });
  });

  it('rejects invalid login timeout values', () => {
    assert.throws(
      () => resolveCodexConnectionConfig({ CODEX_AUTH_LOGIN_TIMEOUT_MS: '0' }),
      /CODEX_AUTH_LOGIN_TIMEOUT_MS must be a positive integer/
    );
  });
});

describe('Codex subscription child environment guards', () => {
  it('rejects Codex API key auth environment variables', () => {
    assert.throws(
      () => assertNoCodexApiKeyAuthEnv({ CODEX_API_KEY: 'sk-test' }),
      /CODEX_API_KEY/
    );
  });

  it('allows server-side OpenAI API keys because child env sanitization strips them', () => {
    assert.doesNotThrow(
      () => assertNoCodexApiKeyAuthEnv({ OPENAI_API_KEY: 'sk-test' })
    );
  });

  it('strips Codex home and secret-like values from child env', () => {
    const sanitized = sanitizeCodexChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      CODEX_HOME: '/tmp/codex-home',
      OPENAI_API_KEY: 'sk-test',
      GITHUB_TOKEN: 'gh-token',
      SOME_SECRET: 'secret',
      PUBLIC_VALUE: 'visible',
    });

    assert.deepEqual(sanitized, {
      PATH: '/usr/bin',
      HOME: '/Users/test',
      PUBLIC_VALUE: 'visible',
    });
  });
});
