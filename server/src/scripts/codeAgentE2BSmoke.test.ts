import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { buildCodeAgentE2BSmokePlan } from './codeAgentE2BSmoke';

const baseEnv = {
  RUN_CODE_AGENT_E2B_SMOKE: 'true',
  E2B_API_KEY: 'e2b-test-key',
  CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dev',
  CODE_AGENT_ARTIFACT_MODE: 'development',
  // Development artifact mode requires a source path, but this unit test only
  // validates configuration shaping and never reads the local filesystem.
  CODE_AGENT_SOURCE_DIR: '/Users/sky/projects/code-agent-engine/src',
  CODE_AGENT_MODE: 'plan',
  DEEPSEEK_API_KEY: 'deepseek-test-key',
};

const assertSkipped = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
  const plan = buildCodeAgentE2BSmokePlan(env);
  if (plan.run) {
    assert.fail('Expected code-agent E2B smoke plan to skip');
  }
  assert.match(plan.reason, pattern);
};

const assertRunnable = (env: NodeJS.ProcessEnv) => {
  const plan = buildCodeAgentE2BSmokePlan(env);
  if (!plan.run) {
    assert.fail(`Expected code-agent E2B smoke plan to run, skipped: ${plan.reason}`);
  }
  return plan;
};

describe('buildCodeAgentE2BSmokePlan', () => {
  it('skips unless explicitly enabled', () => {
    assertSkipped({}, /RUN_CODE_AGENT_E2B_SMOKE/);
  });

  it('skips without E2B template or credentials', () => {
    assertSkipped({ RUN_CODE_AGENT_E2B_SMOKE: 'true' }, /CODE_AGENT_E2B_TEMPLATE_ID/);
    assertSkipped({
      RUN_CODE_AGENT_E2B_SMOKE: 'true',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dev',
    }, /E2B_API_KEY/);
  });

  it('fails fast on invalid enabled E2B runtime config', () => {
    assert.throws(() => buildCodeAgentE2BSmokePlan({
      ...baseEnv,
      CODE_AGENT_ARTIFACT_MODE: 'production',
      CODE_AGENT_SOURCE_DIR: undefined,
      CODE_AGENT_ARTIFACT_VERSION: undefined,
      CODE_AGENT_SOURCE_REF: undefined,
    }), /Production code agent E2B JSONL mode requires/);
  });

  it('builds a direct-provider smoke plan without forwarding E2B credentials to the runner', () => {
    const plan = assertRunnable(baseEnv);

    assert.equal(plan.selectedModel.provider, 'deepseek');
    assert.equal(plan.runnerEnv.PYTHONPATH, '/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner');
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
      CODE_AGENT_MODEL_ACCESS_STRATEGY: 'proxy',
      CODE_AGENT_MODEL_PROXY_URL: 'https://model-proxy.internal',
      CODE_AGENT_MODEL_PROXY_TOKEN: 'proxy-token',
    });

    assert.equal(plan.runnerEnv.CODE_AGENT_MODEL_PROXY_URL, 'https://model-proxy.internal');
    assert.equal(plan.runnerEnv.CODE_AGENT_MODEL_PROXY_TOKEN, 'proxy-token');
    assert.equal(plan.runnerEnv.PYTHONPATH, '/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner');
    assert.equal(plan.runnerEnv.DEEPSEEK_API_KEY, undefined);
  });

  it('skips when model access is not configured', () => {
    assertSkipped({
      ...baseEnv,
      DEEPSEEK_API_KEY: undefined,
    }, /No model access/);
  });
});
