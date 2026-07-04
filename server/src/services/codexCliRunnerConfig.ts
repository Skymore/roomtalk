import { assertNoCodexApiKeyAuthEnv, type CodexConnectionConfig } from './codexConnectionConfig';
import type { CodeAgentRuntimeConfig } from './codeAgentRuntimeConfig';

export interface CodexCliRunnerConfig {
  enabled: boolean;
  cliBin: string;
  sandbox: 'workspace-write';
  timeoutMs: number;
  maxStderrTailChars: number;
}

const DEFAULT_CODEX_CLI_BIN = 'codex';
const DEFAULT_CODEX_CLI_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_CLI_MAX_STDERR_TAIL_CHARS = 4000;

export function resolveCodexCliRunnerConfig(env: NodeJS.ProcessEnv = process.env): CodexCliRunnerConfig {
  const enabled = env.CODEX_CLI_BACKEND_ENABLED === 'true';
  const sandbox = env.CODEX_CLI_SANDBOX?.trim() || 'workspace-write';
  const allowDangerFullAccess = env.CODEX_CLI_ALLOW_DANGER_FULL_ACCESS === 'true';

  if (sandbox === 'danger-full-access' || allowDangerFullAccess) {
    throw new Error('Codex CLI subscription backend does not allow danger-full-access');
  }
  if (sandbox !== 'workspace-write') {
    throw new Error(`Unsupported Codex CLI sandbox mode: ${sandbox}`);
  }
  if (enabled) {
    assertNoCodexApiKeyAuthEnv(env);
  }

  return {
    enabled,
    cliBin: env.CODEX_CLI_BIN?.trim() || DEFAULT_CODEX_CLI_BIN,
    sandbox: 'workspace-write',
    timeoutMs: parsePositiveIntegerEnv(
      env.CODEX_CLI_TIMEOUT_MS,
      DEFAULT_CODEX_CLI_TIMEOUT_MS,
      'CODEX_CLI_TIMEOUT_MS'
    ),
    maxStderrTailChars: parsePositiveIntegerEnv(
      env.CODEX_CLI_MAX_STDERR_TAIL_CHARS,
      DEFAULT_CODEX_CLI_MAX_STDERR_TAIL_CHARS,
      'CODEX_CLI_MAX_STDERR_TAIL_CHARS'
    ),
  };
}

export interface CodexBackendStartupGateInput {
  codeAgentRuntimeConfig: Pick<CodeAgentRuntimeConfig, 'backend'>;
  codexCliRunnerConfig: Pick<CodexCliRunnerConfig, 'enabled'>;
  codexConnectionConfig: Pick<CodexConnectionConfig, 'enabled'>;
  hasCodexConnectionService: boolean;
}

export function assertCodexBackendStartupGate(input: CodexBackendStartupGateInput): void {
  if (input.codeAgentRuntimeConfig.backend !== 'codex') {
    return;
  }
  if (!input.codexCliRunnerConfig.enabled) {
    throw new Error('CODE_AGENT_BACKEND=codex requires CODEX_CLI_BACKEND_ENABLED=true');
  }
  if (!input.codexConnectionConfig.enabled || !input.hasCodexConnectionService) {
    throw new Error('CODE_AGENT_BACKEND=codex requires CODEX_CONNECTIONS_ENABLED=true and a configured Codex connection service');
  }
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
