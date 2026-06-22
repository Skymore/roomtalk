import { v4 as uuidv4 } from 'uuid';
import { MAX_CONTEXT_MESSAGES, MAX_CONTEXT_TOKENS, normalizeAIContextMessageLimit, selectAIHistory } from '../services/aiHistory';
import { calculateAICost, DEFAULT_SYSTEM_MESSAGE, getMessageAIModel, normalizeUsage } from '../services/aiModels';
import { A2UI_BASIC_CATALOG_ID, mergeA2UIPayloads, normalizeA2UIPayload } from '../services/a2uiPayload';
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
import { withAIStreamRecoveryMetadata } from '../services/aiStreamRecovery';
import { A2UIActionEvent, Message } from '../types';
import { hasRoomAccess } from './roomAccess';
import { authorizeRoomAction, getRoomMessage } from './roomAuthorization';
import { SocketConnectionContext } from './types';

// Upper bound on the AI response length (Anthropic). Raised from 8096 to reduce
// mid-response truncation; only billed for tokens actually generated. Override
// with ANTHROPIC_MAX_TOKENS in prod without a code change.
export const DEFAULT_ANTHROPIC_MAX_TOKENS = (() => {
  const parsed = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32000;
})();
const ERROR_STATE_SAVE_ATTEMPTS = 3;
const ERROR_STATE_SAVE_RETRY_DELAY_MS = 25;

const isE2EFakeAIEnabled = () =>
  process.env.E2E_TEST_MODE === 'true' && process.env.E2E_FAKE_AI === 'true';

const getE2EFakeAIChunkDelayMs = () => {
  const delayMs = Number.parseInt(process.env.E2E_FAKE_AI_CHUNK_DELAY_MS || '5', 10);
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5;
};

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

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
}): Promise<StreamAIResult> => {
  const providerMessages = [...params.messages];
  let fullContent = '';
  let reportedUsage: ReportedUsage = null;

  for (let round = 0; round < MAX_A2UI_TOOL_ROUNDS; round++) {
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
    } as any);

    for await (const chunk of stream as any) {
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
}): Promise<StreamAIResult> => {
  const providerMessages = [...params.messages];
  let fullContent = '';
  let reportedUsage: ReportedUsage = null;

  for (let round = 0; round < MAX_A2UI_TOOL_ROUNDS; round++) {
    const stream = params.client.messages.stream({
      model: params.model,
      max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
      system: [{ type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: providerMessages,
      tools: [anthropicA2UITool],
    } as any);

    for await (const event of stream as any) {
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
  userMessageId?: string;
  editedMessageId?: string;
  retryForMessageId?: string;
  maxContextMessages?: number;
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

export function registerAIHandlers({
  io,
  socket,
  store,
  socketLogger,
  openaiLogger,
  normalizeAIModel,
  getAIClientForModel,
  aiStreamOwnerId,
}: SocketConnectionContext) {
  const emitLatestHistoryPage = async (roomId: string) => {
    const page = await store.readMessagePageByRoom(roomId);
    io.to(roomId).emit('message_history', {
      ...page,
      mode: 'replace',
    });
  };

  const startAIResponse = async (
    data: AIRequestData,
    clientId: string,
    callback?: AIAckCallback,
    preparedHistory?: Message[],
  ) => {
    const { roomId, systemPrompt = DEFAULT_SYSTEM_MESSAGE, roleName = 'AI Assistant', editedMessageId, retryForMessageId } = data;
    const selectedModel = normalizeAIModel(data.model);
    const aiMessageId = uuidv4();
    const aiRunId = uuidv4();
    let assistantRunRecorded = false;

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

    const recordAssistantRunStart = async () => {
      const now = new Date().toISOString();
      const run = {
        id: aiRunId,
        roomId,
        requestedByClientId: clientId,
        userMessageId: data.userMessageId,
        aiMessageId,
        status: 'running' as const,
        modelId: selectedModel.id,
        apiModel: selectedModel.apiModel,
        provider: selectedModel.provider,
        roleName,
        systemPrompt,
        maxContextMessages,
        retryForMessageId,
        editedMessageId,
        createdAt: now,
        queuedAt: now,
        startedAt: now,
        updatedAt: now,
        metadata: {
          runnerMode: 'inline',
        },
      };
      const event = {
        id: uuidv4(),
        eventType: 'ai.run.inline_started',
        aggregateType: 'assistant_run',
        aggregateId: aiRunId,
        roomId,
        payload: {
          runId: aiRunId,
          roomId,
          aiMessageId,
          userMessageId: data.userMessageId,
          model: selectedModel.id,
          runnerMode: 'inline',
        },
        status: 'processed' as const,
        attempts: 1,
        availableAt: now,
        processedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      if (!store.createAssistantRunWithOutbox) {
        openaiLogger.debug('Assistant run recording unavailable on store; continuing inline stream', { runId: aiRunId, messageId: aiMessageId, roomId });
        return;
      }
      const recorded = await store.createAssistantRunWithOutbox(run, event);
      assistantRunRecorded = Boolean(recorded);
      if (!recorded) {
        openaiLogger.warn('Failed to record assistant run start; continuing inline stream', { runId: aiRunId, messageId: aiMessageId, roomId });
      }
    };

    const updateAssistantRun = async (updates: {
      status: 'complete' | 'error' | 'cancelled';
      error?: string;
      metadata?: Record<string, unknown>;
    }) => {
      if (!assistantRunRecorded) {
        return;
      }
      const now = new Date().toISOString();
      const updated = await store.updateAssistantRun?.(aiRunId, {
        status: updates.status,
        error: updates.error ?? null,
        completedAt: now,
        updatedAt: now,
        metadata: updates.metadata,
      });
      if (!updated) {
        openaiLogger.warn('Failed to update assistant run status', { runId: aiRunId, status: updates.status, roomId, messageId: aiMessageId });
      }
    };

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
          await emitLatestHistoryPage(roomId);
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
          await emitLatestHistoryPage(roomId);
        } else {
          openaiLogger.warn('Edited message ID not found in history, using full history', { roomId, editedMessageId });
        }
      } else {
        historyUsedForContext = await store.readMessagesByRoom(roomId);
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
      contextMessages = [];
    }

    openaiLogger.debug('contextMessages', contextMessages);

    const initialAiMessage = createAIPlaceholderMessage({
      id: aiMessageId,
      roomId,
      roleName,
      model: selectedModel,
    });
    const persistedInitialAiMessage = withAIStreamRecoveryMetadata(initialAiMessage, aiStreamOwnerId);

    const saveAIMessage = async (message: Message, logLabel: string): Promise<boolean> => {
      try {
        const updatedRoom = await store.upsertMessage(message);
        if (!updatedRoom) {
          openaiLogger.error(`Persistent store rejected ${logLabel} AI message`, { messageId: message.id, roomId, status: message.status });
          return false;
        }
        io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
        openaiLogger.info(`Saved ${logLabel} AI message to persistent history`, {
          messageId: message.id,
          roomId,
          status: message.status,
        });
        return true;
      } catch (err) {
        openaiLogger.error(`Failed to save ${logLabel} AI message to persistent history`, { error: err, messageId: message.id, roomId });
        return false;
      }
    };

    const saveAIErrorMessage = async (message: Message, logLabel: string): Promise<boolean> => {
      for (let attempt = 1; attempt <= ERROR_STATE_SAVE_ATTEMPTS; attempt++) {
        const saved = await saveAIMessage(message, attempt === 1 ? logLabel : `${logLabel} retry ${attempt}`);
        if (saved) {
          return true;
        }

        if (attempt < ERROR_STATE_SAVE_ATTEMPTS) {
          await wait(ERROR_STATE_SAVE_RETRY_DELAY_MS * attempt);
        }
      }

      openaiLogger.error('Failed to persist AI error state after retries; streaming message may need startup recovery', {
        messageId: message.id,
        roomId,
        status: message.status,
        attempts: ERROR_STATE_SAVE_ATTEMPTS,
      });
      io.to(roomId).emit('ai_persistence_error', {
        messageId: message.id,
        error: 'AI response status could not be saved. It will be recovered if the server restarts.',
        roomId,
      });
      return false;
    };

    const placeholderSaved = await saveAIMessage(persistedInitialAiMessage, 'streaming placeholder');
    if (!placeholderSaved) {
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: 'Sorry, unable to start a durable AI response.',
        roomId,
      });
      callback?.({ success: false, error: 'Unable to start a durable AI response' });
      return;
    }
    await recordAssistantRunStart();
    io.to(roomId).emit('new_message', initialAiMessage);
    callback?.({ success: true, messageId: aiMessageId });

    let streamedTextContent = '';
    let streamedA2UIPayload: Message['uiPayload'];
    let fallbackUsageMessages: Array<{ content: any }> = [];
    const emitA2UIUpdate = async (messages: unknown[]): Promise<boolean> => {
      const uiPayload = await normalizeA2UIPayload(messages);
      if (!uiPayload) {
        openaiLogger.warn('Ignoring invalid A2UI stream update', { messageId: aiMessageId, roomId });
        return false;
      }

      streamedA2UIPayload = mergeA2UIPayloads(streamedA2UIPayload, uiPayload);
      io.to(roomId).emit('a2ui_update', {
        messageId: aiMessageId,
        roomId,
        uiPayload,
      });
      return true;
    };

    if (isE2EFakeAIEnabled()) {
      const lastUserMessage = [...historyUsedForContext].reverse().find(message => message.clientId !== 'ai_assistant');
      const targetContent = lastUserMessage?.content?.trim() || 'empty prompt';
      const surfaceId = `summary-${aiMessageId}`;
      const chunks = [
        'E2E AI response: ',
        `I received "${targetContent}". `,
        'The text stream is still moving while the UI surface updates. ',
        'The card below includes live status, checklist items, and an action.',
      ];
      let fullContent = '';
      const chunkDelayMs = getE2EFakeAIChunkDelayMs();

      await emitA2UIUpdate([{
        version: 'v0.9',
        createSurface: {
          surfaceId,
          catalogId: A2UI_BASIC_CATALOG_ID,
        },
      }]);

      for (const [index, chunk] of chunks.entries()) {
        await wait(chunkDelayMs);
        fullContent += chunk;
        io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk, roomId });

        if (index === 0) {
          await emitA2UIUpdate([{
            version: 'v0.9',
            updateComponents: {
              surfaceId,
              components: [
                { id: 'root', component: 'Card', child: 'body' },
                { id: 'body', component: 'Column', children: ['header', 'summary', 'divider', 'status_row', 'checklist_title', 'checklist', 'controls_title', 'controls', 'actions'], align: 'stretch' },
                { id: 'header', component: 'Row', children: ['title_group', 'phase'], align: 'center', justify: 'spaceBetween' },
                { id: 'title_group', component: 'Row', children: ['surface_icon', 'title'], align: 'center' },
                { id: 'surface_icon', component: 'Icon', name: 'info' },
                { id: 'title', component: 'Text', text: { path: '/title' }, variant: 'h3' },
                { id: 'phase', component: 'Text', text: { path: '/phase' }, variant: 'caption' },
                { id: 'summary', component: 'Text', text: { path: '/body' }, variant: 'body' },
                { id: 'divider', component: 'Divider' },
                { id: 'status_row', component: 'Row', children: ['status_label', 'status_value'], align: 'center' },
                { id: 'status_label', component: 'Text', text: 'Status', variant: 'caption' },
                { id: 'status_value', component: 'Text', text: { path: '/status' }, variant: 'body' },
                { id: 'checklist_title', component: 'Text', text: 'Streaming checkpoints', variant: 'h5' },
                { id: 'checklist', component: 'List', children: ['item_1', 'item_2', 'item_3'], direction: 'vertical' },
                { id: 'item_1', component: 'Row', children: ['item_1_state', 'item_1_text'], align: 'center' },
                { id: 'item_1_state', component: 'Text', text: { path: '/item1State' }, variant: 'caption' },
                { id: 'item_1_text', component: 'Text', text: { path: '/item1Text' }, variant: 'body' },
                { id: 'item_2', component: 'Row', children: ['item_2_state', 'item_2_text'], align: 'center' },
                { id: 'item_2_state', component: 'Text', text: { path: '/item2State' }, variant: 'caption' },
                { id: 'item_2_text', component: 'Text', text: { path: '/item2Text' }, variant: 'body' },
                { id: 'item_3', component: 'Row', children: ['item_3_state', 'item_3_text'], align: 'center' },
                { id: 'item_3_state', component: 'Text', text: { path: '/item3State' }, variant: 'caption' },
                { id: 'item_3_text', component: 'Text', text: { path: '/item3Text' }, variant: 'body' },
                { id: 'controls_title', component: 'Text', text: 'Native catalog controls', variant: 'h5' },
                {
                  id: 'controls',
                  component: 'Tabs',
                  tabs: [
                    { title: 'Inputs', child: 'input_column' },
                    { title: 'Media', child: 'media_column' },
                  ],
                },
                {
                  id: 'input_column',
                  component: 'Column',
                  children: ['name_field', 'ready_check', 'choice_picker', 'confidence_slider', 'date_input', 'details_modal'],
                  align: 'stretch',
                },
                { id: 'name_field', component: 'TextField', label: 'Reviewer', value: { path: '/reviewer' }, variant: 'shortText' },
                { id: 'ready_check', component: 'CheckBox', label: 'Ready to submit feedback', value: { path: '/ready' } },
                {
                  id: 'choice_picker',
                  component: 'ChoicePicker',
                  label: 'Preferred next step',
                  variant: 'mutuallyExclusive',
                  options: [
                    { label: 'Keep streaming', value: 'stream' },
                    { label: 'Open details', value: 'details' },
                    { label: 'Export summary', value: 'export' },
                  ],
                  value: { path: '/selectedNextStep' },
                  displayStyle: 'chips',
                },
                { id: 'confidence_slider', component: 'Slider', label: 'Confidence', min: 0, max: 100, value: { path: '/confidence' } },
                { id: 'date_input', component: 'DateTimeInput', label: 'Review time', value: { path: '/reviewAt' }, enableDate: true, enableTime: true },
                { id: 'details_modal', component: 'Modal', trigger: 'details_trigger', content: 'details_content' },
                {
                  id: 'details_trigger',
                  component: 'Button',
                  child: 'details_trigger_text',
                  variant: 'default',
                  action: {
                    event: {
                      name: 'a2ui_demo_open_details',
                      context: { source: 'e2e_fake_ai' },
                    },
                  },
                },
                { id: 'details_trigger_text', component: 'Text', text: 'Open details' },
                { id: 'details_content', component: 'Card', child: 'details_text' },
                { id: 'details_text', component: 'Text', text: { path: '/modalText' } },
                { id: 'media_column', component: 'Column', children: ['sample_image', 'sample_audio', 'sample_video', 'media_caption'], align: 'stretch' },
                { id: 'sample_image', component: 'Image', url: { path: '/imageUrl' }, description: 'A2UI placeholder image', fit: 'cover', variant: 'smallFeature' },
                { id: 'sample_audio', component: 'AudioPlayer', url: { path: '/audioUrl' }, description: 'Sample audio' },
                { id: 'sample_video', component: 'Video', url: { path: '/videoUrl' } },
                { id: 'media_caption', component: 'Text', text: { path: '/mediaCaption' }, variant: 'caption' },
                { id: 'actions', component: 'Row', children: ['acknowledge'], align: 'center', justify: 'end' },
                {
                  id: 'acknowledge',
                  component: 'Button',
                  child: 'acknowledge_text',
                  variant: 'primary',
                  action: {
                    event: {
                      name: 'a2ui_demo_acknowledge',
                      context: {
                        prompt: { path: '/prompt' },
                        source: 'e2e_fake_ai',
                      },
                    },
                  },
                },
                { id: 'acknowledge_text', component: 'Text', text: { path: '/ctaLabel' } },
              ],
            },
          }]);
        }

        if (index === 1) {
          await emitA2UIUpdate([{
            version: 'v0.9',
            updateDataModel: {
              surfaceId,
              path: '/',
              value: {
                title: 'Streaming A2UI',
                phase: '2/4 chunks',
                body: 'This surface is already visible while the assistant text stream continues.',
                status: 'Creating the component tree and binding live data.',
                ctaLabel: 'Send UI action',
                prompt: targetContent,
                item1State: 'Done',
                item1Text: 'createSurface emitted before the first text chunk settles.',
                item2State: 'Live',
                item2Text: 'updateComponents is rendering layout, input, tab, modal, and media components from the native catalog.',
                item3State: 'Next',
                item3Text: 'updateDataModel will replace these values before ai_stream_end.',
                reviewer: 'RoomTalk',
                ready: true,
                selectedNextStep: ['stream'],
                confidence: 60,
                reviewAt: '2026-06-13T12:00:00-07:00',
                modalText: 'Modal content is part of the same streamed A2UI surface.',
                imageUrl: 'https://placehold.co/640x360/png?text=A2UI',
                audioUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
                videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                mediaCaption: 'Image, AudioPlayer, and Video are available when the model has concrete media URLs.',
              },
            },
          }]);
        }

        if (index === 2) {
          await emitA2UIUpdate([{
            version: 'v0.9',
            updateDataModel: {
              surfaceId,
              path: '/',
              value: {
                title: 'Streaming A2UI',
                phase: '3/4 chunks',
                body: 'The UI model is updating from a later server event, independently of markdown text.',
                status: 'Data model update received while the final text chunk is still pending.',
                ctaLabel: 'Send UI action',
                prompt: targetContent,
                item1State: 'Done',
                item1Text: 'createSurface opened a stable surface for this AI message.',
                item2State: 'Done',
                item2Text: 'updateComponents installed the reusable UI structure.',
                item3State: 'Live',
                item3Text: 'updateDataModel is streaming new values into the same surface.',
                reviewer: 'RoomTalk',
                ready: true,
                selectedNextStep: ['details'],
                confidence: 78,
                reviewAt: '2026-06-13T12:05:00-07:00',
                modalText: 'The modal, tabs, form controls, and media preview all reuse the official A2UI React catalog.',
                imageUrl: 'https://placehold.co/640x360/png?text=Streaming+A2UI',
                audioUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
                videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                mediaCaption: 'The media tab updates from the data model without replacing the component tree.',
              },
            },
          }]);
        }

        if (index === 3) {
          await emitA2UIUpdate([{
            version: 'v0.9',
            updateDataModel: {
              surfaceId,
              path: '/',
              value: {
                title: 'Streaming A2UI',
                phase: 'Complete',
                body: 'The surface finished updating before ai_stream_end, then the final AI message persisted the cumulative A2UI payload.',
                status: 'Ready for client actions.',
                ctaLabel: 'Send UI action',
                prompt: targetContent,
                item1State: 'Done',
                item1Text: 'Server emitted validated A2UI v0.9 messages incrementally.',
                item2State: 'Done',
                item2Text: 'Client appended updates and rendered via @a2ui/react.',
                item3State: 'Done',
                item3Text: 'The final message now stores the same cumulative UI payload.',
                reviewer: 'RoomTalk',
                ready: true,
                selectedNextStep: ['export'],
                confidence: 92,
                reviewAt: '2026-06-13T12:10:00-07:00',
                modalText: 'This demo now exercises the full native A2UI basic catalog exposed to the assistant.',
                imageUrl: 'https://placehold.co/640x360/png?text=Catalog+Ready',
                audioUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
                videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                mediaCaption: 'The current implementation exposes all A2UI v0.9 basic catalog components.',
              },
            },
          }]);
        }
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
      const roomCostTotal = await store.incrementRoomAICost(roomId, cost || null);
      const aiModel = getMessageAIModel(selectedModel);

      const finalAiMessage: Message = {
        ...initialAiMessage,
        content: fullContent,
        status: 'complete',
        timestamp: new Date().toISOString(),
        aiModel,
        usage,
        cost,
      };
      if (streamedA2UIPayload) {
        finalAiMessage.uiPayload = streamedA2UIPayload;
      }

      const finalSaved = await saveAIMessage(finalAiMessage, 'E2E fake complete');
      if (!finalSaved) {
        await saveAIErrorMessage({
          ...initialAiMessage,
          status: 'error',
          content: 'Error saving response.',
          timestamp: new Date().toISOString(),
        }, 'E2E fake final-save error');
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, unable to save the AI response.',
          roomId,
        });
        await updateAssistantRun({ status: 'error', error: 'Failed to save final AI response' });
        return;
      }

      await updateAssistantRun({
        status: 'complete',
        metadata: {
          contentLength: fullContent.length,
          usage,
          cost,
        },
      });

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        content: finalAiMessage.content,
        uiPayload: finalAiMessage.uiPayload,
        aiModel,
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      io.to(roomId).emit('ai_cost_total', roomCostTotal);
      return;
    }

    try {
      const systemPromptWithA2UI = buildA2UIToolSystemPrompt(systemPrompt);
      const validMessagesForAPI = buildAIProviderMessages(systemPromptWithA2UI, contextMessages);
      fallbackUsageMessages = validMessagesForAPI;
      const hasUserOrAssistantMessage = validMessagesForAPI.some(msg => msg.role === 'user' || msg.role === 'assistant');
      if (!hasUserOrAssistantMessage && validMessagesForAPI.length <= 1) {
        openaiLogger.error('Cannot call OpenAI API without user or assistant messages in context.', { roomId });
        const errorAiMessage: Message = {
          ...initialAiMessage,
          status: 'error',
          content: 'Cannot generate a response without any context or question.',
          timestamp: new Date().toISOString(),
        };
        await saveAIErrorMessage(errorAiMessage, 'empty-context error');
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, cannot generate a response without any context or question.',
          roomId,
        });
        await updateAssistantRun({ status: 'error', error: 'Cannot generate a response without context' });
        return;
      }

      openaiLogger.debug('Sending messages to AI provider (history-based)', {
        messages: validMessagesForAPI,
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
        const anthropicMessages = buildAnthropicMessages(contextMessages);
        const streamResult = await streamAnthropicWithA2UI({
          client: aiClientWrapper.client,
          model: selectedModel.apiModel,
          systemPrompt: systemPromptWithA2UI,
          messages: anthropicMessages as any[],
          emitA2UIUpdate,
          emitTextChunk: (chunk) => {
            streamedTextContent += chunk;
            io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk, roomId });
          },
          logger: openaiLogger,
          messageId: aiMessageId,
        });
        fullContent = streamResult.fullContent;
        streamedTextContent = fullContent;
        reportedUsage = streamResult.reportedUsage;
        usageMessages = streamResult.usageMessages;
      } else {
        const streamResult = await streamOpenAICompatibleWithA2UI({
          client: aiClientWrapper.client,
          model: selectedModel.apiModel,
          messages: validMessagesForAPI as any[],
          emitA2UIUpdate,
          emitTextChunk: (chunk) => {
            streamedTextContent += chunk;
            io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk, roomId });
          },
          logger: openaiLogger,
          messageId: aiMessageId,
        });
        fullContent = streamResult.fullContent;
        streamedTextContent = fullContent;
        reportedUsage = streamResult.reportedUsage;
        usageMessages = streamResult.usageMessages;
      }

      const usage = normalizeUsage(reportedUsage, usageMessages, fullContent);
      const cost = calculateAICost(selectedModel, usage);
      const roomCostTotal = await store.incrementRoomAICost(roomId, cost || null);
      const aiModel = getMessageAIModel(selectedModel);

      const finalAiMessage: Message = {
        ...initialAiMessage,
        content: fullContent,
        status: 'complete',
        timestamp: new Date().toISOString(),
        aiModel,
        usage,
        cost,
      };
      if (streamedA2UIPayload) {
        finalAiMessage.uiPayload = streamedA2UIPayload;
      }
      const finalSaved = await saveAIMessage(finalAiMessage, 'complete');
      if (!finalSaved) {
        await saveAIErrorMessage({
          ...initialAiMessage,
          status: 'error',
          content: 'Error saving response.',
          timestamp: new Date().toISOString(),
        }, 'final-save error');
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, unable to save the AI response.',
          roomId,
        });
        await updateAssistantRun({ status: 'error', error: 'Failed to save final AI response' });
        return;
      }

      await updateAssistantRun({
        status: 'complete',
        metadata: {
          contentLength: fullContent.length,
          usage,
          cost,
        },
      });

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        content: finalAiMessage.content,
        uiPayload: finalAiMessage.uiPayload,
        aiModel,
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      io.to(roomId).emit('ai_cost_total', roomCostTotal);
      openaiLogger.info('AI stream ended', {
        messageId: aiMessageId,
        contentLength: fullContent.length,
        model: selectedModel.id,
        usage,
        cost,
        roomCostTotal,
      });
    } catch (error) {
      socketLogger.error('Error processing AI stream request', {
        error: error instanceof Error ? error.message : error,
        socketId: socket.id,
        clientId,
        roomId,
      });

      const hasPartialContent = streamedTextContent.trim().length > 0;
      if (hasPartialContent && isPrematureCloseError(error)) {
        const usage = normalizeUsage(null, fallbackUsageMessages, streamedTextContent);
        const cost = calculateAICost(selectedModel, usage);
        const roomCostTotal = await store.incrementRoomAICost(roomId, cost || null);
        const aiModel = getMessageAIModel(selectedModel);
        const finalAiMessage: Message = {
          ...initialAiMessage,
          content: streamedTextContent,
          status: 'complete',
          timestamp: new Date().toISOString(),
          aiModel,
          usage,
          cost,
        };
        if (streamedA2UIPayload) {
          finalAiMessage.uiPayload = streamedA2UIPayload;
        }

        const finalSaved = await saveAIMessage(finalAiMessage, 'premature-close complete');
        if (!finalSaved) {
          await saveAIErrorMessage({
            ...initialAiMessage,
            status: 'error',
            content: streamedTextContent,
            timestamp: new Date().toISOString(),
          }, 'premature-close final-save error');
          io.to(roomId).emit('ai_stream_error', {
            messageId: aiMessageId,
            error: 'The AI response was generated, but could not be saved.',
            roomId,
            partial: true,
          });
          await updateAssistantRun({ status: 'error', error: 'Failed to save premature-close AI response' });
          return;
        }

        await updateAssistantRun({
          status: 'complete',
          metadata: {
            contentLength: streamedTextContent.length,
            usage,
            cost,
            completedAfterPrematureClose: true,
          },
        });

        io.to(roomId).emit('ai_stream_end', {
          messageId: aiMessageId,
          roomId,
          content: finalAiMessage.content,
          uiPayload: finalAiMessage.uiPayload,
          aiModel,
          usage,
          cost,
          sessionCost: roomCostTotal,
          completedAfterPrematureClose: true,
        });
        io.to(roomId).emit('ai_cost_total', roomCostTotal);
        openaiLogger.warn('AI stream closed prematurely after content; treating response as complete', {
          messageId: aiMessageId,
          roomId,
          contentLength: streamedTextContent.length,
          model: selectedModel.id,
        });
        return;
      }

      const errorAiMessage: Message = {
        ...initialAiMessage,
        status: 'error',
        content: streamedTextContent || 'Error generating response.',
        timestamp: new Date().toISOString(),
      };
      if (streamedA2UIPayload) {
        errorAiMessage.uiPayload = streamedA2UIPayload;
      }
      await saveAIErrorMessage(errorAiMessage, 'stream error');
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: hasPartialContent
          ? 'The AI provider connection closed before a normal finish. The partial response above was saved.'
          : 'Sorry, an error occurred while generating the AI response.',
        roomId,
        partial: hasPartialContent,
      });
      await updateAssistantRun({
        status: 'error',
        error: error instanceof Error ? error.message : 'Error generating response',
        metadata: hasPartialContent ? { partial: true, contentLength: streamedTextContent.length } : undefined,
      });
    }
  };

  socket.on('ask_ai', async (data: AIRequestData, callback?: AIAckCallback) => {
    const clientId = await store.getClientId(socket.id);
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

    await startAIResponse(data, clientId, callback);
  });

  socket.on('send_message_and_ask_ai', async (
    data: SendMessageAndAskAIData,
    callback?: SendMessageAndAskAIAckCallback,
  ) => {
    const clientId = await store.getClientId(socket.id);
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
    io.to(data.roomId).emit('new_message', userMessage);
    notifyRoomMessageBestEffort({ store, room: updatedRoom, message: userMessage, logger: socketLogger });

    const latestHistory = await store.readMessagesByRoom(data.roomId);
    const preparedHistory = latestHistory.some(message => message.id === userMessage.id)
      ? latestHistory
      : [...latestHistory, userMessage];

    await startAIResponse(
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
    const clientId = await store.getClientId(socket.id);
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

    const targetMessage = await getRoomMessage(store, data.roomId, data.messageId);
    if (!targetMessage) {
      callback?.({ success: false, error: 'Message not found' });
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
    io.to(data.roomId).emit('message_edited', editResult.updatedMessage);
    await emitLatestHistoryPage(data.roomId);

    await startAIResponse({
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

    const clientId = await store.getClientId(socket.id);
    if (!clientId || !(await hasRoomAccess(store, roomId, clientId))) {
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
    io.to(roomId).emit('new_message', followUpMessage);
    notifyRoomMessageBestEffort({ store, room: updatedRoom, message: followUpMessage, logger: socketLogger });

    const latestHistory = await store.readMessagesByRoom(roomId);
    const preparedHistory = latestHistory.some(message => message.id === followUpMessage.id)
      ? latestHistory
      : [...latestHistory, followUpMessage];

    const followUpRequest = payload as { systemPrompt?: unknown; roleName?: unknown; model?: unknown; maxContextMessages?: unknown };
    await startAIResponse(
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
