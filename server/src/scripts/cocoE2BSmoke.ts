import { Logger } from '../logger';
import dotenv from 'dotenv';
import { AIModelOption } from '../types';
import { DEFAULT_AI_MODEL_ID, createAIModelRegistry } from '../services/aiModels';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION } from '../services/codeAgentRunnerProtocol';
import { JsonlCodeAgentRunnerClient } from '../services/jsonlCodeAgentRunner';
import { resolveCodeAgentRuntimeConfig, CodeAgentRuntimeConfig } from '../services/codeAgentRuntimeConfig';
import { E2BCocoSandboxService } from '../services/e2bCocoSandboxService';
import { createE2BSdkDriver } from '../services/e2bSdkDriver';

const DEFAULT_SMOKE_PROMPT = 'Reply with a short confirmation that RoomTalk Coco E2B smoke is working. Do not modify files.';
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_TTL_MS = 10 * 60 * 1000;

type CocoE2BSmokePlan =
  | { run: false; reason: string }
  | {
    run: true;
    config: CodeAgentRuntimeConfig;
    e2bTemplateId: string;
    selectedModel: AIModelOption;
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

export const buildCocoE2BSmokePlan = (env: NodeJS.ProcessEnv): CocoE2BSmokePlan => {
  if (env.RUN_COCO_E2B_SMOKE !== 'true') {
    return { run: false, reason: 'RUN_COCO_E2B_SMOKE is not true' };
  }
  if (!env.COCO_E2B_TEMPLATE_ID) {
    return { run: false, reason: 'COCO_E2B_TEMPLATE_ID is not set' };
  }
  if (!env.E2B_API_KEY && !env.E2B_ACCESS_TOKEN) {
    return { run: false, reason: 'E2B_API_KEY or E2B_ACCESS_TOKEN is not set' };
  }

  const smokeEnv = {
    ...env,
    COCO_ENABLED: 'true',
    COCO_SANDBOX_PROVIDER: 'e2b',
    COCO_RUNNER_CLIENT: 'jsonl',
    COCO_MODE: env.COCO_MODE || 'plan',
  };
  const config = resolveCodeAgentRuntimeConfig(smokeEnv);
  const registry = createAIModelRegistry({
    defaultModelId: env.AI_MODEL || env.OPENROUTER_MODEL || DEFAULT_AI_MODEL_ID,
  });
  const selectedModel = registry.normalizeAIModel(env.COCO_SMOKE_MODEL);
  const providerEnv = config.runnerProviderEnvByProvider[selectedModel.provider] || {};
  const e2bTemplateId = config.e2bTemplateId;
  if (!e2bTemplateId) {
    return { run: false, reason: 'COCO_E2B_TEMPLATE_ID is not set' };
  }
  const runnerEnv = {
    PYTHONUNBUFFERED: '1',
    ...config.runnerEnv,
    ...providerEnv,
  };

  if (!hasRunnerModelAccess(smokeEnv, runnerEnv, selectedModel)) {
    return {
      run: false,
      reason: `No model access configured for ${selectedModel.provider}; set proxy/scoped-key env or the provider API key`,
    };
  }

  const suffix = Date.now().toString(36);
  return {
    run: true,
    config,
    e2bTemplateId,
    selectedModel,
    runnerEnv,
    roomId: env.COCO_SMOKE_ROOM_ID || `coco-e2b-smoke-${suffix}`,
    turnId: env.COCO_SMOKE_TURN_ID || `turn-${suffix}`,
    prompt: env.COCO_SMOKE_PROMPT || DEFAULT_SMOKE_PROMPT,
    expectedText: env.COCO_SMOKE_EXPECTED,
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

export const runCocoE2BSmoke = async (plan: Extract<CocoE2BSmokePlan, { run: true }>, logger = new Logger('CocoE2BSmoke')) => {
  const sandboxService = new E2BCocoSandboxService(createE2BSdkDriver({
    apiKey: plan.e2bConnection.apiKey,
    accessToken: plan.e2bConnection.accessToken,
    domain: plan.e2bConnection.domain,
    apiUrl: plan.e2bConnection.apiUrl,
    sandboxUrl: plan.e2bConnection.sandboxUrl,
    requestTimeoutMs: plan.e2bConnection.requestTimeoutMs,
  }), {
    templateId: plan.e2bTemplateId,
    workspace: plan.config.e2bWorkspace,
    artifactVersion: plan.config.artifactVersion,
    cocoSourceRef: plan.config.cocoSourceRef,
    lifecycle: plan.config.e2bLifecycle,
    logger,
  });
  const runnerClient = new JsonlCodeAgentRunnerClient();
  const handle = await sandboxService.create({
    roomId: plan.roomId,
    creatorId: 'coco-e2b-smoke',
    ttlMs: plan.sandboxTtlMs,
  });
  let runnerProcess: Awaited<ReturnType<E2BCocoSandboxService['startRunner']>> | undefined;

  try {
    logger.info('Created E2B Coco smoke sandbox', { sandboxId: handle.id, roomId: plan.roomId });
    runnerProcess = await sandboxService.startRunner({
      handle,
      command: plan.config.runnerCommand,
      env: plan.runnerEnv,
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
        logger.info('Coco smoke runner event', { type: event.type });
      },
    }, {
      process: runnerProcess,
      sandbox: handle,
    });

    if (result.errorEvent) {
      throw new Error(`Coco E2B smoke runner error: ${result.errorEvent.message}`);
    }
    if (!result.finalEvent) {
      throw new Error('Coco E2B smoke did not produce a final event');
    }
    if (plan.expectedText && !result.finalEvent.answer.includes(plan.expectedText)) {
      throw new Error(`Coco E2B smoke final answer did not include expected text: ${plan.expectedText}`);
    }

    logger.info('Coco E2B smoke passed', {
      sandboxId: handle.id,
      model: plan.selectedModel.id,
      sessionId: result.finalEvent.sessionId,
    });
    return result;
  } finally {
    await runnerProcess?.stop().catch(error => {
      logger.warn('Unable to stop Coco E2B smoke runner process', { error });
    });
    await sandboxService.destroy(handle.id).catch(error => {
      logger.warn('Unable to destroy Coco E2B smoke sandbox', { error, sandboxId: handle.id });
    });
  }
};

const hasRunnerModelAccess = (
  env: NodeJS.ProcessEnv,
  runnerEnv: Record<string, string>,
  selectedModel: AIModelOption
) => {
  if (runnerEnv.COCO_MODEL_PROXY_URL && runnerEnv.COCO_MODEL_PROXY_TOKEN) {
    return true;
  }
  if (env.COCO_SCOPED_PROVIDER_KEY === 'true') {
    return true;
  }
  return providerKeyEnvFor(selectedModel.provider).some(name => Boolean(runnerEnv[name]));
};

const providerKeyEnvFor = (provider: AIModelOption['provider']) => {
  switch (provider) {
    case 'anthropic':
      return ['ANTHROPIC_API_KEY'];
    case 'deepseek':
      return ['DEEPSEEK_API_KEY'];
    case 'openai':
      return ['OPENAI_API_KEY'];
    case 'openrouter':
      return ['OPENROUTER_API_KEY'];
    default:
      return [];
  }
};

const parsePositiveMs = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

if (require.main === module) {
  dotenv.config();
  const logger = new Logger('CocoE2BSmoke');
  let plan: CocoE2BSmokePlan;
  try {
    plan = buildCocoE2BSmokePlan(process.env);
  } catch (error) {
    logger.error('Coco E2B smoke config failed', { error });
    process.stderr.write(`Coco E2B smoke config failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!plan.run) {
    logger.warn('Coco E2B smoke skipped', { reason: plan.reason });
    process.stdout.write(`Coco E2B smoke skipped: ${plan.reason}\n`);
    process.exit(0);
  }
  runCocoE2BSmoke(plan, logger)
    .then(() => process.exit(0))
    .catch(error => {
      logger.error('Coco E2B smoke failed', { error });
      process.stderr.write(`Coco E2B smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
