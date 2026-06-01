import { v4 as uuidv4 } from 'uuid';
import { MAX_CONTEXT_MESSAGES, selectAIHistory } from '../services/aiHistory';
import { calculateAICost, DEFAULT_SYSTEM_MESSAGE, getMessageAIModel, normalizeUsage } from '../services/aiModels';
import {
  buildAIProviderMessages,
  buildAnthropicMessages,
  createAIPlaceholderMessage,
  createReplyReference,
  createUserMessage,
} from '../services/messageDomain';
import { Message } from '../types';
import { SocketConnectionContext } from './types';

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8096;
const ERROR_STATE_SAVE_ATTEMPTS = 3;
const ERROR_STATE_SAVE_RETRY_DELAY_MS = 25;

const isE2EFakeAIEnabled = () =>
  process.env.E2E_TEST_MODE === 'true' && process.env.E2E_FAKE_AI === 'true';

const getE2EFakeAIChunkDelayMs = () => {
  const delayMs = Number.parseInt(process.env.E2E_FAKE_AI_CHUNK_DELAY_MS || '5', 10);
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 5;
};

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

type AIRequestData = {
  roomId: string;
  systemPrompt?: string;
  roleName?: string;
  model?: string;
  editedMessageId?: string;
  retryForMessageId?: string;
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
}: SocketConnectionContext) {
  const startAIResponse = async (
    data: AIRequestData,
    clientId: string,
    callback?: AIAckCallback,
    preparedHistory?: Message[],
  ) => {
    const { roomId, systemPrompt = DEFAULT_SYSTEM_MESSAGE, roleName = 'AI Assistant', editedMessageId, retryForMessageId } = data;
    const selectedModel = normalizeAIModel(data.model);
    const aiMessageId = uuidv4();

    socketLogger.info(`Received AI request (history-based)${editedMessageId ? ' after edit ' + editedMessageId : ''}${retryForMessageId ? ' as retry for ' + retryForMessageId : ''}`, {
      socketId: socket.id,
      clientId,
      roomId,
      roleName,
      model: selectedModel.id,
      apiModel: selectedModel.apiModel,
      provider: selectedModel.provider,
    });

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
          io.to(roomId).emit('message_history', truncation.messages);
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
          io.to(roomId).emit('message_history', truncation.messages);
        } else {
          openaiLogger.warn('Edited message ID not found in history, using full history', { roomId, editedMessageId });
        }
      } else {
        historyUsedForContext = await store.readMessagesByRoom(roomId);
      }

      const selection = selectAIHistory(historyUsedForContext, {
        maxContextMessages: MAX_CONTEXT_MESSAGES,
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

    const placeholderSaved = await saveAIMessage(initialAiMessage, 'streaming placeholder');
    if (!placeholderSaved) {
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: 'Sorry, unable to start a durable AI response.',
        roomId,
      });
      callback?.({ success: false, error: 'Unable to start a durable AI response' });
      return;
    }
    io.to(roomId).emit('new_message', initialAiMessage);
    callback?.({ success: true, messageId: aiMessageId });

    if (isE2EFakeAIEnabled()) {
      const lastUserMessage = [...historyUsedForContext].reverse().find(message => message.clientId !== 'ai_assistant');
      const targetContent = lastUserMessage?.content?.trim() || 'empty prompt';
      const chunks = [
        'E2E AI response ',
        `to: ${targetContent}`,
      ];
      let fullContent = '';
      const chunkDelayMs = getE2EFakeAIChunkDelayMs();

      for (const chunk of chunks) {
        await wait(chunkDelayMs);
        fullContent += chunk;
        io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk, roomId });
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
        return;
      }

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        content: finalAiMessage.content,
        aiModel,
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      io.to(roomId).emit('ai_cost_total', roomCostTotal);
      return;
    }

    try {
      const validMessagesForAPI = buildAIProviderMessages(systemPrompt, contextMessages);
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

      if (aiClientWrapper.provider === 'anthropic') {
        const anthropicMessages = buildAnthropicMessages(contextMessages);
        const stream = aiClientWrapper.client.messages.stream({
          model: selectedModel.apiModel,
          max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] as any,
          messages: anthropicMessages as any,
        });

        for await (const event of stream as any) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const contentChunk: string = event.delta.text;
            fullContent += contentChunk;
            io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk: contentChunk, roomId });
          }
        }

        const finalMsg = await stream.finalMessage();
        reportedUsage = finalMsg.usage;
      } else {
        const stream = await aiClientWrapper.client.chat.completions.create({
          model: selectedModel.apiModel,
          messages: validMessagesForAPI as any,
          stream: true,
          temperature: 1,
          stream_options: { include_usage: true },
        } as any);

        for await (const chunk of stream as any) {
          if (chunk.usage) {
            reportedUsage = chunk.usage;
          }
          if (chunk.choices[0]?.delta?.content) {
            const contentChunk = chunk.choices[0].delta.content;
            fullContent += contentChunk;
            io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk: contentChunk, roomId });
            if (fullContent.length % 100 === 0) {
              openaiLogger.debug('Streaming AI chunk', { messageId: aiMessageId, contentLength: fullContent.length });
            }
          }
        }
      }

      const usage = normalizeUsage(reportedUsage, validMessagesForAPI, fullContent);
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
        return;
      }

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        content: finalAiMessage.content,
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
      const errorAiMessage: Message = {
        ...initialAiMessage,
        status: 'error',
        content: 'Error generating response.',
        timestamp: new Date().toISOString(),
      };
      await saveAIErrorMessage(errorAiMessage, 'stream error');
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: 'Sorry, an error occurred while generating the AI response.',
        roomId,
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
      messageType: 'text',
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
      },
      clientId,
      (response) => {
        if (response.success && response.messageId) {
          callback?.({
            success: true,
            userMessage,
            aiMessageId: response.messageId,
          });
          return;
        }

        callback?.({ success: false, error: response.error || 'Failed to start AI response' });
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
    io.to(data.roomId).emit('message_history', editResult.messages);

    await startAIResponse({
      roomId: data.roomId,
      systemPrompt: data.systemPrompt,
      roleName: data.roleName,
      model: data.model,
    }, clientId, callback, editResult.messages);
  });
}
