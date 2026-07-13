import { AIModelProvider } from '../types';
import { CodeAgentBackend } from './codeAgentRunner';
import {
  codeAgentModeAllowsWriteTools,
  highestCodeAgentMode,
  normalizeCodeAgentMode,
  normalizeCodeAgentModeSet,
} from './codeAgentModes';
import { CodeAgentSandboxProvider } from './codeAgentSandboxService';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';

export type CodeAgentRunnerClientKind = 'fake' | 'jsonl' | 'daemon';
export type CodeAgentArtifactMode = 'production' | 'development';
export type CodeAgentE2BOnTimeout = 'kill' | 'pause';

export interface CodeAgentRuntimeConfig {
  enabled: boolean;
  backend: CodeAgentBackend;
  sandboxProvider: CodeAgentSandboxProvider;
  runnerClient: CodeAgentRunnerClientKind;
  artifactMode: CodeAgentArtifactMode;
  artifactVersion?: string;
  codeAgentSourceRef?: string;
  allowedClientIds: string[];
  mode: CodeAgentRunnerMode;
  availableModes: CodeAgentRunnerMode[];
  defaultMode: CodeAgentRunnerMode;
  modelGateway?: {
    publicBaseUrl: string;
    tokenSecret: string;
    tokenTtlSeconds: number;
    maxRequestsPerTurn: number;
    turnBudgetUsd: number;
  };
  runnerCommand: string;
  runnerCommandByBackend: Partial<Record<CodeAgentBackend, string>>;
  daemonCommand: string;
  allowedPaths: string[];
  runnerEnv: Record<string, string>;
  runnerProviderEnvByProvider: Partial<Record<AIModelProvider, Record<string, string>>>;
  e2bTemplateId?: string;
  e2bWorkspace?: string;
  e2bLifecycle: {
    onTimeout: CodeAgentE2BOnTimeout;
    autoResume: boolean;
    keepMemory: boolean;
  };
}

export const DEFAULT_CODE_AGENT_RUNNER_COMMAND = 'python -m roomtalk_code_agent_runner';
export const DEFAULT_CODEX_CLI_RUNNER_COMMAND = 'python -m roomtalk_code_agent_runner.codex_cli';
export const DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND = 'python -m roomtalk_code_agent_runner.codex_app_server';
export const DEFAULT_CODE_AGENT_DAEMON_COMMAND = [
  "bash -lc '",
  'pkill -TERM -f "^python -m roomtalk_code_agent_runner[.]daemon$|[c]odex app-server --listen stdio://|[c]odex-code-mode-host" 2>/dev/null || true;',
  'sleep 0.2;',
  'pkill -KILL -f "^python -m roomtalk_code_agent_runner[.]daemon$|[c]odex app-server --listen stdio://|[c]odex-code-mode-host" 2>/dev/null || true;',
  'exec python -m roomtalk_code_agent_runner.daemon',
  "'",
].join(' ');
export const DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH = '/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner';
export const DEFAULT_CODE_AGENT_WORKSPACE_ROOT = '/workspace';
export const DEFAULT_PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
export const DEFAULT_NODE_PATH = '/usr/lib/node_modules';
export const DEFAULT_CODE_AGENT_E2B_PAUSE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CODE_AGENT_E2B_KILL_TIMEOUT_MS = 60 * 60 * 1000;

const parseCsvEnv = (value?: string) =>
  value?.split(',').map(item => item.trim()).filter(Boolean) || [];

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Expected boolean env value, got: ${value}`);
};

const pickEnv = (env: NodeJS.ProcessEnv, names: string[]) => Object.fromEntries(
  names
    .map(name => [name, env[name]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
);

const readSandboxProvider = (env: NodeJS.ProcessEnv): CodeAgentSandboxProvider => {
  const value = (env.CODE_AGENT_SANDBOX_PROVIDER || 'fake').toLowerCase();
  if (value === 'fake' || value === 'e2b') {
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_SANDBOX_PROVIDER: ${value}`);
};

const readCodeAgentBackend = (env: NodeJS.ProcessEnv): CodeAgentBackend => {
  const defaultBackend = env.CODEX_CLI_BACKEND_ENABLED === 'true' ? 'codex-app-server' : 'code-agent';
  const value = (env.CODE_AGENT_BACKEND || defaultBackend).toLowerCase();
  if (value === 'code-agent') {
    return value;
  }
  if (value === 'codex' || value === 'codex-app-server') {
    if (env.CODEX_CLI_BACKEND_ENABLED !== 'true') {
      throw new Error(`CODE_AGENT_BACKEND=${value} requires CODEX_CLI_BACKEND_ENABLED=true`);
    }
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_BACKEND: ${value}`);
};

const readRunnerClient = (env: NodeJS.ProcessEnv): CodeAgentRunnerClientKind => {
  const value = (env.CODE_AGENT_RUNNER_CLIENT || 'fake').toLowerCase();
  if (value === 'fake' || value === 'jsonl' || value === 'daemon') {
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_RUNNER_CLIENT: ${value}`);
};

const defaultRunnerCommandForBackend = (backend: CodeAgentBackend) => {
  if (backend === 'codex') {
    return DEFAULT_CODEX_CLI_RUNNER_COMMAND;
  }
  if (backend === 'codex-app-server') {
    return DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND;
  }
  return DEFAULT_CODE_AGENT_RUNNER_COMMAND;
};

const readArtifactMode = (env: NodeJS.ProcessEnv): CodeAgentArtifactMode => {
  const value = (env.CODE_AGENT_ARTIFACT_MODE || 'production').toLowerCase();
  if (value === 'production' || value === 'development') {
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_ARTIFACT_MODE: ${value}`);
};

const readE2BOnTimeout = (env: NodeJS.ProcessEnv): CodeAgentE2BOnTimeout => {
  const value = (env.CODE_AGENT_E2B_ON_TIMEOUT || 'pause').trim();
  if (value === 'pause' || value === 'kill') {
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_E2B_ON_TIMEOUT: ${value}`);
};

const readE2BLifecycle = (env: NodeJS.ProcessEnv): CodeAgentRuntimeConfig['e2bLifecycle'] => {
  const onTimeout = readE2BOnTimeout(env);
  const keepMemory = parseBooleanEnv(env.CODE_AGENT_E2B_KEEP_MEMORY, true);
  const autoResume = parseBooleanEnv(env.CODE_AGENT_E2B_AUTO_RESUME, onTimeout === 'pause');

  if (autoResume && onTimeout !== 'pause') {
    throw new Error('CODE_AGENT_E2B_AUTO_RESUME=true requires CODE_AGENT_E2B_ON_TIMEOUT=pause');
  }
  if (autoResume && !keepMemory) {
    throw new Error('CODE_AGENT_E2B_AUTO_RESUME=true requires CODE_AGENT_E2B_KEEP_MEMORY=true');
  }

  return { onTimeout, autoResume, keepMemory };
};

const readMode = (env: NodeJS.ProcessEnv): CodeAgentRunnerMode => {
  const value = env.CODE_AGENT_MODE?.trim();
  if (!value) {
    return 'plan';
  }
  const normalized = normalizeCodeAgentMode(value);
  if (normalized) {
    return normalized;
  }
  console.warn(`Unsupported CODE_AGENT_MODE: ${value}; falling back to plan`);
  return 'plan';
};

const isCodeAgentRunnerMode = (value: string): value is CodeAgentRunnerMode => (
  normalizeCodeAgentMode(value) !== null
);

const normalizeModeSet = (modes: CodeAgentRunnerMode[]) => {
  return normalizeCodeAgentModeSet(modes);
};

const readAvailableModes = (env: NodeJS.ProcessEnv): CodeAgentRunnerMode[] => {
  const configured = parseCsvEnv(env.CODE_AGENT_ALLOWED_RUN_MODES);
  if (configured.length > 0) {
    const invalid = configured.find(mode => !isCodeAgentRunnerMode(mode));
    if (invalid) {
      throw new Error(`Unsupported CODE_AGENT_ALLOWED_RUN_MODES entry: ${invalid}`);
    }
    return normalizeModeSet(configured as CodeAgentRunnerMode[]);
  }

  const legacyMode = readMode(env);
  return normalizeModeSet([legacyMode]);
};

const readDefaultMode = (env: NodeJS.ProcessEnv, availableModes: CodeAgentRunnerMode[]): CodeAgentRunnerMode => {
  const configured = env.CODE_AGENT_DEFAULT_MODE?.trim();
  if (!configured) {
    return 'plan';
  }
  const normalized = normalizeCodeAgentMode(configured);
  if (!normalized) {
    throw new Error(`Unsupported CODE_AGENT_DEFAULT_MODE: ${configured}`);
  }
  if (!availableModes.includes(normalized)) {
    throw new Error(`CODE_AGENT_DEFAULT_MODE=${configured} must be included in CODE_AGENT_ALLOWED_RUN_MODES`);
  }
  return normalized;
};

const highestAvailableMode = (availableModes: CodeAgentRunnerMode[]): CodeAgentRunnerMode => (
  highestCodeAgentMode(availableModes)
);

const hasPositiveNumber = (value?: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
};

const isHttpsUrl = (value?: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const hasModelProxySettings = (env: NodeJS.ProcessEnv) => (
  Boolean(env.CODE_AGENT_MODEL_PROXY_URL) || Boolean(env.CODE_AGENT_MODEL_PROXY_TOKEN)
);

const hasRoomTalkModelGatewaySettings = (env: NodeJS.ProcessEnv) => (
  env.CODE_AGENT_MODEL_ACCESS_STRATEGY === 'roomtalk_gateway' ||
  Boolean(env.CODE_AGENT_MODEL_GATEWAY_SECRET) ||
  Boolean(env.CODE_AGENT_MODEL_GATEWAY_PUBLIC_URL)
);

const hasModelProxyContract = (env: NodeJS.ProcessEnv) => (
  env.CODE_AGENT_MODEL_ACCESS_STRATEGY === 'proxy' &&
  isHttpsUrl(env.CODE_AGENT_MODEL_PROXY_URL) &&
  typeof env.CODE_AGENT_MODEL_PROXY_TOKEN === 'string' &&
  env.CODE_AGENT_MODEL_PROXY_TOKEN.trim().length > 0
);

const hasScopedProviderKeyContract = (env: NodeJS.ProcessEnv) => (
  env.CODE_AGENT_SCOPED_PROVIDER_KEY === 'true' &&
  hasPositiveNumber(env.CODE_AGENT_SCOPED_PROVIDER_KEY_TTL_SECONDS) &&
  hasPositiveNumber(env.CODE_AGENT_SCOPED_PROVIDER_KEY_BUDGET_USD) &&
  typeof env.CODE_AGENT_SCOPED_PROVIDER_KEY_AUDIT_ID === 'string' &&
  env.CODE_AGENT_SCOPED_PROVIDER_KEY_AUDIT_ID.length > 0
);

const usesOutOfBandModelAccess = (env: NodeJS.ProcessEnv) => (
  env.CODE_AGENT_MODEL_ACCESS_STRATEGY === 'proxy' ||
  env.CODE_AGENT_MODEL_ACCESS_STRATEGY === 'roomtalk_gateway' ||
  hasRoomTalkModelGatewaySettings(env) ||
  hasModelProxySettings(env) ||
  env.CODE_AGENT_SCOPED_PROVIDER_KEY === 'true'
);

const hasApprovedModelAccess = (config: CodeAgentRuntimeConfig, env: NodeJS.ProcessEnv) => {
  if (config.modelGateway) {
    return true;
  }
  if (hasModelProxyContract(env)) {
    return true;
  }
  // This flag means the sandbox image/session already has a short-lived scoped
  // provider key provisioned out of band. RoomTalk must not forward long-lived
  // provider keys when this contract or a model proxy is configured.
  return hasScopedProviderKeyContract(env);
};

const pickRunnerEnv = (env: NodeJS.ProcessEnv) => pickEnv(env, [
  'CODE_AGENT_SOURCE_DIR',
  'CODE_AGENT_WORKSPACE_ROOT',
  'CODE_AGENT_MAX_TOKENS',
  'ROOMTALK_CODE_AGENT_MAX_TOKENS',
  'ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS',
  'ROOMTALK_CODE_AGENT_ALLOW_SHELL',
  'CODE_AGENT_MODEL_PROXY_URL',
  'CODE_AGENT_MODEL_PROXY_TOKEN',
]);

const baseRunnerEnv = (
  env: NodeJS.ProcessEnv,
  sandboxProvider: CodeAgentSandboxProvider,
  runnerClient: CodeAgentRunnerClientKind
): Record<string, string> => {
  if (sandboxProvider !== 'e2b' || (runnerClient !== 'jsonl' && runnerClient !== 'daemon')) {
    return {};
  }
  return {
    PYTHONPATH: env.CODE_AGENT_RUNNER_PYTHONPATH || DEFAULT_CODE_AGENT_RUNNER_PYTHONPATH,
    CODE_AGENT_WORKSPACE_ROOT: env.CODE_AGENT_WORKSPACE_ROOT || env.CODE_AGENT_E2B_WORKSPACE || DEFAULT_CODE_AGENT_WORKSPACE_ROOT,
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || DEFAULT_PLAYWRIGHT_BROWSERS_PATH,
    NODE_PATH: env.NODE_PATH || DEFAULT_NODE_PATH,
  };
};

const providerEnv = (env: NodeJS.ProcessEnv): Partial<Record<AIModelProvider, Record<string, string>>> => ({
  anthropic: pickEnv(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']),
  deepseek: pickEnv(env, ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']),
  openai: pickEnv(env, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']),
  openrouter: pickEnv(env, ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']),
});

const shouldForwardProviderEnv = (env: NodeJS.ProcessEnv, runnerClient: CodeAgentRunnerClientKind, availableModes: CodeAgentRunnerMode[]) => (
  (runnerClient === 'jsonl' || runnerClient === 'daemon') &&
  !availableModes.some(codeAgentModeAllowsWriteTools) &&
  !usesOutOfBandModelAccess(env)
);

const parsePositiveIntegerEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const parsed = Number.parseInt(env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNonNegativeIntegerEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const parsed = Number.parseInt(env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parsePositiveNumberEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const parsed = Number(env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readModelGatewayConfig = (env: NodeJS.ProcessEnv): CodeAgentRuntimeConfig['modelGateway'] | undefined => {
  if (!hasRoomTalkModelGatewaySettings(env)) {
    return undefined;
  }
  if (env.CODE_AGENT_MODEL_ACCESS_STRATEGY && env.CODE_AGENT_MODEL_ACCESS_STRATEGY !== 'roomtalk_gateway') {
    return undefined;
  }

  const tokenSecret = env.CODE_AGENT_MODEL_GATEWAY_SECRET?.trim();
  if (!tokenSecret) {
    throw new Error('RoomTalk Code agent model gateway requires CODE_AGENT_MODEL_GATEWAY_SECRET');
  }
  const baseUrl = (env.CODE_AGENT_MODEL_GATEWAY_PUBLIC_URL || (env.CLIENT_URL ? `${env.CLIENT_URL.replace(/\/+$/, '')}/api/code-agent/model-gateway` : '')).trim();
  if (!baseUrl) {
    throw new Error('RoomTalk Code agent model gateway requires CODE_AGENT_MODEL_GATEWAY_PUBLIC_URL or CLIENT_URL');
  }
  if (!isHttpsUrl(baseUrl) && env.E2E_TEST_MODE !== 'true') {
    throw new Error('RoomTalk Code agent model gateway public URL must be HTTPS');
  }

  return {
    publicBaseUrl: baseUrl.replace(/\/+$/, ''),
    tokenSecret,
    tokenTtlSeconds: parsePositiveIntegerEnv(env, 'CODE_AGENT_MODEL_GATEWAY_TOKEN_TTL_SECONDS', 15 * 60),
    // Zero disables request-count limiting; timeout and USD budget limits still apply.
    maxRequestsPerTurn: parseNonNegativeIntegerEnv(env, 'CODE_AGENT_MODEL_GATEWAY_MAX_REQUESTS_PER_TURN', 0),
    turnBudgetUsd: parsePositiveNumberEnv(env, 'CODE_AGENT_MODEL_GATEWAY_TURN_BUDGET_USD', 2),
  };
};

const validateEnabledConfig = (config: CodeAgentRuntimeConfig, env: NodeJS.ProcessEnv) => {
  if ((config.runnerClient === 'jsonl' || config.runnerClient === 'daemon') && config.sandboxProvider === 'fake') {
    throw new Error(`CODE_AGENT_RUNNER_CLIENT=${config.runnerClient} requires a non-fake sandbox provider`);
  }
  if (
    config.sandboxProvider === 'e2b' &&
    config.runnerClient === 'fake' &&
    env.E2E_TEST_MODE !== 'true'
  ) {
    throw new Error('CODE_AGENT_SANDBOX_PROVIDER=e2b requires CODE_AGENT_RUNNER_CLIENT=jsonl outside explicit test mode');
  }
  if (config.sandboxProvider === 'e2b' && !config.e2bTemplateId) {
    throw new Error('CODE_AGENT_SANDBOX_PROVIDER=e2b requires CODE_AGENT_E2B_TEMPLATE_ID');
  }
  if (
    config.sandboxProvider === 'e2b' &&
    (config.runnerClient === 'jsonl' || config.runnerClient === 'daemon') &&
    !env.E2B_API_KEY &&
    !env.E2B_ACCESS_TOKEN
  ) {
    throw new Error('CODE_AGENT_SANDBOX_PROVIDER=e2b requires E2B_API_KEY or E2B_ACCESS_TOKEN');
  }

  const shellEnabled = config.runnerEnv.ROOMTALK_CODE_AGENT_ALLOW_SHELL === 'true';
  const writeToolsEnabled = config.runnerEnv.ROOMTALK_CODE_AGENT_ALLOW_WRITE_TOOLS === 'true' ||
    config.availableModes.some(codeAgentModeAllowsWriteTools);
  const requiresModelAccessContract = shellEnabled || writeToolsEnabled;
  if (
    hasRoomTalkModelGatewaySettings(env) &&
    env.CODE_AGENT_MODEL_ACCESS_STRATEGY &&
    env.CODE_AGENT_MODEL_ACCESS_STRATEGY !== 'roomtalk_gateway'
  ) {
    throw new Error('RoomTalk Code agent model gateway settings require CODE_AGENT_MODEL_ACCESS_STRATEGY=roomtalk_gateway');
  }
  if (
    hasModelProxySettings(env) &&
    env.CODE_AGENT_MODEL_ACCESS_STRATEGY !== 'proxy'
  ) {
    throw new Error('Code agent model proxy settings require CODE_AGENT_MODEL_ACCESS_STRATEGY=proxy');
  }
  if (env.CODE_AGENT_MODEL_ACCESS_STRATEGY === 'proxy' && !hasModelProxyContract(env)) {
    throw new Error('Code agent model proxy mode requires HTTPS CODE_AGENT_MODEL_PROXY_URL and CODE_AGENT_MODEL_PROXY_TOKEN');
  }
  if ((config.runnerClient === 'jsonl' || config.runnerClient === 'daemon') && env.CODE_AGENT_SCOPED_PROVIDER_KEY === 'true' && !hasScopedProviderKeyContract(env)) {
    throw new Error('JSONL/daemon code-agent scoped provider key mode requires TTL, budget, and audit id');
  }
  if ((config.runnerClient === 'jsonl' || config.runnerClient === 'daemon') && requiresModelAccessContract && !hasApprovedModelAccess(config, env)) {
    throw new Error('JSONL/daemon code-agent write or shell mode requires RoomTalk model gateway, model proxy with token, or scoped provider key contract');
  }

  if (config.sandboxProvider === 'e2b' && (config.runnerClient === 'jsonl' || config.runnerClient === 'daemon')) {
    if (config.artifactMode === 'production') {
      if (!config.artifactVersion || !config.codeAgentSourceRef) {
        throw new Error('Production code agent E2B JSONL mode requires CODE_AGENT_ARTIFACT_VERSION and CODE_AGENT_SOURCE_REF');
      }
      if (config.runnerEnv.CODE_AGENT_SOURCE_DIR) {
        throw new Error('Production code agent E2B JSONL mode must use the pinned sandbox artifact, not CODE_AGENT_SOURCE_DIR');
      }
    }
    if (config.artifactMode === 'development' && !config.runnerEnv.CODE_AGENT_SOURCE_DIR) {
      throw new Error('Development code agent E2B JSONL mode requires CODE_AGENT_SOURCE_DIR for the mounted code-agent engine source');
    }
  }
};

export const resolveCodeAgentRuntimeConfig = (env: NodeJS.ProcessEnv): CodeAgentRuntimeConfig => {
  const availableModes = readAvailableModes(env);
  const defaultMode = readDefaultMode(env, availableModes);
  const mode = highestAvailableMode(availableModes);
  const backend = readCodeAgentBackend(env);
  const runnerClient = readRunnerClient(env);
  const sandboxProvider = readSandboxProvider(env);
  const artifactMode = readArtifactMode(env);
  const e2bLifecycle = readE2BLifecycle(env);
  const modelGateway = readModelGatewayConfig(env);
  const runnerCommand = env.CODE_AGENT_RUNNER_COMMAND || defaultRunnerCommandForBackend(backend);
  const runnerCommandByBackend = {
    'code-agent': backend === 'code-agent' ? runnerCommand : DEFAULT_CODE_AGENT_RUNNER_COMMAND,
    codex: env.CODEX_CLI_RUNNER_COMMAND || (backend === 'codex' ? runnerCommand : DEFAULT_CODEX_CLI_RUNNER_COMMAND),
    'codex-app-server': env.CODEX_APP_SERVER_RUNNER_COMMAND || (backend === 'codex-app-server' ? runnerCommand : DEFAULT_CODEX_APP_SERVER_RUNNER_COMMAND),
  } satisfies Partial<Record<CodeAgentBackend, string>>;
  const daemonCommand = env.CODE_AGENT_DAEMON_COMMAND || DEFAULT_CODE_AGENT_DAEMON_COMMAND;
  const config: CodeAgentRuntimeConfig = {
    enabled: env.CODE_AGENT_ENABLED === 'true',
    backend,
    sandboxProvider,
    runnerClient,
    artifactMode,
    artifactVersion: env.CODE_AGENT_ARTIFACT_VERSION,
    codeAgentSourceRef: env.CODE_AGENT_SOURCE_REF,
    allowedClientIds: parseCsvEnv(env.CODE_AGENT_ALLOWED_USER_IDS),
    mode,
    availableModes,
    defaultMode,
    modelGateway,
    runnerCommand,
    runnerCommandByBackend,
    daemonCommand,
    allowedPaths: parseCsvEnv(env.CODE_AGENT_ALLOWED_PATHS || '.'),
    runnerEnv: {
      ...baseRunnerEnv(env, sandboxProvider, runnerClient),
      ...pickRunnerEnv(env),
    },
    runnerProviderEnvByProvider: shouldForwardProviderEnv(env, runnerClient, availableModes) ? providerEnv(env) : {},
    e2bTemplateId: env.CODE_AGENT_E2B_TEMPLATE_ID,
    e2bWorkspace: env.CODE_AGENT_E2B_WORKSPACE,
    e2bLifecycle,
  };

  if (config.enabled) {
    validateEnabledConfig(config, env);
  }
  return config;
};
