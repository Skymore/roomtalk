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
import { E2BCocoSandboxService } from '../services/e2bCocoSandboxService';
import { createE2BSdkDriver } from '../services/e2bSdkDriver';
import { JsonlCodeAgentRunnerClient } from '../services/jsonlCodeAgentRunner';

const DEFAULT_SMOKE_PROMPT = 'Reply exactly: codex e2b smoke ok';
const DEFAULT_TURN_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_SANDBOX_TTL_MS = 10 * 60 * 1000;

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
    expectedText?: string;
    turnTimeoutMs: number;
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
  if (!env.COCO_E2B_TEMPLATE_ID) {
    return { run: false, reason: 'COCO_E2B_TEMPLATE_ID is not set' };
  }
  if (!env.E2B_API_KEY && !env.E2B_ACCESS_TOKEN) {
    return { run: false, reason: 'E2B_API_KEY or E2B_ACCESS_TOKEN is not set' };
  }

  const authJsonPath = resolveAuthJsonPath(env);
  if (!authJsonPath) {
    return { run: false, reason: 'CODEX_E2B_SMOKE_AUTH_JSON_PATH is not set and ~/.codex/auth.json is unavailable' };
  }

  const smokeEnv = {
    ...env,
    COCO_ENABLED: 'true',
    COCO_SANDBOX_PROVIDER: 'e2b',
    COCO_RUNNER_CLIENT: 'jsonl',
    CODE_AGENT_BACKEND: 'codex',
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
      ROOMTALK_CODEX_TIMEOUT_MS: String(codexCli.timeoutMs),
    },
    roomId: env.CODEX_E2B_SMOKE_ROOM_ID || `codex-e2b-smoke-${suffix}`,
    turnId,
    prompt: env.CODEX_E2B_SMOKE_PROMPT || DEFAULT_SMOKE_PROMPT,
    expectedText: env.CODEX_E2B_SMOKE_EXPECTED || 'codex e2b smoke ok',
    turnTimeoutMs: parsePositiveMs(env.COCO_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS),
    sandboxTtlMs: parsePositiveMs(env.COCO_SANDBOX_TTL_MS, DEFAULT_SANDBOX_TTL_MS),
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

export const runCodexE2BSmoke = async (
  plan: Extract<CodexE2BSmokePlan, { run: true }>,
  logger = new Logger('CodexE2BSmoke')
) => {
  const sandboxService = new E2BCocoSandboxService(createE2BSdkDriver({
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
    cocoSourceRef: plan.config.cocoSourceRef,
    lifecycle: plan.config.e2bLifecycle,
    logger,
  });
  const runnerClient = new JsonlCodeAgentRunnerClient();
  const handle = await sandboxService.create({
    roomId: plan.roomId,
    creatorId: 'codex-e2b-smoke',
    ttlMs: plan.sandboxTtlMs,
  });
  let runnerProcess: Awaited<ReturnType<E2BCocoSandboxService['startRunner']>> | undefined;

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
      timeoutMs: plan.turnTimeoutMs,
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
