import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { Logger } from '../logger';
import { AIModelOption } from '../types';
import { DEFAULT_AI_MODEL_ID, createAIModelRegistry } from '../services/aiModels';
import { resolveCodexCliRunnerConfig } from '../services/codexCliRunnerConfig';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION } from '../services/codeAgentRunnerProtocol';
import { resolveCodeAgentRuntimeConfig, CodeAgentRuntimeConfig } from '../services/codeAgentRuntimeConfig';
import { E2BCodeAgentSandboxService } from '../services/e2bCodeAgentSandboxService';
import { createE2BSdkDriver } from '../services/e2bSdkDriver';
import { JsonlCodeAgentRunnerClient } from '../services/jsonlCodeAgentRunner';

const DEFAULT_SMOKE_PROMPT = 'Reply exactly: codex e2b smoke ok';
const DEFAULT_SANDBOX_TTL_MS = 60 * 60 * 1000;

type CodexE2BSmokePlan =
  | { run: false; reason: string }
  | {
    run: true;
    config: CodeAgentRuntimeConfig;
    selectedModel: AIModelOption;
    authJsonPath: string;
    authSecretPath: string;
    refreshedAuthSecretPath: string;
    runnerEnv: Record<string, string>;
    roomId: string;
    turnId: string;
    prompt: string;
    imageUrl?: string;
    expectedText?: string;
    sandboxTtlMs: number;
    e2bConnection: {
      apiKey?: string;
      accessToken?: string;
      domain?: string;
      apiUrl?: string;
      sandboxUrl?: string;
      requestTimeoutMs: number;
    };
  };

export const buildCodexE2BSmokePlan = (env: NodeJS.ProcessEnv): CodexE2BSmokePlan => {
  if (env.RUN_CODEX_E2B_SMOKE !== 'true') {
    return { run: false, reason: 'RUN_CODEX_E2B_SMOKE is not true' };
  }
  if (!env.CODE_AGENT_E2B_TEMPLATE_ID) {
    return { run: false, reason: 'CODE_AGENT_E2B_TEMPLATE_ID is not set' };
  }
  if (!env.E2B_API_KEY && !env.E2B_ACCESS_TOKEN) {
    return { run: false, reason: 'E2B_API_KEY or E2B_ACCESS_TOKEN is not set' };
  }

  const authJsonPath = resolveAuthJsonPath(env);
  if (!authJsonPath) {
    return { run: false, reason: 'CODEX_E2B_SMOKE_AUTH_JSON_PATH is not set and ~/.codex/auth.json is unavailable' };
  }
  const smokeBackend = resolveSmokeBackend(env.CODEX_E2B_SMOKE_BACKEND);
  const imageUrl = resolveSmokeImageUrl(env.CODEX_E2B_SMOKE_IMAGE_URL);
  if (imageUrl && smokeBackend === 'codex') {
    throw new Error('CODEX_E2B_SMOKE_IMAGE_URL requires the codex-app-server backend');
  }

  const smokeEnv = {
    ...env,
    CODE_AGENT_ENABLED: 'true',
    CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
    CODE_AGENT_RUNNER_CLIENT: 'jsonl',
    CODE_AGENT_BACKEND: smokeBackend,
    CODEX_CLI_BACKEND_ENABLED: 'true',
  };
  const config = resolveCodeAgentRuntimeConfig(smokeEnv);
  const codexCli = resolveCodexCliRunnerConfig(smokeEnv);
  const registry = createAIModelRegistry({
    defaultModelId: env.AI_MODEL || env.OPENROUTER_MODEL || DEFAULT_AI_MODEL_ID,
  });
  const selectedModel = registry.normalizeAIModel(env.CODEX_E2B_SMOKE_MODEL);
  const suffix = Date.now().toString(36);
  const turnId = env.CODEX_E2B_SMOKE_TURN_ID || `turn-codex-e2b-${suffix}`;

  return {
    run: true,
    config,
    selectedModel,
    authJsonPath,
    authSecretPath: `/tmp/roomtalk-codex/${sanitizePathPart(turnId)}-auth.json`,
    refreshedAuthSecretPath: `/tmp/roomtalk-codex/${sanitizePathPart(turnId)}-refreshed-auth.json`,
    runnerEnv: {
      PYTHONUNBUFFERED: '1',
      ...config.runnerEnv,
      CODEX_CLI_BIN: codexCli.cliBin,
    },
    roomId: env.CODEX_E2B_SMOKE_ROOM_ID || `codex-e2b-smoke-${suffix}`,
    turnId,
    prompt: env.CODEX_E2B_SMOKE_PROMPT || DEFAULT_SMOKE_PROMPT,
    imageUrl,
    expectedText: env.CODEX_E2B_SMOKE_EXPECTED || 'codex e2b smoke ok',
    sandboxTtlMs: parsePositiveMs(env.CODE_AGENT_SANDBOX_TTL_MS, DEFAULT_SANDBOX_TTL_MS),
    e2bConnection: {
      apiKey: env.E2B_API_KEY,
      accessToken: env.E2B_ACCESS_TOKEN,
      domain: env.E2B_DOMAIN,
      apiUrl: env.E2B_API_URL,
      sandboxUrl: env.E2B_SANDBOX_URL,
      requestTimeoutMs: parsePositiveMs(env.E2B_REQUEST_TIMEOUT_MS, 60_000),
    },
  };
};

const resolveSmokeBackend = (value: string | undefined): 'codex' | 'codex-app-server' => {
  const normalized = (value || 'codex-app-server').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'codex-app-server') {
    return normalized;
  }
  throw new Error(`Unsupported CODEX_E2B_SMOKE_BACKEND: ${value}`);
};

const resolveSmokeImageUrl = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('CODEX_E2B_SMOKE_IMAGE_URL must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error('CODEX_E2B_SMOKE_IMAGE_URL must be an absolute HTTPS URL');
  }
  return normalized;
};

export const runCodexE2BSmoke = async (
  plan: Extract<CodexE2BSmokePlan, { run: true }>,
  logger = new Logger('CodexE2BSmoke')
) => {
  const sandboxService = new E2BCodeAgentSandboxService(createE2BSdkDriver({
    apiKey: plan.e2bConnection.apiKey,
    accessToken: plan.e2bConnection.accessToken,
    domain: plan.e2bConnection.domain,
    apiUrl: plan.e2bConnection.apiUrl,
    sandboxUrl: plan.e2bConnection.sandboxUrl,
    requestTimeoutMs: plan.e2bConnection.requestTimeoutMs,
  }), {
    templateId: plan.config.e2bTemplateId || '',
    workspace: plan.config.e2bWorkspace,
    artifactVersion: plan.config.artifactVersion,
    codeAgentSourceRef: plan.config.codeAgentSourceRef,
    lifecycle: plan.config.e2bLifecycle,
    logger,
  });
  const runnerClient = new JsonlCodeAgentRunnerClient();
  const handle = await sandboxService.create({
    roomId: plan.roomId,
    creatorId: 'codex-e2b-smoke',
    ttlMs: plan.sandboxTtlMs,
  });
  let runnerProcess: Awaited<ReturnType<E2BCodeAgentSandboxService['startRunner']>> | undefined;

  try {
    logger.info('Created E2B Codex smoke sandbox', { sandboxId: handle.id, roomId: plan.roomId });
    await sandboxService.initializeWorkspaceVersionControl(handle);
    const authJson = await readPrivateAuthJson(plan.authJsonPath);
    await sandboxService.writeSecretFile(handle, {
      path: plan.authSecretPath,
      content: authJson,
    });

    runnerProcess = await sandboxService.startRunner({
      handle,
      command: plan.config.runnerCommand,
      env: {
        ...plan.runnerEnv,
        ROOMTALK_CODEX_AUTH_JSON_PATH: plan.authSecretPath,
        ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH: plan.refreshedAuthSecretPath,
      },
      timeoutMs: 0,
    });
    const result = await runnerClient.run({
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'run',
      roomId: plan.roomId,
      turnId: plan.turnId,
      sessionId: null,
      prompt: plan.prompt,
      mode: plan.config.mode,
      provider: plan.selectedModel.provider,
      modelId: plan.selectedModel.id,
      apiModel: plan.selectedModel.apiModel,
      workspace: handle.workspace,
      allowedPaths: plan.config.allowedPaths,
      images: plan.imageUrl ? [{ url: plan.imageUrl }] : undefined,
    }, {
      onEvent: async event => {
        logger.info('Codex smoke runner event', { type: event.type });
      },
    }, {
      process: runnerProcess,
      sandbox: handle,
    });

    if (result.errorEvent) {
      throw new Error(`Codex E2B smoke runner error: ${result.errorEvent.message}`);
    }
    if (!result.finalEvent) {
      throw new Error('Codex E2B smoke did not produce a final event');
    }
    if (plan.expectedText && !result.finalEvent.answer.includes(plan.expectedText)) {
      throw new Error(`Codex E2B smoke final answer did not include expected text: ${plan.expectedText}`);
    }
    const refreshedAuthJson = await sandboxService.readSecretFile(handle, plan.refreshedAuthSecretPath)
      .catch(() => undefined);

    logger.info('Codex E2B smoke passed', {
      sandboxId: handle.id,
      sessionId: result.finalEvent.sessionId,
      refreshedAuthReturned: Boolean(refreshedAuthJson),
      usage: result.finalEvent.usage,
    });
    return {
      ...result,
      refreshedAuthReturned: Boolean(refreshedAuthJson),
    };
  } finally {
    await runnerProcess?.stop().catch(error => {
      logger.warn('Unable to stop Codex E2B smoke runner process', { error });
    });
    await Promise.all([
      sandboxService.deleteSecretFile(handle, plan.authSecretPath),
      sandboxService.deleteSecretFile(handle, plan.refreshedAuthSecretPath),
    ]).catch(error => {
      logger.warn('Unable to delete Codex E2B smoke secret files', { error, sandboxId: handle.id });
    });
    await sandboxService.destroy(handle.id).catch(error => {
      logger.warn('Unable to destroy Codex E2B smoke sandbox', { error, sandboxId: handle.id });
    });
  }
};

const readPrivateAuthJson = async (authJsonPath: string) => {
  const value = await readFile(authJsonPath, 'utf8');
  if (!value.trim()) {
    throw new Error('Codex auth JSON file is empty');
  }
  JSON.parse(value);
  return value;
};

const resolveAuthJsonPath = (env: NodeJS.ProcessEnv): string | undefined => {
  const configured = env.CODEX_E2B_SMOKE_AUTH_JSON_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (!env.HOME) {
    return undefined;
  }
  const defaultPath = path.join(env.HOME, '.codex', 'auth.json');
  return existsSync(defaultPath) ? defaultPath : undefined;
};

const parsePositiveMs = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sanitizePathPart = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '_');

if (require.main === module) {
  dotenv.config();
  const logger = new Logger('CodexE2BSmoke');
  let plan: CodexE2BSmokePlan;
  try {
    plan = buildCodexE2BSmokePlan(process.env);
  } catch (error) {
    logger.error('Codex E2B smoke config failed', { error });
    process.stderr.write(`Codex E2B smoke config failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!plan.run) {
    logger.warn('Codex E2B smoke skipped', { reason: plan.reason });
    process.stdout.write(`Codex E2B smoke skipped: ${plan.reason}\n`);
    process.exit(0);
  }
  runCodexE2BSmoke(plan, logger)
    .then(() => process.exit(0))
    .catch(error => {
      logger.error('Codex E2B smoke failed', { error });
      process.stderr.write(`Codex E2B smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
