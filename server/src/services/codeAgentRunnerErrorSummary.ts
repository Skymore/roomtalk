import { CodeAgentRunnerErrorEvent } from './codeAgentRunnerProtocol';
import type { CodeAgentBackend } from '../types';
import { isCodexCodeAgentBackend } from './codeAgentBackends';

export type CodeAgentRunnerObservableErrorCode =
  | 'codex_auth_required'
  | 'runner_daemon_failure'
  | 'runner_protocol_failure'
  | 'runner_harness_failure'
  | 'runner_timeout'
  | 'runner_interrupted'
  | 'runner_process_failure'
  | 'runner_sandbox_failure'
  | 'runner_configuration_failure'
  | 'runner_failure';

export interface CodeAgentRunnerErrorSummary {
  code: CodeAgentRunnerObservableErrorCode;
  message: string;
  detailLength: number;
  retryable: boolean;
}

const SUMMARY_MESSAGES: Record<CodeAgentRunnerObservableErrorCode, string> = {
  codex_auth_required: 'Codex sign-in expired.',
  runner_daemon_failure: 'Code agent runner daemon failed.',
  runner_protocol_failure: 'Code agent runner protocol failed.',
  runner_harness_failure: 'Code agent harness failed.',
  runner_timeout: 'Code agent runner timed out.',
  runner_interrupted: 'Code agent runner was interrupted.',
  runner_process_failure: 'Code agent runner process failed.',
  runner_sandbox_failure: 'Code agent runner sandbox failed.',
  runner_configuration_failure: 'Code agent runner configuration failed.',
  runner_failure: 'Code agent runner failed.',
};

const classifyRunnerErrorCode = (value: unknown, message: unknown): CodeAgentRunnerObservableErrorCode => {
  const detail = typeof message === 'string' ? message : '';
  if (typeof value !== 'string') {
    return /access token could not be refreshed|refresh token was already used|log out and sign in again/i.test(detail)
      ? 'codex_auth_required'
      : 'runner_failure';
  }
  const code = value.trim().toLowerCase();
  if (
    /(?:^|_)(?:unauthorized|invalid_grant|auth_(?:expired|invalid|required))(?:_|$)/.test(code)
    || /access token could not be refreshed|refresh token was already used|log out and sign in again/i.test(detail)
  ) {
    return 'codex_auth_required';
  }
  if (/^(?:daemon_|sandbox_daemon)/.test(code)) {
    return 'runner_daemon_failure';
  }
  if (/^(?:protocol_|invalid_(?:json|request|tool_event|model_step)|unsupported_(?:schema|type|daemon_request))/.test(code)) {
    return 'runner_protocol_failure';
  }
  if (/^(?:acp_|harness_)/.test(code)) {
    return 'runner_harness_failure';
  }
  if (/(?:timeout|timed_out|deadline)/.test(code)) {
    return 'runner_timeout';
  }
  if (/(?:interrupt|abort|cancel)/.test(code)) {
    return 'runner_interrupted';
  }
  if (/(?:sandbox|e2b)/.test(code)) {
    return 'runner_sandbox_failure';
  }
  if (/(?:config|credential|auth|token|model_proxy|unsupported_(?:backend|provider))/.test(code)) {
    return 'runner_configuration_failure';
  }
  if (/(?:stdin|process|exit|closed|busy|runner_)/.test(code)) {
    return 'runner_process_failure';
  }
  return 'runner_failure';
};

export const summarizeCodeAgentRunnerError = (
  event: Pick<CodeAgentRunnerErrorEvent, 'code' | 'message' | 'retryable'>,
  context: { backend?: CodeAgentBackend } = {},
): CodeAgentRunnerErrorSummary => {
  const classifiedCode = classifyRunnerErrorCode(event.code, event.message);
  const code = classifiedCode === 'codex_auth_required'
    && context.backend !== undefined
    && !isCodexCodeAgentBackend(context.backend)
    ? 'runner_failure'
    : classifiedCode;
  return {
    code,
    message: SUMMARY_MESSAGES[code],
    detailLength: typeof event.message === 'string' ? event.message.length : 0,
    retryable: event.retryable === true,
  };
};
