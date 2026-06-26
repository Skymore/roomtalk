import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_COCO_RUNNER_COMMAND,
  DEFAULT_COCO_RUNNER_PYTHONPATH,
  DEFAULT_COCO_WORKSPACE_ROOT,
  resolveCocoRuntimeConfig,
} from './cocoRuntimeConfig';

const pinnedArtifactEnv = {
  COCO_ARTIFACT_VERSION: 'roomtalk-coco-2026-05-22-4f4ecc9',
  COCO_SOURCE_REF: '4f4ecc99589c68cffcb150b6a2df9f55144cc2d1',
};

const e2bCredentialEnv = {
  E2B_API_KEY: 'e2b-test-key',
};

const scopedProviderKeyEnv = {
  COCO_SCOPED_PROVIDER_KEY: 'true',
  COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS: '900',
  COCO_SCOPED_PROVIDER_KEY_BUDGET_USD: '0.25',
  COCO_SCOPED_PROVIDER_KEY_AUDIT_ID: 'turn-audit-1',
};

const modelProxyEnv = {
  COCO_MODEL_ACCESS_STRATEGY: 'proxy',
  COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
  COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
};

describe('resolveCocoRuntimeConfig', () => {
  it('defaults to disabled fake sandbox and fake runner', () => {
    const config = resolveCocoRuntimeConfig({});

    assert.equal(config.enabled, false);
    assert.equal(config.backend, 'coco');
    assert.equal(config.sandboxProvider, 'fake');
    assert.equal(config.runnerClient, 'fake');
    assert.equal(config.artifactMode, 'production');
    assert.equal(config.mode, 'plan');
    assert.equal(config.runnerCommand, DEFAULT_COCO_RUNNER_COMMAND);
    assert.deepEqual(config.allowedPaths, ['.']);
    assert.deepEqual(config.runnerEnv, {});
  });

  it('accepts only implemented code-agent backends', () => {
    assert.equal(resolveCocoRuntimeConfig({ CODE_AGENT_BACKEND: 'coco' }).backend, 'coco');
    assert.throws(() => resolveCocoRuntimeConfig({ CODE_AGENT_BACKEND: 'codex' }), /CODE_AGENT_BACKEND=codex is not implemented/);
    assert.throws(() => resolveCocoRuntimeConfig({ CODE_AGENT_BACKEND: 'unknown' }), /Unsupported CODE_AGENT_BACKEND: unknown/);
  });

  it('falls back to plan mode and warns when COCO_MODE is invalid', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const config = resolveCocoRuntimeConfig({ COCO_MODE: 'accept_edits' });

      assert.equal(config.mode, 'plan');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Unsupported COCO_MODE: accept_edits/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('rejects jsonl runner with fake sandbox when Coco is enabled', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
    }), /requires a non-fake sandbox provider/);
  });

  it('rejects E2B fake-runner pairing outside explicit test mode', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'fake',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
    }), /requires COCO_RUNNER_CLIENT=jsonl/);

    const testConfig = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'fake',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      E2E_TEST_MODE: 'true',
    });
    assert.equal(testConfig.sandboxProvider, 'e2b');
    assert.equal(testConfig.runnerClient, 'fake');
  });

  it('rejects E2B without a template id', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      ...pinnedArtifactEnv,
    }), /requires COCO_E2B_TEMPLATE_ID/);
  });

  it('requires pinned production artifact metadata for E2B JSONL mode', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ...e2bCredentialEnv,
    }), /requires COCO_ARTIFACT_VERSION and COCO_SOURCE_REF/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_SOURCE_DIR: '/Users/sky/projects/coco/src',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /must use the pinned sandbox artifact/);
  });

  it('requires E2B credentials for enabled E2B JSONL mode', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ...pinnedArtifactEnv,
    }), /requires E2B_API_KEY or E2B_ACCESS_TOKEN/);
  });

  it('allows local Coco source mounts only in development artifact mode', () => {
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_ARTIFACT_MODE: 'development',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco-dev',
      ...e2bCredentialEnv,
    }), /requires COCO_SOURCE_DIR/);

    const config = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_ARTIFACT_MODE: 'development',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco-dev',
      COCO_SOURCE_DIR: '/Users/sky/projects/coco/src',
      ...e2bCredentialEnv,
    });

    assert.equal(config.artifactMode, 'development');
    assert.equal(config.runnerEnv.PYTHONPATH, DEFAULT_COCO_RUNNER_PYTHONPATH);
    assert.equal(config.runnerEnv.COCO_SOURCE_DIR, '/Users/sky/projects/coco/src');
    assert.equal(config.artifactVersion, undefined);
    assert.equal(config.cocoSourceRef, undefined);
  });

  it('allows JSONL plan mode with E2B and only selected allowlisted env groups', () => {
    const config = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      ANTHROPIC_API_KEY: 'anthropic-key',
      UNRELATED_SECRET: 'must-not-leak',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    });

    assert.deepEqual(config.runnerEnv, {
      PYTHONPATH: DEFAULT_COCO_RUNNER_PYTHONPATH,
      COCO_WORKSPACE_ROOT: DEFAULT_COCO_WORKSPACE_ROOT,
    });
    assert.equal(config.artifactVersion, pinnedArtifactEnv.COCO_ARTIFACT_VERSION);
    assert.equal(config.cocoSourceRef, pinnedArtifactEnv.COCO_SOURCE_REF);
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
    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'acceptEdits',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires model proxy with token or scoped provider key contract/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ROOMTALK_COCO_ALLOW_SHELL: 'true',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires model proxy with token or scoped provider key contract/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS COCO_MODEL_PROXY_URL and COCO_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'http://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS COCO_MODEL_PROXY_URL and COCO_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /require COCO_MODEL_ACCESS_STRATEGY=proxy/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    }), /require COCO_MODEL_ACCESS_STRATEGY=proxy/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'http://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    }), /requires HTTPS COCO_MODEL_PROXY_URL and COCO_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: '   ',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires HTTPS COCO_MODEL_PROXY_URL and COCO_MODEL_PROXY_TOKEN/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_SCOPED_PROVIDER_KEY: 'true',
      COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS: '900',
      ...e2bCredentialEnv,
      ...pinnedArtifactEnv,
    }), /requires TTL, budget, and audit id/);

    const scoped = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'acceptEdits',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...scopedProviderKeyEnv,
      ...pinnedArtifactEnv,
    });
    assert.equal(scoped.mode, 'acceptEdits');
    assert.deepEqual(scoped.runnerProviderEnvByProvider, {});
  });

  it('does not forward provider keys in plan mode when a scoped key or proxy is configured', () => {
    const scoped = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...scopedProviderKeyEnv,
      ...pinnedArtifactEnv,
    });
    assert.deepEqual(scoped.runnerProviderEnvByProvider, {});

    const proxied = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      DEEPSEEK_API_KEY: 'must-not-forward',
      ...e2bCredentialEnv,
      ...modelProxyEnv,
      ...pinnedArtifactEnv,
    });
    assert.deepEqual(proxied.runnerProviderEnvByProvider, {});
    assert.deepEqual(proxied.runnerEnv, {
      PYTHONPATH: DEFAULT_COCO_RUNNER_PYTHONPATH,
      COCO_WORKSPACE_ROOT: DEFAULT_COCO_WORKSPACE_ROOT,
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'short-lived-proxy-token',
    });
  });

  it('allows JSONL acceptEdits through an explicit model proxy configuration', () => {
    const proxy = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'acceptEdits',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ...e2bCredentialEnv,
      ...modelProxyEnv,
      ...pinnedArtifactEnv,
    });

    assert.equal(proxy.mode, 'acceptEdits');
    assert.equal(proxy.runnerEnv.PYTHONPATH, DEFAULT_COCO_RUNNER_PYTHONPATH);
    assert.equal(proxy.runnerEnv.COCO_WORKSPACE_ROOT, DEFAULT_COCO_WORKSPACE_ROOT);
    assert.equal(proxy.runnerEnv.COCO_MODEL_PROXY_URL, 'https://model-proxy.internal');
    assert.equal(proxy.runnerEnv.COCO_MODEL_PROXY_TOKEN, 'short-lived-proxy-token');
    assert.deepEqual(proxy.runnerProviderEnvByProvider, {});
  });
});
