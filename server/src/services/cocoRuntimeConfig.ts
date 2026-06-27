import { AIModelProvider } from '../types';
import { CodeAgentBackend } from './codeAgentRunner';
import { CocoSandboxProvider } from './cocoSandboxService';
import { CocoRunnerMode } from './cocoRunnerProtocol';

export type CocoRunnerClientKind = 'fake' | 'jsonl';
export type CocoArtifactMode = 'production' | 'development';

export interface CocoRuntimeConfig {
  enabled: boolean;
  backend: CodeAgentBackend;
  sandboxProvider: CocoSandboxProvider;
  runnerClient: CocoRunnerClientKind;
  artifactMode: CocoArtifactMode;
  artifactVersion?: string;
  cocoSourceRef?: string;
  allowedClientIds: string[];
  mode: CocoRunnerMode;
  availableModes: CocoRunnerMode[];
  defaultMode: CocoRunnerMode;
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
}

export const DEFAULT_COCO_RUNNER_COMMAND = 'python -m roomtalk_coco_runner';
export const DEFAULT_COCO_RUNNER_PYTHONPATH = '/opt/coco/src:/opt/roomtalk_coco_runner';
export const DEFAULT_COCO_WORKSPACE_ROOT = '/workspace';

const parseCsvEnv = (value?: string) =>
  value?.split(',').map(item => item.trim()).filter(Boolean) || [];

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
    throw new Error('CODE_AGENT_BACKEND=codex is not implemented');
  }
  throw new Error(`Unsupported CODE_AGENT_BACKEND: ${value}`);
};

const readRunnerClient = (env: NodeJS.ProcessEnv): CocoRunnerClientKind => {
  const value = (env.COCO_RUNNER_CLIENT || 'fake').toLowerCase();
  if (value === 'fake' || value === 'jsonl') {
    return value;
  }
  throw new Error(`Unsupported COCO_RUNNER_CLIENT: ${value}`);
};

const readArtifactMode = (env: NodeJS.ProcessEnv): CocoArtifactMode => {
  const value = (env.COCO_ARTIFACT_MODE || 'production').toLowerCase();
  if (value === 'production' || value === 'development') {
    return value;
  }
  throw new Error(`Unsupported COCO_ARTIFACT_MODE: ${value}`);
};

const readMode = (env: NodeJS.ProcessEnv): CocoRunnerMode => {
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

const isCocoRunnerMode = (value: string): value is CocoRunnerMode => (
  value === 'plan' || value === 'acceptEdits'
);

const normalizeModeSet = (modes: CocoRunnerMode[]) => {
  const unique = Array.from(new Set(modes));
  return unique.includes('acceptEdits') && !unique.includes('plan')
    ? ['plan', ...unique] as CocoRunnerMode[]
    : unique;
};

const readAvailableModes = (env: NodeJS.ProcessEnv): CocoRunnerMode[] => {
  const configured = parseCsvEnv(env.COCO_ALLOWED_RUN_MODES);
  if (configured.length > 0) {
    const invalid = configured.find(mode => !isCocoRunnerMode(mode));
    if (invalid) {
      throw new Error(`Unsupported COCO_ALLOWED_RUN_MODES entry: ${invalid}`);
    }
    return normalizeModeSet(configured as CocoRunnerMode[]);
  }

  const legacyMode = readMode(env);
  return legacyMode === 'acceptEdits' ? ['plan', 'acceptEdits'] : ['plan'];
};

const readDefaultMode = (env: NodeJS.ProcessEnv, availableModes: CocoRunnerMode[]): CocoRunnerMode => {
  const configured = env.COCO_DEFAULT_MODE?.trim();
  if (!configured) {
    return 'plan';
  }
  if (!isCocoRunnerMode(configured)) {
    throw new Error(`Unsupported COCO_DEFAULT_MODE: ${configured}`);
  }
  if (!availableModes.includes(configured)) {
    throw new Error(`COCO_DEFAULT_MODE=${configured} must be included in COCO_ALLOWED_RUN_MODES`);
  }
  return configured;
};

const highestAvailableMode = (availableModes: CocoRunnerMode[]): CocoRunnerMode => (
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

const hasApprovedModelAccess = (config: CocoRuntimeConfig, env: NodeJS.ProcessEnv) => {
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
  runnerClient: CocoRunnerClientKind
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

const shouldForwardProviderEnv = (env: NodeJS.ProcessEnv, runnerClient: CocoRunnerClientKind, availableModes: CocoRunnerMode[]) => (
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

const readModelGatewayConfig = (env: NodeJS.ProcessEnv): CocoRuntimeConfig['modelGateway'] | undefined => {
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

const validateEnabledConfig = (config: CocoRuntimeConfig, env: NodeJS.ProcessEnv) => {
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

export const resolveCocoRuntimeConfig = (env: NodeJS.ProcessEnv): CocoRuntimeConfig => {
  const availableModes = readAvailableModes(env);
  const defaultMode = readDefaultMode(env, availableModes);
  const mode = highestAvailableMode(availableModes);
  const backend = readCodeAgentBackend(env);
  const runnerClient = readRunnerClient(env);
  const sandboxProvider = readSandboxProvider(env);
  const artifactMode = readArtifactMode(env);
  const modelGateway = readModelGatewayConfig(env);
  const config: CocoRuntimeConfig = {
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
    runnerCommand: env.COCO_RUNNER_COMMAND || DEFAULT_COCO_RUNNER_COMMAND,
    allowedPaths: parseCsvEnv(env.COCO_ALLOWED_PATHS || '.'),
    runnerEnv: {
      ...baseRunnerEnv(env, sandboxProvider, runnerClient),
      ...pickRunnerEnv(env),
    },
    runnerProviderEnvByProvider: shouldForwardProviderEnv(env, runnerClient, availableModes) ? providerEnv(env) : {},
    e2bTemplateId: env.COCO_E2B_TEMPLATE_ID,
    e2bWorkspace: env.COCO_E2B_WORKSPACE,
  };

  if (config.enabled) {
    validateEnabledConfig(config, env);
  }
  return config;
};
