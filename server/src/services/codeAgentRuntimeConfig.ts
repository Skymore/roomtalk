import { AIModelProvider } from '../types';
import { CodeAgentBackend } from './codeAgentRunner';
import { CocoSandboxProvider } from './cocoSandboxService';
import { CodeAgentRunnerMode } from './codeAgentRunnerProtocol';

export type CodeAgentRunnerClientKind = 'fake' | 'jsonl';
export type CodeAgentArtifactMode = 'production' | 'development';
export type CodeAgentE2BOnTimeout = 'kill' | 'pause';

export interface CodeAgentRuntimeConfig {
  enabled: boolean;
  backend: CodeAgentBackend;
  sandboxProvider: CocoSandboxProvider;
  runnerClient: CodeAgentRunnerClientKind;
  artifactMode: CodeAgentArtifactMode;
  artifactVersion?: string;
  cocoSourceRef?: string;
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

export const DEFAULT_COCO_RUNNER_COMMAND = 'python -m roomtalk_coco_runner';
export const DEFAULT_CODEX_CLI_RUNNER_COMMAND = 'python -m roomtalk_coco_runner.codex_cli';
export const DEFAULT_COCO_RUNNER_PYTHONPATH = '/opt/coco/src:/opt/roomtalk_coco_runner';
export const DEFAULT_COCO_WORKSPACE_ROOT = '/workspace';
export const DEFAULT_COCO_E2B_PAUSE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_COCO_E2B_KILL_TIMEOUT_MS = 60 * 60 * 1000;

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

const readSandboxProvider = (env: NodeJS.ProcessEnv): CocoSandboxProvider => {
  const value = (env.COCO_SANDBOX_PROVIDER || 'fake').toLowerCase();
  if (value === 'fake' || value === 'e2b') {
    return value;
  }
  throw new Error(`Unsupported COCO_SANDBOX_PROVIDER: ${value}`);
};

const readCodeAgentBackend = (env: NodeJS.ProcessEnv): CodeAgentBackend => {
  const value = (env.CODE_AGENT_BACKEND || 'coco').toLowerCase();
  if (value === 'coco') {
    return value;
  }
  if (value === 'codex') {
    if (env.CODEX_CLI_BACKEND_ENABLED !== 'true') {
      throw new Error('CODE_AGENT_BACKEND=codex requires CODEX_CLI_BACKEND_ENABLED=true');
    }
    return value;
  }
  throw new Error(`Unsupported CODE_AGENT_BACKEND: ${value}`);
};

const readRunnerClient = (env: NodeJS.ProcessEnv): CodeAgentRunnerClientKind => {
  const value = (env.COCO_RUNNER_CLIENT || 'fake').toLowerCase();
  if (value === 'fake' || value === 'jsonl') {
    return value;
  }
  throw new Error(`Unsupported COCO_RUNNER_CLIENT: ${value}`);
};

const defaultRunnerCommandForBackend = (backend: CodeAgentBackend) => (
  backend === 'codex' ? DEFAULT_CODEX_CLI_RUNNER_COMMAND : DEFAULT_COCO_RUNNER_COMMAND
);

const readArtifactMode = (env: NodeJS.ProcessEnv): CodeAgentArtifactMode => {
  const value = (env.COCO_ARTIFACT_MODE || 'production').toLowerCase();
  if (value === 'production' || value === 'development') {
    return value;
  }
  throw new Error(`Unsupported COCO_ARTIFACT_MODE: ${value}`);
};

const readE2BOnTimeout = (env: NodeJS.ProcessEnv): CodeAgentE2BOnTimeout => {
  const value = (env.COCO_E2B_ON_TIMEOUT || 'pause').trim();
  if (value === 'pause' || value === 'kill') {
    return value;
  }
  throw new Error(`Unsupported COCO_E2B_ON_TIMEOUT: ${value}`);
};

const readE2BLifecycle = (env: NodeJS.ProcessEnv): CodeAgentRuntimeConfig['e2bLifecycle'] => {
  const onTimeout = readE2BOnTimeout(env);
  const keepMemory = parseBooleanEnv(env.COCO_E2B_KEEP_MEMORY, true);
  const autoResume = parseBooleanEnv(env.COCO_E2B_AUTO_RESUME, onTimeout === 'pause');

  if (autoResume && onTimeout !== 'pause') {
    throw new Error('COCO_E2B_AUTO_RESUME=true requires COCO_E2B_ON_TIMEOUT=pause');
  }
  if (autoResume && !keepMemory) {
    throw new Error('COCO_E2B_AUTO_RESUME=true requires COCO_E2B_KEEP_MEMORY=true');
  }

  return { onTimeout, autoResume, keepMemory };
};

const readMode = (env: NodeJS.ProcessEnv): CodeAgentRunnerMode => {
  const value = env.COCO_MODE?.trim();
  if (!value || value === 'plan') {
    return 'plan';
  }
  if (value === 'acceptEdits') {
    return 'acceptEdits';
  }
  console.warn(`Unsupported COCO_MODE: ${value}; falling back to plan`);
  return 'plan';
};

const isCodeAgentRunnerMode = (value: string): value is CodeAgentRunnerMode => (
  value === 'plan' || value === 'acceptEdits'
);

const normalizeModeSet = (modes: CodeAgentRunnerMode[]) => {
  const unique = Array.from(new Set(modes));
  return unique.includes('acceptEdits') && !unique.includes('plan')
    ? ['plan', ...unique] as CodeAgentRunnerMode[]
    : unique;
};

const readAvailableModes = (env: NodeJS.ProcessEnv): CodeAgentRunnerMode[] => {
  const configured = parseCsvEnv(env.COCO_ALLOWED_RUN_MODES);
  if (configured.length > 0) {
    const invalid = configured.find(mode => !isCodeAgentRunnerMode(mode));
    if (invalid) {
      throw new Error(`Unsupported COCO_ALLOWED_RUN_MODES entry: ${invalid}`);
    }
    return normalizeModeSet(configured as CodeAgentRunnerMode[]);
  }

  const legacyMode = readMode(env);
  return legacyMode === 'acceptEdits' ? ['plan', 'acceptEdits'] : ['plan'];
};

const readDefaultMode = (env: NodeJS.ProcessEnv, availableModes: CodeAgentRunnerMode[]): CodeAgentRunnerMode => {
  const configured = env.COCO_DEFAULT_MODE?.trim();
  if (!configured) {
    return 'plan';
  }
  if (!isCodeAgentRunnerMode(configured)) {
    throw new Error(`Unsupported COCO_DEFAULT_MODE: ${configured}`);
  }
  if (!availableModes.includes(configured)) {
    throw new Error(`COCO_DEFAULT_MODE=${configured} must be included in COCO_ALLOWED_RUN_MODES`);
  }
  return configured;
};

const highestAvailableMode = (availableModes: CodeAgentRunnerMode[]): CodeAgentRunnerMode => (
  availableModes.includes('acceptEdits') ? 'acceptEdits' : 'plan'
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
  Boolean(env.COCO_MODEL_PROXY_URL) || Boolean(env.COCO_MODEL_PROXY_TOKEN)
);

const hasRoomTalkModelGatewaySettings = (env: NodeJS.ProcessEnv) => (
  env.COCO_MODEL_ACCESS_STRATEGY === 'roomtalk_gateway' ||
  Boolean(env.COCO_MODEL_GATEWAY_SECRET) ||
  Boolean(env.COCO_MODEL_GATEWAY_PUBLIC_URL)
);

const hasModelProxyContract = (env: NodeJS.ProcessEnv) => (
  env.COCO_MODEL_ACCESS_STRATEGY === 'proxy' &&
  isHttpsUrl(env.COCO_MODEL_PROXY_URL) &&
  typeof env.COCO_MODEL_PROXY_TOKEN === 'string' &&
  env.COCO_MODEL_PROXY_TOKEN.trim().length > 0
);

const hasScopedProviderKeyContract = (env: NodeJS.ProcessEnv) => (
  env.COCO_SCOPED_PROVIDER_KEY === 'true' &&
  hasPositiveNumber(env.COCO_SCOPED_PROVIDER_KEY_TTL_SECONDS) &&
  hasPositiveNumber(env.COCO_SCOPED_PROVIDER_KEY_BUDGET_USD) &&
  typeof env.COCO_SCOPED_PROVIDER_KEY_AUDIT_ID === 'string' &&
  env.COCO_SCOPED_PROVIDER_KEY_AUDIT_ID.length > 0
);

const usesOutOfBandModelAccess = (env: NodeJS.ProcessEnv) => (
  env.COCO_MODEL_ACCESS_STRATEGY === 'proxy' ||
  env.COCO_MODEL_ACCESS_STRATEGY === 'roomtalk_gateway' ||
  hasRoomTalkModelGatewaySettings(env) ||
  hasModelProxySettings(env) ||
  env.COCO_SCOPED_PROVIDER_KEY === 'true'
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
  'COCO_SOURCE_DIR',
  'COCO_WORKSPACE_ROOT',
  'COCO_MAX_TOKENS',
  'ROOMTALK_COCO_MAX_TOKENS',
  'ROOMTALK_COCO_ALLOW_WRITE_TOOLS',
  'ROOMTALK_COCO_ALLOW_SHELL',
  'COCO_MODEL_PROXY_URL',
  'COCO_MODEL_PROXY_TOKEN',
]);

const baseRunnerEnv = (
  env: NodeJS.ProcessEnv,
  sandboxProvider: CocoSandboxProvider,
  runnerClient: CodeAgentRunnerClientKind
): Record<string, string> => {
  if (sandboxProvider !== 'e2b' || runnerClient !== 'jsonl') {
    return {};
  }
  return {
    PYTHONPATH: env.COCO_RUNNER_PYTHONPATH || DEFAULT_COCO_RUNNER_PYTHONPATH,
    COCO_WORKSPACE_ROOT: env.COCO_WORKSPACE_ROOT || env.COCO_E2B_WORKSPACE || DEFAULT_COCO_WORKSPACE_ROOT,
  };
};

const providerEnv = (env: NodeJS.ProcessEnv): Partial<Record<AIModelProvider, Record<string, string>>> => ({
  anthropic: pickEnv(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']),
  deepseek: pickEnv(env, ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']),
  openai: pickEnv(env, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']),
  openrouter: pickEnv(env, ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']),
});

const shouldForwardProviderEnv = (env: NodeJS.ProcessEnv, runnerClient: CodeAgentRunnerClientKind, availableModes: CodeAgentRunnerMode[]) => (
  runnerClient === 'jsonl' &&
  !availableModes.includes('acceptEdits') &&
  !usesOutOfBandModelAccess(env)
);

const parsePositiveIntegerEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const parsed = Number.parseInt(env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveNumberEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const parsed = Number(env[name] || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readModelGatewayConfig = (env: NodeJS.ProcessEnv): CodeAgentRuntimeConfig['modelGateway'] | undefined => {
  if (!hasRoomTalkModelGatewaySettings(env)) {
    return undefined;
  }
  if (env.COCO_MODEL_ACCESS_STRATEGY && env.COCO_MODEL_ACCESS_STRATEGY !== 'roomtalk_gateway') {
    return undefined;
  }

  const tokenSecret = env.COCO_MODEL_GATEWAY_SECRET?.trim();
  if (!tokenSecret) {
    throw new Error('RoomTalk Coco model gateway requires COCO_MODEL_GATEWAY_SECRET');
  }
  const baseUrl = (env.COCO_MODEL_GATEWAY_PUBLIC_URL || (env.CLIENT_URL ? `${env.CLIENT_URL.replace(/\/+$/, '')}/api/coco/model-gateway` : '')).trim();
  if (!baseUrl) {
    throw new Error('RoomTalk Coco model gateway requires COCO_MODEL_GATEWAY_PUBLIC_URL or CLIENT_URL');
  }
  if (!isHttpsUrl(baseUrl) && env.E2E_TEST_MODE !== 'true') {
    throw new Error('RoomTalk Coco model gateway public URL must be HTTPS');
  }

  return {
    publicBaseUrl: baseUrl.replace(/\/+$/, ''),
    tokenSecret,
    tokenTtlSeconds: parsePositiveIntegerEnv(env, 'COCO_MODEL_GATEWAY_TOKEN_TTL_SECONDS', 15 * 60),
    maxRequestsPerTurn: parsePositiveIntegerEnv(env, 'COCO_MODEL_GATEWAY_MAX_REQUESTS_PER_TURN', 20),
    turnBudgetUsd: parsePositiveNumberEnv(env, 'COCO_MODEL_GATEWAY_TURN_BUDGET_USD', 2),
  };
};

const validateEnabledConfig = (config: CodeAgentRuntimeConfig, env: NodeJS.ProcessEnv) => {
  if (config.runnerClient === 'jsonl' && config.sandboxProvider === 'fake') {
    throw new Error('COCO_RUNNER_CLIENT=jsonl requires a non-fake sandbox provider');
  }
  if (
    config.sandboxProvider === 'e2b' &&
    config.runnerClient === 'fake' &&
    env.E2E_TEST_MODE !== 'true'
  ) {
    throw new Error('COCO_SANDBOX_PROVIDER=e2b requires COCO_RUNNER_CLIENT=jsonl outside explicit test mode');
  }
  if (config.sandboxProvider === 'e2b' && !config.e2bTemplateId) {
    throw new Error('COCO_SANDBOX_PROVIDER=e2b requires COCO_E2B_TEMPLATE_ID');
  }
  if (
    config.sandboxProvider === 'e2b' &&
    config.runnerClient === 'jsonl' &&
    !env.E2B_API_KEY &&
    !env.E2B_ACCESS_TOKEN
  ) {
    throw new Error('COCO_SANDBOX_PROVIDER=e2b requires E2B_API_KEY or E2B_ACCESS_TOKEN');
  }

  const shellEnabled = config.runnerEnv.ROOMTALK_COCO_ALLOW_SHELL === 'true';
  const writeToolsEnabled = config.runnerEnv.ROOMTALK_COCO_ALLOW_WRITE_TOOLS === 'true' || config.availableModes.includes('acceptEdits');
  const requiresModelAccessContract = shellEnabled || writeToolsEnabled;
  if (
    hasRoomTalkModelGatewaySettings(env) &&
    env.COCO_MODEL_ACCESS_STRATEGY &&
    env.COCO_MODEL_ACCESS_STRATEGY !== 'roomtalk_gateway'
  ) {
    throw new Error('RoomTalk Coco model gateway settings require COCO_MODEL_ACCESS_STRATEGY=roomtalk_gateway');
  }
  if (
    hasModelProxySettings(env) &&
    env.COCO_MODEL_ACCESS_STRATEGY !== 'proxy'
  ) {
    throw new Error('Coco model proxy settings require COCO_MODEL_ACCESS_STRATEGY=proxy');
  }
  if (env.COCO_MODEL_ACCESS_STRATEGY === 'proxy' && !hasModelProxyContract(env)) {
    throw new Error('Coco model proxy mode requires HTTPS COCO_MODEL_PROXY_URL and COCO_MODEL_PROXY_TOKEN');
  }
  if (config.runnerClient === 'jsonl' && env.COCO_SCOPED_PROVIDER_KEY === 'true' && !hasScopedProviderKeyContract(env)) {
    throw new Error('JSONL Coco scoped provider key mode requires TTL, budget, and audit id');
  }
  if (config.runnerClient === 'jsonl' && requiresModelAccessContract && !hasApprovedModelAccess(config, env)) {
    throw new Error('JSONL Coco acceptEdits/write/Shell mode requires RoomTalk model gateway, model proxy with token, or scoped provider key contract');
  }

  if (config.sandboxProvider === 'e2b' && config.runnerClient === 'jsonl') {
    if (config.artifactMode === 'production') {
      if (!config.artifactVersion || !config.cocoSourceRef) {
        throw new Error('Production Coco E2B JSONL mode requires COCO_ARTIFACT_VERSION and COCO_SOURCE_REF');
      }
      if (config.runnerEnv.COCO_SOURCE_DIR) {
        throw new Error('Production Coco E2B JSONL mode must use the pinned sandbox artifact, not COCO_SOURCE_DIR');
      }
    }
    if (config.artifactMode === 'development' && !config.runnerEnv.COCO_SOURCE_DIR) {
      throw new Error('Development Coco E2B JSONL mode requires COCO_SOURCE_DIR for the mounted Coco source');
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
  const config: CodeAgentRuntimeConfig = {
    enabled: env.COCO_ENABLED === 'true',
    backend,
    sandboxProvider,
    runnerClient,
    artifactMode,
    artifactVersion: env.COCO_ARTIFACT_VERSION,
    cocoSourceRef: env.COCO_SOURCE_REF,
    allowedClientIds: parseCsvEnv(env.COCO_ALLOWED_USER_IDS),
    mode,
    availableModes,
    defaultMode,
    modelGateway,
    runnerCommand: env.COCO_RUNNER_COMMAND || defaultRunnerCommandForBackend(backend),
    allowedPaths: parseCsvEnv(env.COCO_ALLOWED_PATHS || '.'),
    runnerEnv: {
      ...baseRunnerEnv(env, sandboxProvider, runnerClient),
      ...pickRunnerEnv(env),
    },
    runnerProviderEnvByProvider: shouldForwardProviderEnv(env, runnerClient, availableModes) ? providerEnv(env) : {},
    e2bTemplateId: env.COCO_E2B_TEMPLATE_ID,
    e2bWorkspace: env.COCO_E2B_WORKSPACE,
    e2bLifecycle,
  };

  if (config.enabled) {
    validateEnabledConfig(config, env);
  }
  return config;
};
