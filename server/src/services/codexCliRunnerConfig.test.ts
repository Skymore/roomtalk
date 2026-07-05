import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCodexBackendStartupGate, resolveCodexCliRunnerConfig } from './codexCliRunnerConfig';

describe('resolveCodexCliRunnerConfig', () => {
  it('is disabled by default', () => {
    assert.deepEqual(resolveCodexCliRunnerConfig({}), {
      enabled: false,
      cliBin: 'codex',
      sandbox: 'workspace-write',
      timeoutMs: 600_000,
      maxStderrTailChars: 4000,
    });
  });

  it('resolves explicit enabled config', () => {
    assert.deepEqual(resolveCodexCliRunnerConfig({
      CODEX_CLI_BACKEND_ENABLED: 'true',
      CODEX_CLI_BIN: '/usr/local/bin/codex',
      CODEX_CLI_SANDBOX: 'workspace-write',
      CODEX_CLI_TIMEOUT_MS: '30000',
      CODEX_CLI_MAX_STDERR_TAIL_CHARS: '1000',
    }), {
      enabled: true,
      cliBin: '/usr/local/bin/codex',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      maxStderrTailChars: 1000,
    });
  });

  it('rejects Codex API key auth when the Codex CLI backend is enabled', () => {
    assert.throws(
      () => resolveCodexCliRunnerConfig({
        CODEX_CLI_BACKEND_ENABLED: 'true',
        CODEX_API_KEY: 'sk-test',
      }),
      /CODEX_API_KEY/
    );
  });

  it('rejects danger-full-access even if explicitly allowed', () => {
    assert.throws(
      () => resolveCodexCliRunnerConfig({ CODEX_CLI_SANDBOX: 'danger-full-access' }),
      /danger-full-access/
    );
    assert.throws(
      () => resolveCodexCliRunnerConfig({ CODEX_CLI_ALLOW_DANGER_FULL_ACCESS: 'true' }),
      /danger-full-access/
    );
  });

  it('rejects unsupported sandbox modes and invalid numbers', () => {
    assert.throws(
      () => resolveCodexCliRunnerConfig({ CODEX_CLI_SANDBOX: 'read-only' }),
      /Unsupported Codex CLI sandbox mode/
    );
    assert.throws(
      () => resolveCodexCliRunnerConfig({ CODEX_CLI_TIMEOUT_MS: '0' }),
      /CODEX_CLI_TIMEOUT_MS must be a positive integer/
    );
    assert.throws(
      () => resolveCodexCliRunnerConfig({ CODEX_CLI_MAX_STDERR_TAIL_CHARS: '-1' }),
      /CODEX_CLI_MAX_STDERR_TAIL_CHARS must be a positive integer/
    );
  });
});

describe('assertCodexBackendStartupGate', () => {
  it('allows Codex backend startup once CLI backend and connection service are configured', () => {
    assert.doesNotThrow(() => assertCodexBackendStartupGate({
      codeAgentRuntimeConfig: { backend: 'codex' },
      codexCliRunnerConfig: { enabled: true },
      codexConnectionConfig: { enabled: true },
      hasCodexConnectionService: true,
    }));
    assert.doesNotThrow(() => assertCodexBackendStartupGate({
      codeAgentRuntimeConfig: { backend: 'codex-app-server' },
      codexCliRunnerConfig: { enabled: true },
      codexConnectionConfig: { enabled: true },
      hasCodexConnectionService: true,
    }));
  });

  it('rejects Codex backend startup without required Codex flags and service', () => {
    assert.throws(
      () => assertCodexBackendStartupGate({
        codeAgentRuntimeConfig: { backend: 'codex' },
        codexCliRunnerConfig: { enabled: false },
        codexConnectionConfig: { enabled: true },
        hasCodexConnectionService: true,
      }),
      /CODEX_CLI_BACKEND_ENABLED=true/
    );
    assert.throws(
      () => assertCodexBackendStartupGate({
        codeAgentRuntimeConfig: { backend: 'codex' },
        codexCliRunnerConfig: { enabled: true },
        codexConnectionConfig: { enabled: false },
        hasCodexConnectionService: false,
      }),
      /CODEX_CONNECTIONS_ENABLED=true/
    );
  });
});
