import { Logger } from '../logger';
import dotenv from 'dotenv';
import { AIModelOption } from '../types';
import { DEFAULT_AI_MODEL_ID, createAIModelRegistry } from '../services/aiModels';
import { CODE_AGENT_RUNNER_SCHEMA_VERSION } from '../services/codeAgentRunnerProtocol';
import { JsonlCodeAgentRunnerClient } from '../services/jsonlCodeAgentRunner';
import { resolveCodeAgentRuntimeConfig, CodeAgentRuntimeConfig } from '../services/codeAgentRuntimeConfig';
import { E2BCodeAgentSandboxService } from '../services/e2bCodeAgentSandboxService';
import { createE2BSdkDriver } from '../services/e2bSdkDriver';

const DEFAULT_SMOKE_PROMPT = 'Reply with a short confirmation that RoomTalk Code Agent E2B smoke is working. Do not modify files.';
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_TTL_MS = 10 * 60 * 1000;

type CodeAgentE2BSmokePlan =
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

export const buildCodeAgentE2BSmokePlan = (env: NodeJS.ProcessEnv): CodeAgentE2BSmokePlan => {
  if (env.RUN_CODE_AGENT_E2B_SMOKE !== 'true') {
    return { run: false, reason: 'RUN_CODE_AGENT_E2B_SMOKE is not true' };
  }
  if (!env.CODE_AGENT_E2B_TEMPLATE_ID) {
    return { run: false, reason: 'CODE_AGENT_E2B_TEMPLATE_ID is not set' };
  }
  if (!env.E2B_API_KEY && !env.E2B_ACCESS_TOKEN) {
    return { run: false, reason: 'E2B_API_KEY or E2B_ACCESS_TOKEN is not set' };
  }

  const smokeEnv = {
    ...env,
    CODE_AGENT_ENABLED: 'true',
    CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
    CODE_AGENT_RUNNER_CLIENT: 'jsonl',
    CODE_AGENT_MODE: env.CODE_AGENT_MODE || 'plan',
  };
  const config = resolveCodeAgentRuntimeConfig(smokeEnv);
  const registry = createAIModelRegistry({
    defaultModelId: env.AI_MODEL || env.OPENROUTER_MODEL || DEFAULT_AI_MODEL_ID,
  });
  const selectedModel = registry.normalizeAIModel(env.CODE_AGENT_SMOKE_MODEL);
  const providerEnv = config.runnerProviderEnvByProvider[selectedModel.provider] || {};
  const e2bTemplateId = config.e2bTemplateId;
  if (!e2bTemplateId) {
    return { run: false, reason: 'CODE_AGENT_E2B_TEMPLATE_ID is not set' };
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
    roomId: env.CODE_AGENT_SMOKE_ROOM_ID || `code-agent-e2b-smoke-${suffix}`,
    turnId: env.CODE_AGENT_SMOKE_TURN_ID || `turn-${suffix}`,
    prompt: env.CODE_AGENT_SMOKE_PROMPT || DEFAULT_SMOKE_PROMPT,
    expectedText: env.CODE_AGENT_SMOKE_EXPECTED,
    turnTimeoutMs: parsePositiveMs(env.CODE_AGENT_TURN_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS),
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

export const runCodeAgentE2BSmoke = async (plan: Extract<CodeAgentE2BSmokePlan, { run: true }>, logger = new Logger('CodeAgentE2BSmoke')) => {
  const sandboxService = new E2BCodeAgentSandboxService(createE2BSdkDriver({
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
    codeAgentSourceRef: plan.config.codeAgentSourceRef,
    lifecycle: plan.config.e2bLifecycle,
    logger,
  });
  const runnerClient = new JsonlCodeAgentRunnerClient();
  const handle = await sandboxService.create({
    roomId: plan.roomId,
    creatorId: 'code-agent-e2b-smoke',
    ttlMs: plan.sandboxTtlMs,
  });
  let runnerProcess: Awaited<ReturnType<E2BCodeAgentSandboxService['startRunner']>> | undefined;

  try {
    logger.info('Created E2B code-agent smoke sandbox', { sandboxId: handle.id, roomId: plan.roomId });
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
        logger.info('code-agent smoke runner event', { type: event.type });
      },
    }, {
      process: runnerProcess,
      sandbox: handle,
    });

    if (result.errorEvent) {
      throw new Error(`code-agent E2B smoke runner error: ${result.errorEvent.message}`);
    }
    if (!result.finalEvent) {
      throw new Error('code-agent E2B smoke did not produce a final event');
    }
    if (plan.expectedText && !result.finalEvent.answer.includes(plan.expectedText)) {
      throw new Error(`code-agent E2B smoke final answer did not include expected text: ${plan.expectedText}`);
    }

    logger.info('code-agent E2B smoke passed', {
      sandboxId: handle.id,
      model: plan.selectedModel.id,
      sessionId: result.finalEvent.sessionId,
    });
    return result;
  } finally {
    await runnerProcess?.stop().catch(error => {
      logger.warn('Unable to stop code-agent E2B smoke runner process', { error });
    });
    await sandboxService.destroy(handle.id).catch(error => {
      logger.warn('Unable to destroy code-agent E2B smoke sandbox', { error, sandboxId: handle.id });
    });
  }
};

const hasRunnerModelAccess = (
  env: NodeJS.ProcessEnv,
  runnerEnv: Record<string, string>,
  selectedModel: AIModelOption
) => {
  if (runnerEnv.CODE_AGENT_MODEL_PROXY_URL && runnerEnv.CODE_AGENT_MODEL_PROXY_TOKEN) {
    return true;
  }
  if (env.CODE_AGENT_SCOPED_PROVIDER_KEY === 'true') {
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
  const logger = new Logger('CodeAgentE2BSmoke');
  let plan: CodeAgentE2BSmokePlan;
  try {
    plan = buildCodeAgentE2BSmokePlan(process.env);
  } catch (error) {
    logger.error('code-agent E2B smoke config failed', { error });
    process.stderr.write(`code-agent E2B smoke config failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!plan.run) {
    logger.warn('code-agent E2B smoke skipped', { reason: plan.reason });
    process.stdout.write(`code-agent E2B smoke skipped: ${plan.reason}\n`);
    process.exit(0);
  }
  runCodeAgentE2BSmoke(plan, logger)
    .then(() => process.exit(0))
    .catch(error => {
      logger.error('code-agent E2B smoke failed', { error });
      process.stderr.write(`code-agent E2B smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
