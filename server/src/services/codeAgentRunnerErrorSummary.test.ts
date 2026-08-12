import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeCodeAgentRunnerError } from './codeAgentRunnerErrorSummary';

describe('code agent runner error summary', () => {
  it('classifies expired Codex subscription auth without retaining provider details', () => {
    const detail = 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    const summary = summarizeCodeAgentRunnerError({
      code: 'codex_sdk_app_server_error',
      message: detail,
      retryable: false,
    });

    assert.deepEqual(summary, {
      code: 'codex_auth_required',
      message: 'Codex sign-in expired.',
      detailLength: detail.length,
      retryable: false,
    });
    assert.equal(JSON.stringify(summary).includes('refresh token'), false);
  });

  it('treats generic unauthorized errors as Codex auth only for Codex backends', () => {
    const event = {
      code: 'unauthorized',
      message: 'upstream unauthorized',
      retryable: false,
    };

    assert.equal(summarizeCodeAgentRunnerError(event, { backend: 'codex-app-server' }).code, 'codex_auth_required');
    assert.deepEqual(summarizeCodeAgentRunnerError(event, { backend: 'code-agent' }), {
      code: 'runner_failure',
      message: 'Code agent runner failed.',
      detailLength: event.message.length,
      retryable: false,
    });
  });

  it('classifies daemon and one-shot JSONL failures without retaining their details', () => {
    const secret = 'ROOMTALK_PRIVATE_TOKEN=must-not-leak';
    const daemon = summarizeCodeAgentRunnerError({
      code: 'daemon_process_error',
      message: `sandbox daemon failed; stderr: ${secret}`,
      retryable: false,
    });
    const jsonl = summarizeCodeAgentRunnerError({
      code: 'runner_process_error',
      message: `runner failed; command=${secret}`,
      retryable: false,
    });

    assert.equal(daemon.code, 'runner_daemon_failure');
    assert.equal(jsonl.code, 'runner_process_failure');
    assert.equal(daemon.detailLength > 0, true);
    assert.equal(jsonl.detailLength > 0, true);
    assert.equal(JSON.stringify({ daemon, jsonl }).includes(secret), false);
  });

  it('uses a fixed bounded fallback for arbitrary codes and very large messages', () => {
    const secret = 'Bearer secret-value-that-must-not-leak';
    const summary = summarizeCodeAgentRunnerError({
      code: `arbitrary_${secret}`,
      message: `${secret}${'x'.repeat(100_000)}`,
      retryable: true,
    });

    assert.deepEqual(summary, {
      code: 'runner_failure',
      message: 'Code agent runner failed.',
      detailLength: secret.length + 100_000,
      retryable: true,
    });
    assert.equal(summary.message.length < 100, true);
    assert.equal(JSON.stringify(summary).includes(secret), false);
  });
});
