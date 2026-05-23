import { AIModelProvider } from '../types';
import { CocoSandboxProvider } from './cocoSandboxService';
import { CocoRunnerMode } from './cocoRunnerProtocol';

export type CocoRunnerClientKind = 'fake' | 'jsonl';
export type CocoArtifactMode = 'production' | 'development';

export interface CocoRuntimeConfig {
  enabled: boolean;
  sandboxProvider: CocoSandboxProvider;
  runnerClient: CocoRunnerClientKind;
  artifactMode: CocoArtifactMode;
  artifactVersion?: string;
  cocoSourceRef?: string;
  allowedClientIds: string[];
  mode: CocoRunnerMode;
  runnerCommand: string;
  allowedPaths: string[];
  runnerEnv: Record<string, string>;
  runnerProviderEnvByProvider: Partial<Record<AIModelProvider, Record<string, string>>>;
  e2bTemplateId?: string;
  e2bWorkspace?: string;
}

export const DEFAULT_COCO_RUNNER_COMMAND = 'python -m roomtalk_coco_runner';

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
  hasModelProxySettings(env) ||
  env.COCO_SCOPED_PROVIDER_KEY === 'true'
);

const hasApprovedModelAccess = (env: NodeJS.ProcessEnv) => {
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
  'COCO_MAX_TOKENS',
  'ROOMTALK_COCO_MAX_TOKENS',
  'ROOMTALK_COCO_ALLOW_WRITE_TOOLS',
  'ROOMTALK_COCO_ALLOW_SHELL',
  'COCO_MODEL_PROXY_URL',
  'COCO_MODEL_PROXY_TOKEN',
]);

const providerEnv = (env: NodeJS.ProcessEnv): Partial<Record<AIModelProvider, Record<string, string>>> => ({
  anthropic: pickEnv(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']),
  deepseek: pickEnv(env, ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']),
  openai: pickEnv(env, ['OPENAI_API_KEY', 'OPENAI_BASE_URL']),
  openrouter: pickEnv(env, ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']),
});

const shouldForwardProviderEnv = (env: NodeJS.ProcessEnv, runnerClient: CocoRunnerClientKind, mode: CocoRunnerMode) => (
  runnerClient === 'jsonl' &&
  mode === 'plan' &&
  !usesOutOfBandModelAccess(env)
);

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

  const shellEnabled = config.runnerEnv.ROOMTALK_COCO_ALLOW_SHELL === 'true';
  const writeToolsEnabled = config.runnerEnv.ROOMTALK_COCO_ALLOW_WRITE_TOOLS === 'true' || config.mode === 'acceptEdits';
  const requiresModelAccessContract = shellEnabled || writeToolsEnabled;
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
  if (config.runnerClient === 'jsonl' && requiresModelAccessContract && !hasApprovedModelAccess(env)) {
    throw new Error('JSONL Coco acceptEdits/write/Shell mode requires model proxy with token or scoped provider key contract');
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
  const mode: CocoRunnerMode = env.COCO_MODE === 'plan' ? 'plan' : 'acceptEdits';
  const runnerClient = readRunnerClient(env);
  const artifactMode = readArtifactMode(env);
  const config: CocoRuntimeConfig = {
    enabled: env.COCO_ENABLED === 'true',
    sandboxProvider: readSandboxProvider(env),
    runnerClient,
    artifactMode,
    artifactVersion: env.COCO_ARTIFACT_VERSION,
    cocoSourceRef: env.COCO_SOURCE_REF,
    allowedClientIds: parseCsvEnv(env.COCO_ALLOWED_USER_IDS),
    mode,
    runnerCommand: env.COCO_RUNNER_COMMAND || DEFAULT_COCO_RUNNER_COMMAND,
    allowedPaths: parseCsvEnv(env.COCO_ALLOWED_PATHS || '.'),
    runnerEnv: pickRunnerEnv(env),
    runnerProviderEnvByProvider: shouldForwardProviderEnv(env, runnerClient, mode) ? providerEnv(env) : {},
    e2bTemplateId: env.COCO_E2B_TEMPLATE_ID,
    e2bWorkspace: env.COCO_E2B_WORKSPACE,
  };

  if (config.enabled) {
    validateEnabledConfig(config, env);
  }
  return config;
};
