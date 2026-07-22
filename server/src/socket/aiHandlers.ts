import { v4 as uuidv4 } from 'uuid';
import type { AssistantRunClaim, AssistantRunProjectionResult, AssistantRunTerminalPayloadV1, RoomStore } from '../repositories/store';
import { MAX_CONTEXT_MESSAGES, MAX_CONTEXT_TOKENS, normalizeAIContextMessageLimit, selectAIHistory } from '../services/aiHistory';
import { calculateAICost, DEFAULT_SYSTEM_MESSAGE, getMessageAIModel, normalizeUsage } from '../services/aiModels';
import { mergeA2UIPayloads, normalizeA2UIPayload } from '../services/a2uiPayload';
import {
  A2UI_TOOL_NAME,
  MAX_A2UI_TOOL_ROUNDS,
  anthropicA2UITool,
  buildA2UIFollowUpMessageContent,
  buildA2UIToolSystemPrompt,
  isA2UIFollowUpAction,
  normalizeA2UIToolArguments,
  openAIA2UITool,
} from '../services/a2uiTools';
import {
  buildAIProviderMessages,
  buildAnthropicMessages,
  createAIPlaceholderMessage,
  createReplyReference,
  createUserMessage,
} from '../services/messageDomain';
import { notifyRoomMessageBestEffort } from '../services/pushNotifications';
import { CODE_AGENT_ACCESS_DENIED_MESSAGE } from '../services/codeAgentRoomAccess';
import { normalizeCodexRunSettings } from '../services/codexRunSettings';
import type { CodeAgentRunnerMode } from '../services/codeAgentRunnerProtocol';
import type { CodeAgentTurnInput } from '../services/codeAgentSessionService';
import type { A2UIActionEvent, AIModelOption, CodexPermissionMode, CodexReasoningEffort, CodexServiceTier, Message } from '../types';
import type { AssistantRunExecutionContext } from '../services/assistantRunExecution';
import { buildE2EFakeA2UIBatches } from '../services/e2eFakeA2UI';
import type { AssistantRunEventPublisher } from '../services/assistantRunEvents';
import { hasRoomAccess } from './roomAccess';
import { authorizeRoomAction, buildRoomPermissions, getRoomMessage } from './roomAuthorization';
import { SocketConnectionContext, SocketHandlerDeps } from './types';

// Upper bound on the AI response length (Anthropic). Raised from 8096 to reduce
// mid-response truncation; only billed for tokens actually generated. Override
// with ANTHROPIC_MAX_TOKENS in prod without a code change.
export const DEFAULT_ANTHROPIC_MAX_TOKENS = (() => {
  const parsed = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32000;
})();
const isE2EFakeAIEnabled = () =>
  process.env.E2E_TEST_MODE === 'true' && process.env.E2E_FAKE_AI === 'true';

const getE2EFakeAIChunkDelayMs = () => {
  const delayMs = Number.parseInt(process.env.E2E_FAKE_AI_CHUNK_DELAY_MS || '5', 10);
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5;
};

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

const appendAIErrorNotice = (content: string, notice: string) => (
  content.trim().length > 0 ? `${content}\n\n${notice}` : notice
);

const firstHeaderValue = (value: string | string[] | undefined) => (
  Array.isArray(value) ? value[0] : value
);

const getSocketOrigin = (socket: SocketConnectionContext['socket']) => (
  firstHeaderValue(socket.handshake?.headers?.origin)
);

const getSocketServerOrigin = (socket: SocketConnectionContext['socket']) => {
  const headers = socket.handshake?.headers || {};
  const forwardedProto = firstHeaderValue(headers['x-forwarded-proto'])?.split(',')[0]?.trim();
  const forwardedHost = firstHeaderValue(headers['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || firstHeaderValue(headers.host);
  if (!host) {
    return undefined;
  }
  const proto = forwardedProto || ((process.env.NODE_ENV || 'development') === 'production' ? 'https' : 'http');
  return `${proto}://${host}`;
};

const getCodeAgentTurnOriginInput = (socket: SocketConnectionContext['socket']) => {
  const clientOrigin = getSocketOrigin(socket);
  const serverOrigin = getSocketServerOrigin(socket);
  return {
    ...(clientOrigin ? { clientOrigin } : {}),
    ...(serverOrigin ? { serverOrigin } : {}),
  };
};

const buildCodeAgentTurnInput = ({
  roomId,
  clientId,
  selectedModel,
  codexModel,
  codexReasoningEffort,
  codexPermissionMode,
  codexServiceTier,
  maxContextMessages,
  socket,
  requestedMode,
  promptMessage,
}: {
  roomId: string;
  clientId: string;
  selectedModel: AIModelOption;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  codexServiceTier?: CodexServiceTier;
  maxContextMessages?: number;
  socket: SocketConnectionContext['socket'];
  requestedMode?: CodeAgentRunnerMode;
  promptMessage?: Message;
}): CodeAgentTurnInput => ({
  roomId,
  clientId,
  selectedModel,
  ...((codexModel || codexReasoningEffort || codexPermissionMode || codexServiceTier)
    ? { codexRunSettings: normalizeCodexRunSettings(codexModel, codexReasoningEffort, codexPermissionMode, codexServiceTier) }
    : {}),
  maxContextMessages,
  ...getCodeAgentTurnOriginInput(socket),
  ...(requestedMode ? { requestedMode, requestedModeSource: 'originalTurn' as const } : {}),
  ...(promptMessage ? { promptMessage, promptMessageId: promptMessage.id } : {}),
});

const isPrematureCloseError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /premature close/i.test(message);
};

type ReportedUsage = Record<string, any> | null;
type EmitA2UIUpdate = (messages: unknown[]) => Promise<boolean>;

type StreamAIResult = {
  fullContent: string;
  reportedUsage: ReportedUsage;
  usageMessages: Array<{ content: any }>;
};

class PartialAIStreamError extends Error {
  result: StreamAIResult;

  constructor(error: unknown, result: StreamAIResult) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'PartialAIStreamError';
    this.result = result;
    (this as any).cause = error;
  }
}

const getPartialAIStreamResult = (error: unknown): StreamAIResult | null => (
  error instanceof PartialAIStreamError ? error.result : null
);

const addReportedUsage = (current: ReportedUsage, next: any): ReportedUsage => {
  if (!next || typeof next !== 'object') return current;
  if (!current) return { ...next };

  const summed = { ...current };
  [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ].forEach((key) => {
    if (typeof next[key] === 'number') {
      summed[key] = (typeof summed[key] === 'number' ? summed[key] : 0) + next[key];
    }
  });

  const cachedTokens = next.prompt_tokens_details?.cached_tokens;
  if (typeof cachedTokens === 'number') {
    summed.prompt_tokens_details = {
      ...(summed.prompt_tokens_details || {}),
      cached_tokens: (summed.prompt_tokens_details?.cached_tokens || 0) + cachedTokens,
    };
  }

  return summed;
};

const streamOpenAICompatibleWithA2UI = async (params: {
  client: any;
  model: string;
  messages: any[];
  emitA2UIUpdate: EmitA2UIUpdate;
  emitTextChunk: (chunk: string) => void;
  logger: { warn(message: string, meta?: unknown): void; debug(message: string, meta?: unknown): void };
  messageId: string;
  signal?: AbortSignal;
}): Promise<StreamAIResult> => {
  const providerMessages = [...params.messages];
  let fullContent = '';
  let reportedUsage: ReportedUsage = null;

  try {
    for (let round = 0; round < MAX_A2UI_TOOL_ROUNDS; round++) {
      params.signal?.throwIfAborted();
      let roundContent = '';
      const toolCalls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
      const stream = await params.client.chat.completions.create({
        model: params.model,
        messages: providerMessages,
        stream: true,
        temperature: 1,
        tools: [openAIA2UITool],
        tool_choice: 'auto',
        stream_options: { include_usage: true },
      } as any, params.signal ? { signal: params.signal } : undefined);

      for await (const chunk of stream as any) {
        params.signal?.throwIfAborted();
        if (chunk.usage) {
          reportedUsage = addReportedUsage(reportedUsage, chunk.usage);
        }

        const choice = chunk.choices?.[0];
        const contentChunk = choice?.delta?.content;
        if (typeof contentChunk === 'string' && contentChunk.length > 0) {
          fullContent += contentChunk;
          roundContent += contentChunk;
          params.emitTextChunk(contentChunk);
          if (fullContent.length % 100 === 0) {
            params.logger.debug('Streaming AI chunk', { messageId: params.messageId, contentLength: fullContent.length });
          }
        }

        for (const delta of choice?.delta?.tool_calls || []) {
          const index = typeof delta.index === 'number' ? delta.index : toolCalls.size;
          const current = toolCalls.get(index) || {
            id: delta.id || `a2ui_tool_${round}_${index}`,
            type: delta.type || 'function',
            function: { name: '', arguments: '' },
          };
          if (delta.id) current.id = delta.id;
          if (delta.type) current.type = delta.type;
          if (delta.function?.name) current.function.name += delta.function.name;
          if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
          toolCalls.set(index, current);
        }
      }

      if (toolCalls.size === 0) {
        break;
      }

      const assistantToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => toolCall);
      const toolMessages: any[] = [];

      for (const toolCall of assistantToolCalls) {
        params.signal?.throwIfAborted();
        if (toolCall.function.name !== A2UI_TOOL_NAME) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: 'Unsupported tool' }),
          });
          continue;
        }

        const uiPayload = await normalizeA2UIToolArguments(toolCall.function.arguments);
        const rendered = uiPayload ? await params.emitA2UIUpdate(uiPayload.messages) : false;
        if (!rendered) {
          params.logger.warn('AI provider emitted invalid A2UI tool arguments', {
            messageId: params.messageId,
            toolCallId: toolCall.id,
          });
        }
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: rendered }),
        });
      }

      providerMessages.push({
        role: 'assistant',
        content: roundContent || null,
        tool_calls: assistantToolCalls,
      });
      providerMessages.push(...toolMessages);

      if (round === MAX_A2UI_TOOL_ROUNDS - 1) {
        params.logger.warn('Reached maximum A2UI tool rounds for OpenAI-compatible stream', {
          messageId: params.messageId,
          maxRounds: MAX_A2UI_TOOL_ROUNDS,
        });
        break;
      }
    }
  } catch (error) {
    if (params.signal?.aborted) {
      params.signal.throwIfAborted();
    }
    if (fullContent.trim().length > 0 || reportedUsage) {
      throw new PartialAIStreamError(error, {
        fullContent,
        reportedUsage,
        usageMessages: providerMessages,
      });
    }

    throw error;
  }

  return {
    fullContent,
    reportedUsage,
    usageMessages: providerMessages,
  };
};

const streamAnthropicWithA2UI = async (params: {
  client: any;
  model: string;
  systemPrompt: string;
  messages: any[];
  emitA2UIUpdate: EmitA2UIUpdate;
  emitTextChunk: (chunk: string) => void;
  logger: { warn(message: string, meta?: unknown): void };
  messageId: string;
  signal?: AbortSignal;
}): Promise<StreamAIResult> => {
  const providerMessages = [...params.messages];
  let fullContent = '';
  let reportedUsage: ReportedUsage = null;

  try {
    for (let round = 0; round < MAX_A2UI_TOOL_ROUNDS; round++) {
      params.signal?.throwIfAborted();
      const stream = params.client.messages.stream({
        model: params.model,
        max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
        system: [{ type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: providerMessages,
        tools: [anthropicA2UITool],
      } as any, params.signal ? { signal: params.signal } : undefined);

      for await (const event of stream as any) {
        params.signal?.throwIfAborted();
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const contentChunk: string = event.delta.text;
          fullContent += contentChunk;
          params.emitTextChunk(contentChunk);
        }
      }

      const finalMsg = await stream.finalMessage();
      reportedUsage = addReportedUsage(reportedUsage, finalMsg.usage);
      const assistantContent = Array.isArray(finalMsg.content) ? finalMsg.content : [];
      const toolUses = assistantContent.filter((block: any) => block?.type === 'tool_use');

      if (toolUses.length === 0) {
        break;
      }

      const toolResults: any[] = [];
      for (const toolUse of toolUses) {
        params.signal?.throwIfAborted();
        if (toolUse.name !== A2UI_TOOL_NAME) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ ok: false, error: 'Unsupported tool' }),
          });
          continue;
        }

        const uiPayload = await normalizeA2UIToolArguments(toolUse.input);
        const rendered = uiPayload ? await params.emitA2UIUpdate(uiPayload.messages) : false;
        if (!rendered) {
          params.logger.warn('Anthropic emitted invalid A2UI tool arguments', {
            messageId: params.messageId,
            toolUseId: toolUse.id,
          });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ ok: rendered }),
        });
      }

      providerMessages.push({ role: 'assistant', content: assistantContent });
      providerMessages.push({ role: 'user', content: toolResults });

      if (round === MAX_A2UI_TOOL_ROUNDS - 1) {
        params.logger.warn('Reached maximum A2UI tool rounds for Anthropic stream', {
          messageId: params.messageId,
          maxRounds: MAX_A2UI_TOOL_ROUNDS,
        });
        break;
      }
    }
  } catch (error) {
    if (params.signal?.aborted) params.signal.throwIfAborted();
    if (fullContent.trim().length > 0 || reportedUsage) {
      throw new PartialAIStreamError(error, {
        fullContent,
        reportedUsage,
        usageMessages: providerMessages,
      });
    }
    throw error;
  }

  return {
    fullContent,
    reportedUsage,
    usageMessages: providerMessages,
  };
};

type AIRequestData = {
  roomId: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  codexModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  codexServiceTier?: CodexServiceTier;
  userMessageId?: string;
  editedMessageId?: string;
  retryForMessageId?: string;
  maxContextMessages?: number;
  codeAgentMode?: CodeAgentRunnerMode;
};

type EditMessageAndAskAIData = AIRequestData & {
  messageId: string;
  newContent: string;
};

type SendMessageAndAskAIData = AIRequestData & {
  content: string;
  messageType?: 'text';
  username?: string;
  avatar?: {
    text: string;
    color: string;
  };
  replyToMessageId?: string;
  clientMessageId?: string;
  imageMessageIds?: string[];
};

const readCodeAgentImageMessageIds = async (
  store: RoomStore,
  roomId: string,
  clientId: string,
  value: unknown,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> => {
  if (value === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.length > 9 || value.some(id => typeof id !== 'string' || !id.trim())) {
    return { ok: false, error: 'Agent image attachments must contain at most 9 message IDs' };
  }
  const ids = [...new Set(value.map(id => id.trim()))];
  if (ids.length !== value.length) {
    return { ok: false, error: 'Agent image attachments must be unique' };
  }
  const messagesById = new Map(
    (await store.readMessagesByRoom(roomId)).map(message => [message.id, message]),
  );
  for (const id of ids) {
    const message = messagesById.get(id);
    if (
      !message
      || message.clientId !== clientId
      || message.messageType !== 'media'
      || message.mediaAsset?.kind !== 'image'
    ) {
      return { ok: false, error: 'Agent image attachment is unavailable' };
    }
  }
  return { ok: true, ids };
};

const findNextCodeAgentTurnMode = (messages: Message[], messageId: string): CodeAgentRunnerMode | undefined => {
  const index = messages.findIndex(message => message.id === messageId);
  if (index === -1) return undefined;
  return messages
    .slice(index + 1)
    .find(message => message.messageType === 'ai' && message.codeAgentMode)
    ?.codeAgentMode as CodeAgentRunnerMode | undefined;
};

type AIAckCallback = (response: { success: boolean; messageId?: string; error?: string }) => void;
type SendMessageAndAskAIAckCallback = (response: {
  success: boolean;
  userMessage?: Message;
  aiMessageId?: string;
  aiStarted?: boolean;
  aiError?: string;
  error?: string;
}) => void;

const shouldIncludeA2UIDemoTrigger = (roleName: string, systemPrompt: string): boolean => (
  roleName.trim().toLowerCase() === 'a2ui demo'
  || /A2UI streaming demo assistant/i.test(systemPrompt)
);

const buildSystemPromptWithA2UI = (systemPrompt: string, roleName: string) => (
  buildA2UIToolSystemPrompt(systemPrompt, {
    includeDemoTrigger: shouldIncludeA2UIDemoTrigger(roleName, systemPrompt),
  })
);

const emitAssistantRunProjection = async (
  events: AssistantRunEventPublisher,
  projection: AssistantRunProjectionResult,
  stream: { runId: string; generation: number; chunkSeq: number },
): Promise<void> => {
  if (projection.outcome !== 'applied') return;
  await events.emit(
    { kind: 'client', id: projection.room.creatorId },
    'room_updated',
    projection.room as unknown as Record<string, unknown>,
  );
  if (projection.message.status === 'complete') {
    await events.emit({ kind: 'room', id: projection.message.roomId }, 'ai_stream_end', {
      ...stream,
      messageId: projection.message.id,
      roomId: projection.message.roomId,
      content: projection.message.content,
      uiPayload: projection.message.uiPayload,
      aiModel: projection.message.aiModel,
      usage: projection.message.usage,
      cost: projection.message.cost,
      sessionCost: projection.roomCostTotal,
      ...(projection.run.terminalPayload?.metadata?.completedAfterPrematureClose
        ? { completedAfterPrematureClose: true }
        : {}),
    });
    await events.emit(
      { kind: 'room', id: projection.message.roomId },
      'ai_cost_total',
      projection.roomCostTotal as unknown as Record<string, unknown>,
    );
    return;
  }
  await events.emit({ kind: 'room', id: projection.message.roomId }, 'ai_stream_error', {
    ...stream,
    messageId: projection.message.id,
    roomId: projection.message.roomId,
    error: projection.run.terminalPayload?.error || 'The AI response ended with an error.',
    persisted: true,
    message: projection.message,
    partial: Boolean(projection.run.terminalPayload?.metadata?.partial),
  });
  await events.emit(
    { kind: 'room', id: projection.message.roomId },
    'ai_cost_total',
    projection.roomCostTotal as unknown as Record<string, unknown>,
  );
};

export type AssistantRunExecutorDeps = Pick<
  SocketHandlerDeps,
  'socketLogger' | 'openaiLogger' | 'getAIClientForModel'
> & {
  io?: SocketHandlerDeps['io'];
  eventPublisher?: AssistantRunEventPublisher;
  store: Required<Pick<RoomStore,
    'stageAssistantRunTerminal' | 'projectAssistantRunTerminal'
  >>;
};

export const executeAssistantRun = async (
  claim: AssistantRunClaim,
  deps: AssistantRunExecutorDeps,
  execution: AssistantRunExecutionContext,
): Promise<void> => {
  const { store, socketLogger, openaiLogger, getAIClientForModel } = deps;
  const events: AssistantRunEventPublisher = deps.eventPublisher || {
    emit: async (target, event, payload) => {
      if (!deps.io) throw new Error('Assistant run executor has no event publisher');
      deps.io.to(target.id).emit(event, payload);
    },
  };
  const { run, token } = claim;
  let chunkSeq = 0;
  let eventChain = Promise.resolve();
  const nextStreamEvent = () => ({
    runId: run.id,
    generation: token.generation,
    chunkSeq: ++chunkSeq,
  });
  const emitEvent = (
    target: Parameters<AssistantRunEventPublisher['emit']>[0],
    event: Parameters<AssistantRunEventPublisher['emit']>[1],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    eventChain = eventChain
      .then(() => events.emit(target, event, payload))
      .catch(error => {
        openaiLogger.warn('Assistant run transient event delivery failed', {
          error: error instanceof Error ? error.message : String(error),
          event,
          runId: run.id,
          roomId: run.roomId,
          generation: token.generation,
        });
      });
    return eventChain;
  };

  const project = async (): Promise<AssistantRunProjectionResult> => {
    execution.signal.throwIfAborted();
    const projection = await store.projectAssistantRunTerminal(run.id, token);
    if (projection.outcome === 'stale') {
      openaiLogger.info('Discarded assistant run projection after its claim was replaced', {
        runId: run.id,
        roomId: run.roomId,
        generation: token.generation,
      });
      return projection;
    }
    if (projection.outcome === 'obsolete') {
      openaiLogger.info('Cancelled assistant run whose placeholder was deleted or superseded', {
        runId: run.id,
        roomId: run.roomId,
        messageId: run.aiMessageId,
        generation: token.generation,
      });
      return projection;
    }
    await eventChain;
    await emitAssistantRunProjection(events, projection, nextStreamEvent());
    openaiLogger.info('Projected durable assistant run terminal state', {
      runId: run.id,
      roomId: run.roomId,
      messageId: run.aiMessageId,
      status: projection.message.status,
      generation: token.generation,
      attempt: run.attempt,
    });
    return projection;
  };

  if (claim.phase === 'project') {
    await project();
    return;
  }

  const request = run.requestPayload;
  const selectedModel: AIModelOption = request?.model || {
    id: run.modelId,
    apiModel: run.apiModel,
    provider: run.provider,
    label: run.modelId,
    description: 'Unavailable durable model snapshot',
  };
  const roleName = request?.roleName || run.roleName || 'AI Assistant';
  const initialAiMessage = createAIPlaceholderMessage({
    id: run.aiMessageId,
    roomId: run.roomId,
    roleName,
    model: selectedModel,
  });
  const contextMessages = request?.contextMessages;
  let streamedTextContent = '';
  let streamedA2UIPayload: Message['uiPayload'];
  let fallbackUsageMessages: Array<{ content: any }> = [];

  const stageAndProject = async (terminal: AssistantRunTerminalPayloadV1): Promise<void> => {
    execution.signal.throwIfAborted();
    const staged = await store.stageAssistantRunTerminal(run.id, token, terminal);
    if (!staged) {
      openaiLogger.info('Discarded assistant run terminal result after its claim was replaced', {
        runId: run.id,
        roomId: run.roomId,
        messageId: run.aiMessageId,
        generation: token.generation,
      });
      return;
    }
    await project();
  };

  const terminalError = (
    notice: string,
    metadata: Record<string, unknown> = {},
    accounting?: Pick<Message, 'usage' | 'cost'>,
  ): AssistantRunTerminalPayloadV1 => ({
    schemaVersion: 1,
    outcome: 'error',
    error: notice,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    message: {
      ...initialAiMessage,
      status: 'error',
      isError: true,
      content: appendAIErrorNotice(streamedTextContent, notice),
      timestamp: new Date().toISOString(),
      ...(accounting?.usage ? { usage: accounting.usage } : {}),
      ...(accounting?.cost ? { cost: accounting.cost } : {}),
      ...(streamedA2UIPayload ? { uiPayload: streamedA2UIPayload } : {}),
    },
  });

  if (!contextMessages) {
    await stageAndProject(terminalError('Sorry, this AI request has an invalid durable context snapshot.', {
      invalidRequestPayload: true,
    }));
    return;
  }
  if (run.attempt > execution.maxAttempts) {
    await stageAndProject(terminalError('Sorry, this AI response could not be resumed after repeated worker failures.', {
      attemptsExhausted: true,
      attempt: run.attempt,
    }));
    return;
  }

  const emitTextChunk = (chunk: string) => {
    execution.signal.throwIfAborted();
    streamedTextContent += chunk;
    void emitEvent({ kind: 'room', id: run.roomId }, 'ai_chunk', {
      ...nextStreamEvent(),
      messageId: run.aiMessageId,
      chunk,
      roomId: run.roomId,
    });
  };
  const emitA2UIUpdate = async (messages: unknown[]): Promise<boolean> => {
    execution.signal.throwIfAborted();
    const uiPayload = await normalizeA2UIPayload(messages);
    if (!uiPayload) {
      openaiLogger.warn('Ignoring invalid assistant A2UI stream update', {
        runId: run.id,
        messageId: run.aiMessageId,
        roomId: run.roomId,
      });
      return false;
    }
    streamedA2UIPayload = mergeA2UIPayloads(streamedA2UIPayload, uiPayload);
    await emitEvent({ kind: 'room', id: run.roomId }, 'a2ui_update', {
      ...nextStreamEvent(),
      messageId: run.aiMessageId,
      roomId: run.roomId,
      uiPayload,
    });
    return true;
  };

  let terminal: AssistantRunTerminalPayloadV1;
  try {
    if (isE2EFakeAIEnabled()) {
      const lastUserMessage = [...contextMessages].reverse().find(message => message.clientId !== 'ai_assistant');
      const targetContent = lastUserMessage?.content?.trim() || 'empty prompt';
      const chunks = [
        'E2E AI response: ',
        `I received "${targetContent}". `,
        'The text stream is still moving while the UI surface updates. ',
        'The card below includes live status, checklist items, and an action.',
      ];
      const a2uiBatches = buildE2EFakeA2UIBatches(`summary-${run.aiMessageId}`, targetContent);
      await emitA2UIUpdate(a2uiBatches[0]);
      for (const [index, chunk] of chunks.entries()) {
        await wait(getE2EFakeAIChunkDelayMs());
        emitTextChunk(chunk);
        await emitA2UIUpdate(a2uiBatches[index + 1]);
      }
      const usage = {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 25,
        cacheHitRate: 0.25,
        source: 'reported' as const,
      };
      const cost = calculateAICost(selectedModel, usage);
      terminal = {
        schemaVersion: 1,
        outcome: 'complete',
        message: {
          ...initialAiMessage,
          content: streamedTextContent,
          status: 'complete',
          timestamp: new Date().toISOString(),
          aiModel: getMessageAIModel(selectedModel),
          usage,
          cost,
          ...(streamedA2UIPayload ? { uiPayload: streamedA2UIPayload } : {}),
        },
      };
    } else {
      const systemPromptWithA2UI = buildSystemPromptWithA2UI(
        request ? request.systemPrompt : DEFAULT_SYSTEM_MESSAGE,
        roleName,
      );
      const validMessagesForAPI = buildAIProviderMessages(systemPromptWithA2UI, contextMessages);
      fallbackUsageMessages = validMessagesForAPI;
      const hasConversation = validMessagesForAPI.some(
        message => message.role === 'user' || message.role === 'assistant',
      );
      if (!hasConversation && validMessagesForAPI.length <= 1) {
        terminal = terminalError('Sorry, cannot generate a response without any context or question.');
      } else {
        openaiLogger.debug('Sending durable assistant run to AI provider', {
          runId: run.id,
          roomId: run.roomId,
          messageId: run.aiMessageId,
          generation: token.generation,
          attempt: run.attempt,
          contextLengthUsed: contextMessages.length,
          model: selectedModel.id,
          apiModel: selectedModel.apiModel,
          provider: selectedModel.provider,
        });
        const aiClientWrapper = getAIClientForModel(selectedModel);
        let fullContent = '';
        let reportedUsage: any = null;
        let usageMessages: Array<{ content: any }> = validMessagesForAPI;

        if (aiClientWrapper.provider === 'anthropic') {
          const result = await streamAnthropicWithA2UI({
            client: aiClientWrapper.client,
            model: selectedModel.apiModel,
            systemPrompt: systemPromptWithA2UI,
            messages: buildAnthropicMessages(contextMessages) as any[],
            emitA2UIUpdate,
            emitTextChunk,
            logger: openaiLogger,
            messageId: run.aiMessageId,
            signal: execution.signal,
          });
          fullContent = result.fullContent;
          streamedTextContent = fullContent;
          reportedUsage = result.reportedUsage;
          usageMessages = result.usageMessages;
        } else {
          const result = await streamOpenAICompatibleWithA2UI({
            client: aiClientWrapper.client,
            model: selectedModel.apiModel,
            messages: validMessagesForAPI as any[],
            emitA2UIUpdate,
            emitTextChunk,
            logger: openaiLogger,
            messageId: run.aiMessageId,
            signal: execution.signal,
          });
          fullContent = result.fullContent;
          streamedTextContent = fullContent;
          reportedUsage = result.reportedUsage;
          usageMessages = result.usageMessages;
        }

        execution.signal.throwIfAborted();
        const usage = normalizeUsage(reportedUsage, usageMessages, fullContent);
        const cost = calculateAICost(selectedModel, usage);
        terminal = {
          schemaVersion: 1,
          outcome: 'complete',
          message: {
            ...initialAiMessage,
            content: fullContent,
            status: 'complete',
            timestamp: new Date().toISOString(),
            aiModel: getMessageAIModel(selectedModel),
            usage,
            cost,
            ...(streamedA2UIPayload ? { uiPayload: streamedA2UIPayload } : {}),
          },
        };
      }
    }
  } catch (error) {
    execution.signal.throwIfAborted();
    socketLogger.error('Error processing durable assistant run', {
      error: error instanceof Error ? error.message : error,
      clientId: run.requestedByClientId,
      roomId: run.roomId,
      runId: run.id,
      generation: token.generation,
      attempt: run.attempt,
    });

    const partial = getPartialAIStreamResult(error);
    const partialContent = partial?.fullContent || streamedTextContent;
    streamedTextContent = partialContent;
    const hasPartialContent = partialContent.trim().length > 0;
    if (hasPartialContent && isPrematureCloseError(error)) {
      const usage = normalizeUsage(
        partial?.reportedUsage ?? null,
        partial?.usageMessages ?? fallbackUsageMessages,
        partialContent,
      );
      const cost = calculateAICost(selectedModel, usage);
      terminal = {
        schemaVersion: 1,
        outcome: 'complete',
        metadata: {
          completedAfterPrematureClose: true,
        },
        message: {
          ...initialAiMessage,
          content: partialContent,
          status: 'complete',
          timestamp: new Date().toISOString(),
          aiModel: getMessageAIModel(selectedModel),
          usage,
          cost,
          ...(streamedA2UIPayload ? { uiPayload: streamedA2UIPayload } : {}),
        },
      };
    } else {
      const notice = hasPartialContent
        ? 'The AI response ended before a normal finish. The partial response above was saved.'
        : 'Sorry, an error occurred while generating the AI response.';
      const accounting = hasPartialContent || partial?.reportedUsage
        ? (() => {
            const usage = normalizeUsage(
              partial?.reportedUsage ?? null,
              partial?.usageMessages ?? fallbackUsageMessages,
              partialContent,
            );
            return { usage, cost: calculateAICost(selectedModel, usage) };
          })()
        : undefined;
      terminal = terminalError(notice, {
        partial: hasPartialContent,
        providerError: error instanceof Error ? error.message : String(error),
      }, accounting);
    }
  }

  await stageAndProject(terminal);
};
export function registerAIHandlers({
  io,
  socket,
  store,
  socketLogger,
  openaiLogger,
  normalizeAIModel,
  getAIClientForModel,
  onAssistantRunQueued,
  codeAgentSessionService,
  resolveClientId,
}: SocketConnectionContext) {
  const notifyMessageHistoryInvalidated = (roomId: string, reason: string) => {
    io.to(roomId).emit('message_history_invalidated', { roomId, reason });
  };

  const startChatAIResponse = async (
    data: AIRequestData,
    clientId: string,
    callback?: AIAckCallback,
    preparedHistory?: Message[],
  ) => {
    const { roomId, systemPrompt = DEFAULT_SYSTEM_MESSAGE, roleName = 'AI Assistant', editedMessageId, retryForMessageId } = data;
    const resolvedRoleName = roleName || 'AI Assistant';
    const selectedModel = normalizeAIModel(data.model);
    const aiMessageId = uuidv4();
    const aiRunId = uuidv4();
    socketLogger.info(`Received AI request (history-based)${editedMessageId ? ' after edit ' + editedMessageId : ''}${retryForMessageId ? ' as retry for ' + retryForMessageId : ''}`, {
      socketId: socket.id,
      clientId,
      roomId,
      roleName,
      model: selectedModel.id,
      apiModel: selectedModel.apiModel,
      provider: selectedModel.provider,
    });

    const postAuth = await authorizeRoomAction({
      store,
      roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      callback?.({ success: false, error: postAuth.message });
      return;
    }
    const maxContextMessages = normalizeAIContextMessageLimit(data.maxContextMessages, MAX_CONTEXT_MESSAGES);

    if (retryForMessageId) {
      const retryTarget = await getRoomMessage(store, roomId, retryForMessageId);
      if (!retryTarget) {
        callback?.({ success: false, error: 'Message not found' });
        return;
      }
      const retryAuth = await authorizeRoomAction({
        store,
        roomId,
        clientId,
        action: { type: 'message.delete', message: retryTarget },
      });
      if (!retryAuth.ok) {
        callback?.({ success: false, error: retryAuth.message });
        return;
      }
    }

    if (editedMessageId) {
      const editTarget = await getRoomMessage(store, roomId, editedMessageId);
      if (!editTarget) {
        callback?.({ success: false, error: 'Message not found' });
        return;
      }
      const editAuth = await authorizeRoomAction({
        store,
        roomId,
        clientId,
        action: { type: 'message.edit', message: editTarget },
      });
      if (!editAuth.ok) {
        callback?.({ success: false, error: editAuth.message });
        return;
      }
    }

    let contextMessages: Message[] = [];
    let historyUsedForContext: Message[] = [];

    try {
      if (preparedHistory) {
        historyUsedForContext = preparedHistory;
      } else if (retryForMessageId) {
        const truncation = await store.truncateBeforeMessage(roomId, retryForMessageId);
        if (!truncation) {
          openaiLogger.error('Failed to truncate persistent history before AI retry', { roomId, retryForMessageId });
          io.to(roomId).emit('ai_stream_error', {
            messageId: aiMessageId,
            error: 'Sorry, unable to update message history before generating a response.',
            roomId,
            persisted: false,
          });
          callback?.({ success: false, error: 'Unable to update message history before generating a response' });
          return;
        }

        historyUsedForContext = truncation.messages;
        if (truncation.targetFound) {
          openaiLogger.info('Truncating message history for retry', {
            roomId,
            retryForMessageId,
            newCount: historyUsedForContext.length,
          });
          io.to(truncation.room.creatorId).emit('room_updated', truncation.room);
          notifyMessageHistoryInvalidated(roomId, 'ai-retry-truncated');
        } else {
          openaiLogger.warn('Retry message ID not found in history, using full history', { roomId, retryForMessageId });
        }
      } else if (editedMessageId) {
        const truncation = await store.truncateAfterMessage(roomId, editedMessageId);
        if (!truncation) {
          openaiLogger.error('Failed to truncate persistent history after edit before AI request', { roomId, editedMessageId });
          io.to(roomId).emit('ai_stream_error', {
            messageId: aiMessageId,
            error: 'Sorry, unable to update message history before generating a response.',
            roomId,
            persisted: false,
          });
          callback?.({ success: false, error: 'Unable to update message history before generating a response' });
          return;
        }

        historyUsedForContext = truncation.messages;
        if (truncation.targetFound) {
          openaiLogger.info('Truncating message history after edit', {
            roomId,
            editedMessageId,
            newCount: historyUsedForContext.length,
          });
          io.to(truncation.room.creatorId).emit('room_updated', truncation.room);
          notifyMessageHistoryInvalidated(roomId, 'ai-edit-truncated');
        } else {
          openaiLogger.warn('Edited message ID not found in history, using full history', { roomId, editedMessageId });
        }
      } else {
        historyUsedForContext = (await store.readMessagePageByRoom(roomId, {
          limit: normalizeAIContextMessageLimit(maxContextMessages, MAX_CONTEXT_MESSAGES),
        })).messages;
      }

      const selection = selectAIHistory(historyUsedForContext, {
        maxContextMessages,
        maxContextTokens: MAX_CONTEXT_TOKENS,
      });
      contextMessages = selection.contextMessages;

      if (historyUsedForContext.length === 0) {
        openaiLogger.warn('History for context is empty after processing.', { roomId, editedMessageId, retryForMessageId });
      }

      if (selection.truncationReason === 'max-context') {
        openaiLogger.debug('Applying MAX_CONTEXT limit to determined history', {
          roomId,
          originalCount: historyUsedForContext.length,
          limitedCount: contextMessages.length,
          contextTokenEstimate: selection.contextTokenEstimate,
          maxContextMessages,
          maxContextTokens: MAX_CONTEXT_TOKENS,
        });
      }
    } catch (error) {
      openaiLogger.error('Error loading/processing context messages', { error, roomId });
      callback?.({ success: false, error: 'Unable to load durable AI context' });
      return;
    }

    openaiLogger.debug('contextMessages', contextMessages);

    const initialAiMessage = createAIPlaceholderMessage({
      id: aiMessageId,
      roomId,
      roleName: resolvedRoleName,
      model: selectedModel,
    });
    const now = new Date().toISOString();
    const run = {
      id: aiRunId,
      roomId,
      requestedByClientId: clientId,
      userMessageId: data.userMessageId,
      aiMessageId,
      status: 'queued' as const,
      modelId: selectedModel.id,
      apiModel: selectedModel.apiModel,
      provider: selectedModel.provider,
      roleName: resolvedRoleName,
      systemPrompt,
      maxContextMessages,
      retryForMessageId,
      editedMessageId,
      createdAt: now,
      queuedAt: now,
      updatedAt: now,
      requestPayload: {
        schemaVersion: 1 as const,
        model: selectedModel,
        roleName: resolvedRoleName,
        systemPrompt,
        contextMessages,
      },
      generation: 0,
      attempt: 0,
      availableAt: now,
    };

    if (!store.createAssistantRunWithMessage) {
      openaiLogger.error('Durable assistant run creation is unavailable on store', {
        runId: aiRunId,
        messageId: aiMessageId,
        roomId,
      });
      callback?.({ success: false, error: 'Unable to queue AI response' });
      return;
    }

    const recorded = await store.createAssistantRunWithMessage(initialAiMessage, run);
    if (!recorded) {
      const errorNotice = 'Sorry, unable to queue the AI response.';
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: errorNotice,
        roomId,
        persisted: false,
      });
      callback?.({ success: false, error: 'Unable to queue AI response' });
      return;
    }

    io.to(recorded.room.creatorId).emit('room_updated', recorded.room);
    callback?.({ success: true, messageId: aiMessageId });
    try {
      await onAssistantRunQueued?.();
    } catch (error) {
      openaiLogger.error('Failed to wake assistant run execution after durable queueing', {
        error,
        runId: aiRunId,
        messageId: aiMessageId,
        roomId,
      });
    }
    openaiLogger.info('Queued durable assistant run', {
      runId: aiRunId,
      messageId: aiMessageId,
      roomId,
      model: selectedModel.id,
    });
  };

  socket.on('queue_code_agent_input', async (
    data: SendMessageAndAskAIData,
    callback?: (response: { success: boolean; message?: Message; error?: string }) => void
  ) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }
    if (!data.roomId || typeof data.content !== 'string' || !data.content.trim()) {
      callback?.({ success: false, error: 'Room ID and queued input are required' });
      return;
    }
    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }
    const room = await store.getRoomById(data.roomId);
    if (room?.type !== 'codeAgent') {
      callback?.({ success: false, error: 'Queued inputs are only available in Workspace rooms' });
      return;
    }
    const postAuth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      callback?.({ success: false, error: postAuth.message });
      return;
    }
    const permissions = buildRoomPermissions(postAuth.actor, data.roomId, clientId, postAuth.actor.room);
    if (!permissions.canUseCodeAgent || !codeAgentSessionService) {
      callback?.({ success: false, error: codeAgentSessionService ? CODE_AGENT_ACCESS_DENIED_MESSAGE : 'Workspace is unavailable' });
      return;
    }
    const imageMessageIds = await readCodeAgentImageMessageIds(store, data.roomId, clientId, data.imageMessageIds);
    if (!imageMessageIds.ok) {
      callback?.({ success: false, error: imageMessageIds.error });
      return;
    }

    let replyTo;
    if (data.replyToMessageId) {
      const quotedMessage = await getRoomMessage(store, data.roomId, data.replyToMessageId);
      if (!quotedMessage) {
        callback?.({ success: false, error: 'Quoted message not found' });
        return;
      }
      replyTo = createReplyReference(quotedMessage);
    }
    const message = createUserMessage({
      id: uuidv4(),
      clientId,
      content: data.content.trim(),
      roomId: data.roomId,
      username: data.username,
      avatar: data.avatar,
      replyTo,
      clientMessageId: data.clientMessageId,
    });
    if (imageMessageIds.ids.length > 0) message.codeAgentImageMessageIds = imageMessageIds.ids;
    const codexRunSettings = normalizeCodexRunSettings(
      data.codexModel,
      data.codexReasoningEffort,
      data.codexPermissionMode,
      data.codexServiceTier
    );
    const result = await codeAgentSessionService.queueTurn({
      ...buildCodeAgentTurnInput({
        roomId: data.roomId,
        clientId,
        selectedModel: normalizeAIModel(data.model),
        codexModel: codexRunSettings.model,
        codexReasoningEffort: codexRunSettings.reasoningEffort,
        codexPermissionMode: codexRunSettings.permissionMode,
        codexServiceTier: codexRunSettings.serviceTier,
        maxContextMessages: data.maxContextMessages,
        socket,
        requestedMode: data.codeAgentMode,
      }),
    }, message);
    callback?.(result);
  });

  socket.on('ask_ai', async (data: AIRequestData, callback?: AIAckCallback) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!data.roomId) {
      socket.emit('error', { message: 'Room ID is required for AI request' });
      callback?.({ success: false, error: 'Room ID is required for AI request' });
      return;
    }

    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      socket.emit('error', { message: 'You are not authorized to access this room' });
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const room = await store.getRoomById(data.roomId);
    if (room?.type === 'codeAgent') {
      const postAuth = await authorizeRoomAction({
        store,
        roomId: data.roomId,
        clientId,
        action: { type: 'message.post' },
      });
      if (!postAuth.ok) {
        callback?.({ success: false, error: postAuth.message });
        return;
      }
      const permissions = buildRoomPermissions(postAuth.actor, data.roomId, clientId, postAuth.actor.room);
      if (!permissions.canUseCodeAgent) {
        callback?.({ success: false, error: CODE_AGENT_ACCESS_DENIED_MESSAGE });
        return;
      }

      if (!codeAgentSessionService) {
        socket.emit('error', { message: 'Workspace is unavailable' });
        callback?.({ success: false, error: 'Workspace is unavailable' });
        return;
      }

      let requestedMode: CodeAgentRunnerMode | undefined;
      if (data.retryForMessageId) {
        const retryTarget = await getRoomMessage(store, data.roomId, data.retryForMessageId);
        if (!retryTarget) {
          callback?.({ success: false, error: 'Message not found' });
          return;
        }
        const retryAuth = await authorizeRoomAction({
          store,
          roomId: data.roomId,
          clientId,
          action: { type: 'message.delete', message: retryTarget },
        });
        if (!retryAuth.ok) {
          callback?.({ success: false, error: retryAuth.message });
          return;
        }
        requestedMode = retryTarget.codeAgentMode as CodeAgentRunnerMode | undefined;

        const truncation = await store.truncateBeforeMessage(data.roomId, data.retryForMessageId);
        if (!truncation) {
          callback?.({ success: false, error: 'Unable to update message history before generating a response' });
          return;
        }
        if (truncation.targetFound) {
          io.to(truncation.room.creatorId).emit('room_updated', truncation.room);
          notifyMessageHistoryInvalidated(data.roomId, 'code-agent-retry-truncated');
        }
      }

      await codeAgentSessionService.startTurn(buildCodeAgentTurnInput({
        roomId: data.roomId,
        clientId,
        selectedModel: normalizeAIModel(data.model),
        codexModel: data.codexModel,
        codexReasoningEffort: data.codexReasoningEffort,
        codexPermissionMode: data.codexPermissionMode,
        codexServiceTier: data.codexServiceTier,
        maxContextMessages: data.maxContextMessages,
        socket,
        requestedMode,
      }), callback);
      return;
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      callback?.({ success: false, error: postAuth.message });
      return;
    }

    await startChatAIResponse(data, clientId, callback);
  });

  socket.on('send_message_and_ask_ai', async (
    data: SendMessageAndAskAIData,
    callback?: SendMessageAndAskAIAckCallback,
  ) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!data.roomId) {
      socket.emit('error', { message: 'Room ID is required for AI request' });
      callback?.({ success: false, error: 'Room ID is required for AI request' });
      return;
    }

    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      socket.emit('error', { message: 'You are not authorized to access this room' });
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    if (typeof data.content !== 'string' || !data.content.trim()) {
      callback?.({ success: false, error: 'Message content is required' });
      return;
    }

    const postAuth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.post' },
    });
    if (!postAuth.ok) {
      callback?.({ success: false, error: postAuth.message });
      return;
    }

    const roomForAIRequest = postAuth.actor.room;
    if (roomForAIRequest.type === 'codeAgent') {
      const permissions = buildRoomPermissions(postAuth.actor, data.roomId, clientId, roomForAIRequest);
      if (!permissions.canUseCodeAgent) {
        callback?.({ success: false, error: CODE_AGENT_ACCESS_DENIED_MESSAGE });
        return;
      }
    }
    const imageMessageIds = await readCodeAgentImageMessageIds(
      store,
      data.roomId,
      clientId,
      data.imageMessageIds,
    );
    if (!imageMessageIds.ok) {
      callback?.({ success: false, error: imageMessageIds.error });
      return;
    }

    let roomMessages: Message[] = [];
    let replyTo;
    if (data.replyToMessageId) {
      roomMessages = await store.readMessagesByRoom(data.roomId);
      const quotedMessage = roomMessages.find(message => message.id === data.replyToMessageId);
      if (!quotedMessage) {
        callback?.({ success: false, error: 'Quoted message not found' });
        return;
      }
      replyTo = createReplyReference(quotedMessage);
    }

    const userMessage = createUserMessage({
      id: uuidv4(),
      clientId,
      content: data.content,
      roomId: data.roomId,
      username: data.username,
      avatar: data.avatar,
      replyTo,
      clientMessageId: data.clientMessageId,
    });
    if (imageMessageIds.ids.length > 0) userMessage.codeAgentImageMessageIds = imageMessageIds.ids;

    const updatedRoom = await store.appendMessage(userMessage);
    if (!updatedRoom) {
      socketLogger.error('Failed to append WebSocket message before AI request', {
        messageId: userMessage.id,
        roomId: data.roomId,
        clientId,
      });
      socket.emit('error', { message: 'Failed to save message' });
      callback?.({ success: false, error: 'Failed to save message' });
      return;
    }

    io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
    notifyRoomMessageBestEffort({ store, room: updatedRoom, message: userMessage, logger: socketLogger });

    if (roomForAIRequest?.type === 'codeAgent') {
      if (!codeAgentSessionService) {
        callback?.({
          success: true,
          userMessage,
          aiStarted: false,
          aiError: 'Workspace is unavailable',
        });
        return;
      }

      await codeAgentSessionService.startTurn(buildCodeAgentTurnInput({
        roomId: data.roomId,
        clientId,
        selectedModel: normalizeAIModel(data.model),
        codexModel: data.codexModel,
        codexReasoningEffort: data.codexReasoningEffort,
        codexPermissionMode: data.codexPermissionMode,
        codexServiceTier: data.codexServiceTier,
        maxContextMessages: data.maxContextMessages,
        socket,
        promptMessage: userMessage,
      }), (response) => {
        if (response.success && response.messageId) {
          callback?.({
            success: true,
            userMessage,
            aiMessageId: response.messageId,
            aiStarted: true,
          });
          return;
        }

        callback?.({
          success: true,
          userMessage,
          aiStarted: false,
          aiError: response.error || 'Failed to start agent response',
        });
      });
      return;
    }

    const latestHistory = (await store.readMessagePageByRoom(data.roomId, {
      limit: normalizeAIContextMessageLimit(data.maxContextMessages, MAX_CONTEXT_MESSAGES),
    })).messages;
    const preparedHistory = latestHistory.some(message => message.id === userMessage.id)
      ? latestHistory
      : [...latestHistory, userMessage];

    await startChatAIResponse(
      {
        roomId: data.roomId,
        systemPrompt: data.systemPrompt,
        roleName: data.roleName,
        model: data.model,
        userMessageId: userMessage.id,
      },
      clientId,
      (response) => {
        if (response.success && response.messageId) {
          callback?.({
            success: true,
            userMessage,
            aiMessageId: response.messageId,
            aiStarted: true,
          });
          return;
        }

        callback?.({
          success: true,
          userMessage,
          aiStarted: false,
          aiError: response.error || 'Failed to start AI response',
        });
      },
      preparedHistory,
    );
  });

  socket.on('edit_message_and_ask_ai', async (data: EditMessageAndAskAIData, callback?: AIAckCallback) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    if (!data.roomId || !data.messageId || typeof data.newContent !== 'string') {
      callback?.({ success: false, error: 'Missing required fields' });
      return;
    }

    if (!(await hasRoomAccess(store, data.roomId, clientId))) {
      socket.emit('error', { message: 'You are not authorized to access this room' });
      callback?.({ success: false, error: 'You are not authorized to access this room' });
      return;
    }

    const room = await store.getRoomById(data.roomId);
    const isCodeAgentRoom = room?.type === 'codeAgent';
    if (isCodeAgentRoom && !codeAgentSessionService) {
      callback?.({ success: false, error: 'Workspace is unavailable' });
      return;
    }

    const targetMessage = await getRoomMessage(store, data.roomId, data.messageId);
    if (!targetMessage) {
      callback?.({ success: false, error: 'Message not found' });
      return;
    }
    if (targetMessage.codeAgentQueuedInput) {
      callback?.({ success: false, error: 'Queued agent inputs must be edited from their queue controls' });
      return;
    }

    const editAuth = await authorizeRoomAction({
      store,
      roomId: data.roomId,
      clientId,
      action: { type: 'message.edit', message: targetMessage },
    });
    if (!editAuth.ok) {
      callback?.({ success: false, error: editAuth.message });
      return;
    }

    const messagesBeforeEdit = isCodeAgentRoom ? await store.readMessagesByRoom(data.roomId) : [];
    const requestedMode = isCodeAgentRoom ? findNextCodeAgentTurnMode(messagesBeforeEdit, data.messageId) : undefined;
    const editResult = await store.updateMessageAndTruncateAfter(data.roomId, data.messageId, data.newContent);
    if (!editResult) {
      callback?.({ success: false, error: 'Failed to save edited message' });
      return;
    }

    if (!editResult.targetFound || !editResult.updatedMessage) {
      callback?.({ success: false, error: 'Message not found' });
      return;
    }

    io.to(editResult.room.creatorId).emit('room_updated', editResult.room);
    notifyMessageHistoryInvalidated(data.roomId, 'edit-and-ask-truncated');

    if (isCodeAgentRoom) {
      await codeAgentSessionService!.startTurn(buildCodeAgentTurnInput({
        roomId: data.roomId,
        clientId,
        selectedModel: normalizeAIModel(data.model),
        codexModel: data.codexModel,
        codexReasoningEffort: data.codexReasoningEffort,
        codexPermissionMode: data.codexPermissionMode,
        codexServiceTier: data.codexServiceTier,
        maxContextMessages: data.maxContextMessages,
        socket,
        requestedMode,
        promptMessage: editResult.updatedMessage,
      }), callback);
      return;
    }

    await startChatAIResponse({
      roomId: data.roomId,
      systemPrompt: data.systemPrompt,
      roleName: data.roleName,
      model: data.model,
    }, clientId, callback, editResult.messages);
  });

  // A2UI follow-up wiring: when the user interacts with a component whose action the
  // model deliberately wired for follow-up (event context.followUp === true), start a
  // new assistant turn carrying the interaction so the model can respond / update the UI.
  // messageHandlers also listens on 'a2ui_action' to validate + broadcast it; both
  // listeners fire independently, so this one only adds the AI turn and never replies to
  // the client's ack callback.
  socket.on('a2ui_action', async (payload: unknown) => {
    if (
      typeof payload !== 'object' || payload === null ||
      typeof (payload as { roomId?: unknown }).roomId !== 'string' ||
      typeof (payload as { messageId?: unknown }).messageId !== 'string' ||
      typeof (payload as { action?: unknown }).action !== 'object' ||
      (payload as { action?: unknown }).action === null
    ) {
      return;
    }

    const { roomId, messageId } = payload as { roomId: string; messageId: string };
    const action = (payload as { action: A2UIActionEvent }).action;

    // The model decides per component which clicks deserve a follow-up turn.
    if (!isA2UIFollowUpAction(action)) {
      return;
    }

    const clientId = await resolveClientId();
    if (!clientId || !(await hasRoomAccess(store, roomId, clientId))) {
      return;
    }

    const room = await store.getRoomById(roomId);
    if (room?.type === 'codeAgent') {
      return;
    }

    const owningMessage = await getRoomMessage(store, roomId, messageId);
    if (!owningMessage || owningMessage.uiPayload?.format !== 'a2ui') {
      return;
    }

    const followUpMessage = createUserMessage({
      id: uuidv4(),
      clientId,
      roomId,
      content: buildA2UIFollowUpMessageContent(action),
    });

    const updatedRoom = await store.appendMessage(followUpMessage);
    if (!updatedRoom) {
      socketLogger.error('Failed to append A2UI follow-up message', { roomId, messageId, clientId });
      return;
    }

    io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
    notifyRoomMessageBestEffort({ store, room: updatedRoom, message: followUpMessage, logger: socketLogger });

    const latestHistory = await store.readMessagesByRoom(roomId);
    const preparedHistory = latestHistory.some(message => message.id === followUpMessage.id)
      ? latestHistory
      : [...latestHistory, followUpMessage];

    const followUpRequest = payload as { systemPrompt?: unknown; roleName?: unknown; model?: unknown; maxContextMessages?: unknown };
    await startChatAIResponse(
      {
        roomId,
        systemPrompt: typeof followUpRequest.systemPrompt === 'string' ? followUpRequest.systemPrompt : undefined,
        roleName: typeof followUpRequest.roleName === 'string' ? followUpRequest.roleName : undefined,
        model: typeof followUpRequest.model === 'string' ? followUpRequest.model : owningMessage.aiModel?.id,
        userMessageId: followUpMessage.id,
        maxContextMessages: typeof followUpRequest.maxContextMessages === 'number' ? followUpRequest.maxContextMessages : undefined,
      },
      clientId,
      undefined,
      preparedHistory,
    );
  });
}
