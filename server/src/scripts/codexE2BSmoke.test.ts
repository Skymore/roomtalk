import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { buildCodexE2BSmokePlan } from './codexE2BSmoke';
import {
  DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND,
  DEFAULT_CODEX_CLI_RUNNER_COMMAND,
} from '../services/codeAgentRuntimeConfig';

const baseEnv = {
  RUN_CODEX_E2B_SMOKE: 'true',
  E2B_API_KEY: 'e2b-test-key',
  CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dual-cli',
  CODE_AGENT_ARTIFACT_MODE: 'production',
  CODE_AGENT_ARTIFACT_VERSION: 'roomtalk-code-agent-2026-07-04-dual-cli-candidate',
  CODE_AGENT_SOURCE_REF: '0d783dd662c823d6a671c6bba596a3ec5ef00491',
  CODEX_E2B_SMOKE_AUTH_JSON_PATH: '/tmp/codex-auth.json',
  CODEX_CLI_BIN: '/usr/local/bin/codex',
  CODEX_E2B_SMOKE_TURN_ID: 'turn/test:codex',
};

const assertSkipped = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
  const plan = buildCodexE2BSmokePlan(env);
  if (plan.run) {
    assert.fail('Expected Codex E2B smoke plan to skip');
  }
  assert.match(plan.reason, pattern);
};

const assertRunnable = (env: NodeJS.ProcessEnv) => {
  const plan = buildCodexE2BSmokePlan(env);
  if (!plan.run) {
    assert.fail(`Expected Codex E2B smoke plan to run, skipped: ${plan.reason}`);
  }
  return plan;
};

describe('buildCodexE2BSmokePlan', () => {
  it('skips unless explicitly enabled', () => {
    assertSkipped({}, /RUN_CODEX_E2B_SMOKE/);
  });

  it('skips without E2B template, credentials, or Codex auth JSON', () => {
    assertSkipped({ RUN_CODEX_E2B_SMOKE: 'true' }, /CODE_AGENT_E2B_TEMPLATE_ID/);
    assertSkipped({
      RUN_CODEX_E2B_SMOKE: 'true',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dual-cli',
    }, /E2B_API_KEY/);
    assertSkipped({
      RUN_CODEX_E2B_SMOKE: 'true',
      CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dual-cli',
      E2B_API_KEY: 'e2b-test-key',
      HOME: '',
    }, /CODEX_E2B_SMOKE_AUTH_JSON_PATH/);
  });

  it('builds a Codex app-server smoke plan without forwarding E2B credentials to the runner', () => {
    const imageUrl = 'https://media.example/signed/input.png?token=secret';
    const plan = assertRunnable({
      ...baseEnv,
      CODEX_E2B_SMOKE_IMAGE_URL: imageUrl,
    });

    assert.equal(plan.config.backend, 'codex-app-server');
    assert.equal(plan.config.runnerCommand, DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND);
    assert.equal(plan.config.sandboxProvider, 'e2b');
    assert.equal(plan.config.runnerClient, 'jsonl');
    assert.equal(plan.authJsonPath, '/tmp/codex-auth.json');
    assert.equal(plan.authSecretPath, '/tmp/roomtalk-codex/turn_test_codex-auth.json');
    assert.equal(plan.refreshedAuthSecretPath, '/tmp/roomtalk-codex/turn_test_codex-refreshed-auth.json');
    assert.equal(plan.runnerEnv.CODEX_CLI_BIN, '/usr/local/bin/codex');
    assert.equal(plan.runnerEnv.E2B_API_KEY, undefined);
    assert.equal(plan.runnerEnv.E2B_ACCESS_TOKEN, undefined);
    assert.equal(plan.e2bConnection.apiKey, 'e2b-test-key');
    assert.equal(plan.imageUrl, imageUrl);
  });

  it('can explicitly smoke the legacy Codex CLI backend', () => {
    const plan = assertRunnable({
      ...baseEnv,
      CODEX_E2B_SMOKE_BACKEND: 'codex',
    });

    assert.equal(plan.config.backend, 'codex');
    assert.equal(plan.config.runnerCommand, DEFAULT_CODEX_CLI_RUNNER_COMMAND);
  });

  it('rejects unsupported Codex smoke backends', () => {
    assert.throws(() => buildCodexE2BSmokePlan({
      ...baseEnv,
      CODEX_E2B_SMOKE_BACKEND: 'other',
    }), /Unsupported CODEX_E2B_SMOKE_BACKEND/);
  });

  it('rejects invalid image URLs and image smoke on the deprecated CLI backend', () => {
    assert.throws(() => buildCodexE2BSmokePlan({
      ...baseEnv,
      CODEX_E2B_SMOKE_IMAGE_URL: 'http://media.example/input.png',
    }), /absolute HTTPS URL/);
    assert.throws(() => buildCodexE2BSmokePlan({
      ...baseEnv,
      CODEX_E2B_SMOKE_BACKEND: 'codex',
      CODEX_E2B_SMOKE_IMAGE_URL: 'https://media.example/input.png',
    }), /requires the codex-app-server backend/);
  });

  it('fails fast when production E2B artifact metadata is missing', () => {
    assert.throws(() => buildCodexE2BSmokePlan({
      ...baseEnv,
      CODE_AGENT_ARTIFACT_VERSION: undefined,
      CODE_AGENT_SOURCE_REF: undefined,
    }), /Production code agent E2B JSONL mode requires/);
  });
});
