import { AIModelProvider } from '../types';
import { CocoSandboxProvider } from './cocoSandboxService';
import { CocoRunnerMode } from './cocoRunnerProtocol';

export type CocoRunnerClientKind = 'fake' | 'jsonl';

export interface CocoRuntimeConfig {
  enabled: boolean;
  sandboxProvider: CocoSandboxProvider;
  runnerClient: CocoRunnerClientKind;
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

const hasApprovedModelAccess = (env: NodeJS.ProcessEnv) => {
  if (env.COCO_MODEL_ACCESS_STRATEGY === 'proxy' && env.COCO_MODEL_PROXY_URL) {
    return true;
  }
  // This flag means the sandbox image/session already has a short-lived scoped
  // provider key provisioned out of band. RoomTalk must not forward long-lived
  // provider keys when this contract or a model proxy is configured.
  return env.COCO_SCOPED_PROVIDER_KEY === 'true';
};

const pickRunnerEnv = (env: NodeJS.ProcessEnv) => pickEnv(env, [
  'COCO_SOURCE_DIR',
  'COCO_MAX_TOKENS',
  'ROOMTALK_COCO_MAX_TOKENS',
  'ROOMTALK_COCO_ALLOW_WRITE_TOOLS',
  'ROOMTALK_COCO_ALLOW_SHELL',
  'COCO_MODEL_PROXY_URL',
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
  !hasApprovedModelAccess(env)
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
  const writeEnabled = config.runnerEnv.ROOMTALK_COCO_ALLOW_WRITE_TOOLS === 'true' || config.mode === 'acceptEdits';
  if (config.runnerClient === 'jsonl' && (shellEnabled || writeEnabled) && !hasApprovedModelAccess(env)) {
    throw new Error('JSONL Coco acceptEdits/write/Shell mode requires model proxy or scoped provider key configuration');
  }
};

export const resolveCocoRuntimeConfig = (env: NodeJS.ProcessEnv): CocoRuntimeConfig => {
  const mode: CocoRunnerMode = env.COCO_MODE === 'plan' ? 'plan' : 'acceptEdits';
  const runnerClient = readRunnerClient(env);
  const config: CocoRuntimeConfig = {
    enabled: env.COCO_ENABLED === 'true',
    sandboxProvider: readSandboxProvider(env),
    runnerClient,
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
