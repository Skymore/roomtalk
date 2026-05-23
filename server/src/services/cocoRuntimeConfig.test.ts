import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COCO_RUNNER_COMMAND, resolveCocoRuntimeConfig } from './cocoRuntimeConfig';

describe('resolveCocoRuntimeConfig', () => {
  it('defaults to disabled fake sandbox and fake runner', () => {
    const config = resolveCocoRuntimeConfig({});

    assert.equal(config.enabled, false);
    assert.equal(config.sandboxProvider, 'fake');
    assert.equal(config.runnerClient, 'fake');
    assert.equal(config.mode, 'acceptEdits');
    assert.equal(config.runnerCommand, DEFAULT_COCO_RUNNER_COMMAND);
    assert.deepEqual(config.allowedPaths, ['.']);
    assert.deepEqual(config.runnerEnv, {});
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
    }), /requires COCO_E2B_TEMPLATE_ID/);
  });

  it('allows JSONL plan mode with E2B and only selected allowlisted env groups', () => {
    const config = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_SOURCE_DIR: '/workspace/coco/src',
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
      ANTHROPIC_API_KEY: 'anthropic-key',
      UNRELATED_SECRET: 'must-not-leak',
    });

    assert.deepEqual(config.runnerEnv, { COCO_SOURCE_DIR: '/workspace/coco/src' });
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
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
    }), /requires model proxy or scoped provider key/);

    assert.throws(() => resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      ROOMTALK_COCO_ALLOW_SHELL: 'true',
    }), /requires model proxy or scoped provider key/);

    const scoped = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_SCOPED_PROVIDER_KEY: 'true',
      DEEPSEEK_API_KEY: 'must-not-forward',
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
      COCO_SCOPED_PROVIDER_KEY: 'true',
      DEEPSEEK_API_KEY: 'must-not-forward',
    });
    assert.deepEqual(scoped.runnerProviderEnvByProvider, {});

    const proxied = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_MODE: 'plan',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      DEEPSEEK_API_KEY: 'must-not-forward',
    });
    assert.deepEqual(proxied.runnerProviderEnvByProvider, {});
  });

  it('allows JSONL acceptEdits through an explicit model proxy configuration', () => {
    const proxy = resolveCocoRuntimeConfig({
      COCO_ENABLED: 'true',
      COCO_SANDBOX_PROVIDER: 'e2b',
      COCO_RUNNER_CLIENT: 'jsonl',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco',
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
    });

    assert.equal(proxy.mode, 'acceptEdits');
    assert.equal(proxy.runnerEnv.COCO_MODEL_PROXY_URL, 'https://model-proxy.internal');
    assert.deepEqual(proxy.runnerProviderEnvByProvider, {});
  });
});
