export interface CodexConnectionConfig {
  enabled: boolean;
  authEncryptionKey?: string;
  cliBin: string;
  authScriptBin?: string;
  authLoginTimeoutMs: number;
}

const DEFAULT_CODEX_CLI_BIN = 'codex';
const DEFAULT_CODEX_AUTH_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const FORBIDDEN_CODEX_AUTH_ENV_KEYS = ['CODEX_API_KEY'];
const STRIPPED_CHILD_ENV_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'];
const SECRET_ENV_SUFFIXES = ['_TOKEN', '_SECRET', '_KEY'];

export function resolveCodexConnectionConfig(env: NodeJS.ProcessEnv = process.env): CodexConnectionConfig {
  const enabled = env.CODEX_CONNECTIONS_ENABLED === 'true';
  const authEncryptionKey = env.CODEX_AUTH_ENCRYPTION_KEY?.trim() || undefined;
  if (enabled && !authEncryptionKey) {
    throw new Error('CODEX_AUTH_ENCRYPTION_KEY is required when CODEX_CONNECTIONS_ENABLED=true');
  }

  return {
    enabled,
    authEncryptionKey,
    cliBin: env.CODEX_CLI_BIN?.trim() || DEFAULT_CODEX_CLI_BIN,
    authScriptBin: env.CODEX_DEVICE_AUTH_SCRIPT_BIN?.trim() || undefined,
    authLoginTimeoutMs: parsePositiveIntegerEnv(
      env.CODEX_AUTH_LOGIN_TIMEOUT_MS,
      DEFAULT_CODEX_AUTH_LOGIN_TIMEOUT_MS,
      'CODEX_AUTH_LOGIN_TIMEOUT_MS'
    ),
  };
}

export function assertNoCodexApiKeyAuthEnv(env: NodeJS.ProcessEnv): void {
  const present = FORBIDDEN_CODEX_AUTH_ENV_KEYS.filter(key => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(`Codex subscription auth does not allow API key environment variables: ${present.join(', ')}`);
  }
}

export function sanitizeCodexChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.CODEX_HOME;
  for (const key of Object.keys(next)) {
    if (STRIPPED_CHILD_ENV_KEYS.includes(key) || SECRET_ENV_SUFFIXES.some(suffix => key.endsWith(suffix))) {
      delete next[key];
    }
  }
  return next;
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
