import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { buildCocoE2BSmokePlan } from './cocoE2BSmoke';

const baseEnv = {
  RUN_COCO_E2B_SMOKE: 'true',
  E2B_API_KEY: 'e2b-test-key',
  COCO_E2B_TEMPLATE_ID: 'roomtalk-coco-dev',
  COCO_ARTIFACT_MODE: 'development',
  // Development artifact mode requires a source path, but this unit test only
  // validates configuration shaping and never reads the local filesystem.
  COCO_SOURCE_DIR: '/Users/sky/projects/coco/src',
  COCO_MODE: 'plan',
  DEEPSEEK_API_KEY: 'deepseek-test-key',
};

const assertSkipped = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
  const plan = buildCocoE2BSmokePlan(env);
  if (plan.run) {
    assert.fail('Expected Coco E2B smoke plan to skip');
  }
  assert.match(plan.reason, pattern);
};

const assertRunnable = (env: NodeJS.ProcessEnv) => {
  const plan = buildCocoE2BSmokePlan(env);
  if (!plan.run) {
    assert.fail(`Expected Coco E2B smoke plan to run, skipped: ${plan.reason}`);
  }
  return plan;
};

describe('buildCocoE2BSmokePlan', () => {
  it('skips unless explicitly enabled', () => {
    assertSkipped({}, /RUN_COCO_E2B_SMOKE/);
  });

  it('skips without E2B template or credentials', () => {
    assertSkipped({ RUN_COCO_E2B_SMOKE: 'true' }, /COCO_E2B_TEMPLATE_ID/);
    assertSkipped({
      RUN_COCO_E2B_SMOKE: 'true',
      COCO_E2B_TEMPLATE_ID: 'roomtalk-coco-dev',
    }, /E2B_API_KEY/);
  });

  it('fails fast on invalid enabled E2B runtime config', () => {
    assert.throws(() => buildCocoE2BSmokePlan({
      ...baseEnv,
      COCO_ARTIFACT_MODE: 'production',
      COCO_SOURCE_DIR: undefined,
      COCO_ARTIFACT_VERSION: undefined,
      COCO_SOURCE_REF: undefined,
    }), /Production Coco E2B JSONL mode requires/);
  });

  it('builds a direct-provider smoke plan without forwarding E2B credentials to the runner', () => {
    const plan = assertRunnable(baseEnv);

    assert.equal(plan.selectedModel.provider, 'deepseek');
    assert.equal(plan.runnerEnv.PYTHONPATH, '/opt/coco/src:/opt/roomtalk_coco_runner');
    assert.equal(plan.runnerEnv.DEEPSEEK_API_KEY, 'deepseek-test-key');
    assert.equal(plan.runnerEnv.E2B_API_KEY, undefined);
    assert.equal(plan.runnerEnv.E2B_ACCESS_TOKEN, undefined);
    assert.equal(plan.e2bConnection.apiKey, 'e2b-test-key');
    assert.equal(plan.config.sandboxProvider, 'e2b');
    assert.equal(plan.config.runnerClient, 'jsonl');
  });

  it('allows proxy-based smoke plans without direct provider keys', () => {
    const plan = assertRunnable({
      ...baseEnv,
      DEEPSEEK_API_KEY: undefined,
      COCO_MODEL_ACCESS_STRATEGY: 'proxy',
      COCO_MODEL_PROXY_URL: 'https://model-proxy.internal',
      COCO_MODEL_PROXY_TOKEN: 'proxy-token',
    });

    assert.equal(plan.runnerEnv.COCO_MODEL_PROXY_URL, 'https://model-proxy.internal');
    assert.equal(plan.runnerEnv.COCO_MODEL_PROXY_TOKEN, 'proxy-token');
    assert.equal(plan.runnerEnv.PYTHONPATH, '/opt/coco/src:/opt/roomtalk_coco_runner');
    assert.equal(plan.runnerEnv.DEEPSEEK_API_KEY, undefined);
  });

  it('skips when model access is not configured', () => {
    assertSkipped({
      ...baseEnv,
      DEEPSEEK_API_KEY: undefined,
    }, /No model access/);
  });
});
