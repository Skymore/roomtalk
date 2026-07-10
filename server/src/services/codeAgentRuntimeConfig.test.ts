import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CODE_AGENT_E2B_KILL_TIMEOUT_MS,
  DEFAULT_CODE_AGENT_E2B_PAUSE_TIMEOUT_MS,
  DEFAULT_CODE_AGENT_DAEMON_COMMAND,
  DEFAULT_CODE_AGENT_RUNNER_COMMAND,
  DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
  DEFAULT_CODEX_CLI_RUNNER_COMMAND,
  DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
  DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
  DEFAULT_NODE_PATH,
  DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
  resolveCodeAgentRuntimeConfig,
} from './codeAgentRuntimeConfig';

const pinnedArtifactEnv = {
  CODE_AGENT_ARTIFACT_VERSION: 'roomtalk-code-agent-2026-06-28-a4e70e6',
  CODE_AGENT_SOURCE_REF: 'a4e70e674e46d59a63874371276f5fec0fcd3f41',
};

const e2bCredentialEnv = {
  E2B_API_KEY: 'e2b-test-key',
};

const scopedProviderKeyEnv = {
  CODE_AGENT_SCOPED_PROVIDER_KEY: 'true',
  CODE_AGENT_SCOPED_PROVIDER_KEY_TTL_SECONDS: '900',
  CODE_AGENT_SCOPED_PROVIDER_KEY_BUDGET_USD: '0.25',
  CODE_AGENT_SCOPED_PROVIDER_KEY_AUDIT_ID: 'turn-audit-1',
};

const modelProxyEnv = {
  CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
  CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
  CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
};

describe('resolveCodeAgentRuntimeConfig', () => {
  it('defaults to disabled fake sandbox and fake runner', () => {
    const config = resolveCodeAgentRuntimeConfig({});

    assert.equal(config.enabled, false);
    assert.equal(config.backend, 'code-agent');
    assert.equal(config.sandboxProvider, 'fake');
    assert.equal(config.runnerClient, 'fake');
    assert.equal(config.artifactMode, 'production');
    assert.equal(config.mode, 'plan');
    assert.deepEqual(config.availableModes, ['plan']);
    assert.equal(config.defaultMode, 'plan');
    assert.equal(config.modelGateway, undefined);
    assert.equal(config.runnerCommand, DEFAULT_CODE_AGENT_RUNNER_COMMAND);
    assert.equal(config.daemonCommand, DEFAULT_CODE_AGENT_DAEMON_COMMAND);
    assert.deepEqual(config.allowedPaths, ['.']);
    assert.deepEqual(config.runnerEnv, {});
    assert.deepEqual(config.e2bLifecycle, { onTimeout: 'pause', autoResume: true, keepMemory: true });
    assert.equal(DEFAULT_CODE_AGENT_E2B_PAUSE_TIMEOUT_MS, 5 * 60 * 1000);
    assert.equal(DEFAULT_CODE_AGENT_E2B_KILL_TIMEOUT_MS, 60 * 60 * 1000);
  });

  it('accepts only implemented code-agent backends', () => {
    assert.equal(resolveCodeAgentRuntimeConfig({ CODE_AGENT_BACKEND: 'code-agent' }).backend, 'code-agent');
    assert.equal(resolveCodeAgentRuntimeConfig({ CODEX_CLI_BACKEND_ENABLED: 'true' }).backend, 'codex-app-server');
    assert.throws(
      () => resolveCodeAgentRuntimeConfig({ CODE_AGENT_BACKEND: 'codex' }),
      /CODE_AGENT_BACKEND=codex requires CODEX_CLI_BACKEND_ENABLED=true/
    );
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'codex',
      CODEX_CLI_BACKEND_ENABLED: 'true',
    }).backend, 'codex');
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'codex',
      CODEX_CLI_BACKEND_ENABLED: 'true',
    }).runnerCommand, DEFAULT_CODEX_CLI_RUNNER_COMMAND);
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'codex-app-server',
      CODEX_CLI_BACKEND_ENABLED: 'true',
    }).backend, 'codex-app-server');
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'codex-app-server',
      CODEX_CLI_BACKEND_ENABLED: 'true',
    }).runnerCommand, DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND);
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'code-agent',
    }).runnerCommandByBackend['codex-app-server'], DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND);
    assert.equal(resolveCodeAgentRuntimeConfig({
      CODE_AGENT_BACKEND: 'codex',
      CODEX_CLI_BACKEND_ENABLED: 'true',
      CODE_AGENT_RUNNER_COMMAND: 'custom runner',
    }).runnerCommand, 'custom runner');
    assert.throws(() => resolveCodeAgentRuntimeConfig({ CODE_AGENT_BACKEND: 'unknown' }), /Unsupported CODE_AGENT_BACKEND: unknown/);
  });

  it('falls back to plan mode and warns when CODE_AGENT_MODE is invalid', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const config = resolveCodeAgentRuntimeConfig({ CODE_AGENT_MODE: 'accept_edits' });

      assert.equal(config.mode, 'plan');
      assert.deepEqual(config.availableModes, ['plan']);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Unsupported CODE_AGENT_MODE: accept_edits/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('supports explicit per-turn mode availability with plan as the default', () => {
    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ALLOWED_RUN_MODES: 'acceptEdits',
    });

    assert.equal(config.mode, 'edit');
    assert.deepEqual(config.availableModes, ['plan', 'edit']);
    assert.equal(config.defaultMode, 'plan');

    const editDefault = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ALLOWED_RUN_MODES: 'plan,acceptEdits',
      CODE_AGENT_DEFAULT_MODE: 'acceptEdits',
    });
    assert.equal(editDefault.defaultMode, 'edit');

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ALLOWED_RUN_MODES: 'plan,writeEverything',
    }), /Unsupported CODE_AGENT_ALLOWED_RUN_MODES entry/);
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ALLOWED_RUN_MODES: 'plan',
      CODE_AGENT_DEFAULT_MODE: 'acceptEdits',
    }), /must be included in CODE_AGENT_ALLOWED_RUN_MODES/);
  });

  it('rejects jsonl runner with fake sandbox when code agent is enabled', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
    }), /requires a non-fake sandbox provider/);
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_RUNNER_CLIENT: 'daemon',
      CODE_AGENT_MODE: 'plan',
    }), /requires a non-fake sandbox provider/);
  });

  it('rejects E2B fake-runner pairing outside explicit test mode', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'fake',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
    }), /requires CODE_AGENT_RUNNER_CLIENT=jsonl/);

    const testConfig = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'fake',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      E2E_TEST_MODE: 'true',
    });
    assert.equal(testConfig.sandboxProvider, 'e2b');
    assert.equal(testConfig.runnerClient, 'fake');
  });

  it('rejects E2B without a template id', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      ...pinnedArtifactEnv,
    }), /requires CODE_AGENT_E2B_TEMPLATE_ID/);
  });

  it('requires pinned production artifact metadata for E2B JSONL mode', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ...e2bCredentialEnv,
    }), /requires CODE_AGENT_ARTIFACT_VERSION and CODE_AGENT_SOURCE_REF/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_SOURCE_DIR: '/Users/sky/projects/code-agent-engine/src',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /must use the pinned sandbox artifact/);
  });

  it('supports daemon runner mode with the same E2B artifact contract as JSONL', () => {
    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'daemon',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_DAEMON_COMMAND: 'python -m custom_daemon',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });

    assert.equal(config.runnerClient, 'daemon');
    assert.equal(config.daemonCommand, 'python -m custom_daemon');
    assert.deepEqual(config.runnerEnv, {
      PYTHONPATH: DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
      CODE_AGENT_WORKSPACE_ROOT: DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
      PLAYWRIGHT_BROWSERS_PATH: DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
      NODE_PATH: DEFAULT_NODE_PATH,
    });
  });

  it('requires E2B credentials for enabled E2B JSONL mode', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ...pinnedArtifactEnv,
    }), /requires E2B_API_KEY or E2B_ACCESS_TOKEN/);
  });

  it('configures E2B pause and auto-resume lifecycle with safe validation', () => {
    const paused = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });
    assert.deepEqual(paused.e2bLifecycle, { onTimeout: 'pause', autoResume: true, keepMemory: true });

    const kill = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_E2B_ON_TIMEOUT: 'kill',
      CODE_AGENT_E2B_AUTO_RESUME: 'false',
    });
    assert.deepEqual(kill.e2bLifecycle, { onTimeout: 'kill', autoResume: false, keepMemory: true });

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_E2B_ON_TIMEOUT: 'kill',
      CODE_AGENT_E2B_AUTO_RESUME: 'true',
    }), /requires CODE_AGENT_E2B_ON_TIMEOUT=pause/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_E2B_ON_TIMEOUT: 'pause',
      CODE_AGENT_E2B_KEEP_MEMORY: 'false',
      CODE_AGENT_E2B_AUTO_RESUME: 'true',
    }), /requires CODE_AGENT_E2B_KEEP_MEMORY=true/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_E2B_ON_TIMEOUT: 'hibernate',
    }), /Unsupported CODE_AGENT_E2B_ON_TIMEOUT/);
  });

  it('allows local code-agent source mounts only in development artifact mode', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_ARTIFACT_MODE: 'development',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dev',
      ...e2bCredentialEnv,
    }), /requires CODE_AGENT_SOURCE_DIR/);

    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_ARTIFACT_MODE: 'development',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dev',
      CODE_AGENT_SOURCE_DIR: '/Users/sky/projects/code-agent-engine/src',
      ...e2bCredentialEnv,
    });

    assert.equal(config.artifactMode, 'development');
    assert.equal(config.runnerEnv.PYTHONPATH, DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH);
    assert.equal(config.runnerEnv.PLAYWRIGHT_BROWSERS_PATH, DEFAULT_PLAYWRIGHT_BROWSERS_PATH);
    assert.equal(config.runnerEnv.NODE_PATH, DEFAULT_NODE_PATH);
    assert.equal(config.runnerEnv.CODE_AGENT_SOURCE_DIR, '/Users/sky/projects/code-agent-engine/src');
    assert.equal(config.artifactVersion, undefined);
    assert.equal(config.codeAgentSourceRef, undefined);
  });

  it('allows JSONL plan mode with E2B and only selected allowlisted env groups', () => {
    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      ANTHROPIC_API_KEY: 'anthropic-key',
      UNRELATED_SECRET: 'must-not-leak',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });

    assert.deepEqual(config.runnerEnv, {
      PYTHONPATH: DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
      CODE_AGENT_WORKSPACE_ROOT: DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
      PLAYWRIGHT_BROWSERS_PATH: DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
      NODE_PATH: DEFAULT_NODE_PATH,
    });
    assert.equal(config.artifactVersion, pinnedArtifactEnv.CODE_AGENT_ARTIFACT_VERSION);
    assert.equal(config.codeAgentSourceRef, pinnedArtifactEnv.CODE_AGENT_SOURCE_REF);
    assert.deepEqual(config.runnerProviderEnvByProvider.deepseek, {
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    });
    assert.deepEqual(config.runnerProviderEnvByProvider.anthropic, {
      ANTHROPIC_API_KEY: 'anthropic-key',
    });
    assert.equal('UNRELATED_SECRET' in config.runnerEnv, false);
  });

  it('rejects JSONL acceptEdits/write/Shell without proxy or scoped-key model access', () => {
    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'acceptEdits',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires RoomTalk model gateway, model proxy with token, or scoped provider key contract/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ROOMTALK_CODE_AGENT_ALLOW_SHELL: 'true',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires RoomTalk model gateway, model proxy with token, or scoped provider key contract/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS CODE_AGENT_MODEL_PROXY_URL and CODE_AGENT_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
      CODE_AGENT_MODEL_PROXY_URL: 'http://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS CODE_AGENT_MODEL_PROXY_URL and CODE_AGENT_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /require CODE_AGENT_MODEL_ACCESS_STRATEGY=proxy/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    }), /require CODE_AGENT_MODEL_ACCESS_STRATEGY=proxy/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
      CODE_AGENT_MODEL_PROXY_URL: 'http://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    }), /requires HTTPS CODE_AGENT_MODEL_PROXY_URL and CODE_AGENT_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: '   ',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS CODE_AGENT_MODEL_PROXY_URL and CODE_AGENT_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_SCOPED_PROVIDER_KEY: 'true',
      CODE_AGENT_SCOPED_PROVIDER_KEY_TTL_SECONDS: '900',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires TTL, budget, and audit id/);

    const scoped = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'acceptEdits',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...scopedProviderKeyEnv,
      ...pinnedArtifactEnv,
    });
    assert.equal(scoped.mode, 'edit');
    assert.deepEqual(scoped.availableModes, ['plan', 'edit']);
    assert.deepEqual(scoped.runnerProviderEnvByProvider, {});
  });

  it('allows JSONL acceptEdits through the built-in RoomTalk model gateway', () => {
    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_ALLOWED_RUN_MODES: 'plan,acceptEdits',
      CODE_AGENT_DEFAULT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'roomtalk_gateway',
      CODE_AGENT_MODEL_GATEWAY_PUBLIC_URL: 'https://room.example/api/code-agent/model-gateway',
      CODE_AGENT_MODEL_GATEWAY_SECRET: 'gateway-secret',
      CODE_AGENT_MODEL_GATEWAY_MAX_REQUESTS_PER_TURN: '8',
      CODE_AGENT_MODEL_GATEWAY_TURN_BUDGET_USD: '0.75',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });

    assert.equal(config.mode, 'edit');
    assert.deepEqual(config.availableModes, ['plan', 'edit']);
    assert.equal(config.defaultMode, 'plan');
    assert.deepEqual(config.runnerProviderEnvByProvider, {});
    assert.equal(config.modelGateway?.publicBaseUrl, 'https://room.example/api/code-agent/model-gateway');
    assert.equal(config.modelGateway?.maxRequestsPerTurn, 8);
    assert.equal(config.modelGateway?.turnBudgetUsd, 0.75);
    assert.equal('CODE_AGENT_MODEL_GATEWAY_SECRET' in config.runnerEnv, false);
    assert.equal('DEEPSEEK_API_KEY' in config.runnerEnv, false);
  });

  it('defaults the built-in RoomTalk model gateway request count to unlimited', () => {
    const config = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_ALLOWED_RUN_MODES: 'plan,acceptEdits',
      CODE_AGENT_DEFAULT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'roomtalk_gateway',
      CODE_AGENT_MODEL_GATEWAY_PUBLIC_URL: 'https://room.example/api/code-agent/model-gateway',
      CODE_AGENT_MODEL_GATEWAY_SECRET: 'gateway-secret',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });

    assert.equal(config.modelGateway?.maxRequestsPerTurn, 0);
  });

  it('does not forward provider keys in plan mode when a scoped key or proxy is configured', () => {
    const scoped = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...scopedProviderKeyEnv,
      ...pinnedArtifactEnv,
    });
    assert.deepEqual(scoped.runnerProviderEnvByProvider, {});

    const proxied = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'plan',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...modelProxyEnv,
      ...pinnedArtifactEnv,
    });
    assert.deepEqual(proxied.runnerProviderEnvByProvider, {});
    assert.deepEqual(proxied.runnerEnv, {
      PYTHONPATH: DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
      CODE_AGENT_WORKSPACE_ROOT: DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
      PLAYWRIGHT_BROWSERS_PATH: DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
      NODE_PATH: DEFAULT_NODE_PATH,
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    });
  });

  it('allows JSONL acceptEdits through an explicit model proxy configuration', () => {
    const proxy = resolveCodeAgentRuntimeConfig({
      CODE_AGENT_ENABLED: 'true',
      CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
      CODE_AGENT_RUNNER_CLIENT: 'jsonl',
      CODE_AGENT_MODE: 'acceptEdits',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent',
      ...e2bCredentialEnv,
      ...modelProxyEnv,
      ...pinnedArtifactEnv,
    });

    assert.equal(proxy.mode, 'edit');
    assert.deepEqual(proxy.availableModes, ['plan', 'edit']);
    assert.equal(proxy.runnerEnv.PYTHONPATH, DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH);
    assert.equal(proxy.runnerEnv.CODE_AGENT_WORKSPACE_ROOT, DEFAULT_CODE_AGENT_WORKSPACE_ROOT);
    assert.equal(proxy.runnerEnv.PLAYWRIGHT_BROWSERS_PATH, DEFAULT_PLAYWRIGHT_BROWSERS_PATH);
    assert.equal(proxy.runnerEnv.NODE_PATH, DEFAULT_NODE_PATH);
    assert.equal(proxy.runnerEnv.CODE_AGENT_MODEL_PROXY_URL, 'https://model-proxy.internal');
    assert.equal(proxy.runnerEnv.CODE_AGENT_MODEL_PROXY_TOKEN, 'short-lived-proxy-token');
    assert.deepEqual(proxy.runnerProviderEnvByProvider, {});
  });
});
