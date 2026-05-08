import { v4 as uuidv4 } from 'uuid';
import { buildFinalAIHistory, MAX_CONTEXT_MESSAGES, selectAIHistory } from '../services/aiHistory';
import { calculateAICost, DEFAULT_SYSTEM_MESSAGE, getMessageAIModel, normalizeUsage } from '../services/aiModels';
import {
  buildAIProviderMessages,
  buildAnthropicMessages,
  createAIPlaceholderMessage,
} from '../services/messageDomain';
import { Message } from '../types';
import { SocketConnectionContext } from './types';

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8096;

const isE2EFakeAIEnabled = () =>
  process.env.E2E_TEST_MODE === 'true' && process.env.E2E_FAKE_AI === 'true';

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

export function registerAIHandlers({
  io,
  socket,
  store,
  socketLogger,
  openaiLogger,
  normalizeAIModel,
  getAIClientForModel,
}: SocketConnectionContext) {
  socket.on('ask_ai', async (data: {
    roomId: string;
    systemPrompt?: string;
    roleName?: string;
    model?: string;
    editedMessageId?: string;
    retryForMessageId?: string;
  }) => {
    const clientId = await store.getClientId(socket.id);
    if (!clientId) {
      socket.emit('error', { message: 'You are not registered' });
      return;
    }

    if (!data.roomId) {
      socket.emit('error', { message: 'Room ID is required for AI request' });
      return;
    }

    const { roomId, systemPrompt = DEFAULT_SYSTEM_MESSAGE, roleName = 'AI Assistant', editedMessageId, retryForMessageId } = data;
    const selectedModel = normalizeAIModel(data.model);

    socketLogger.info(`Received AI request (history-based)${editedMessageId ? ' after edit ' + editedMessageId : ''}${retryForMessageId ? ' as retry for ' + retryForMessageId : ''}`, {
      socketId: socket.id,
      clientId,
      roomId,
      roleName,
      model: selectedModel.id,
      apiModel: selectedModel.apiModel,
      provider: selectedModel.provider,
    });

    const aiMessageId = uuidv4();
    const initialAiMessage = createAIPlaceholderMessage({
      id: aiMessageId,
      roomId,
      roleName,
      model: selectedModel,
    });
    io.to(roomId).emit('new_message', initialAiMessage);

    let contextMessages: Message[] = [];
    let historyUsedForContext: Message[] = [];

    try {
      const fullHistory = await store.readMessagesByRoom(roomId);
      const selection = selectAIHistory(fullHistory, {
        editedMessageId,
        retryForMessageId,
        maxContextMessages: MAX_CONTEXT_MESSAGES,
      });

      historyUsedForContext = selection.historyUsedForContext;
      contextMessages = selection.contextMessages;

      if (retryForMessageId) {
        if (selection.truncationReason === 'retry') {
          openaiLogger.info('Truncating message history for retry', {
            roomId,
            retryForMessageId,
            originalCount: fullHistory.length,
            newCount: historyUsedForContext.length,
          });
        } else {
          openaiLogger.warn('Retry message ID not found in history, using full history', { roomId, retryForMessageId });
        }
      } else if (editedMessageId) {
        if (selection.truncationReason === 'edit') {
          openaiLogger.info('Truncating message history after edit', {
            roomId,
            editedMessageId,
            originalCount: fullHistory.length,
            newCount: historyUsedForContext.length,
          });
        } else {
          openaiLogger.warn('Edited message ID not found in history, using full history', { roomId, editedMessageId });
        }
      }

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

    if (isE2EFakeAIEnabled()) {
      const lastUserMessage = [...contextMessages].reverse().find(message => message.clientId !== 'ai_assistant');
      const targetContent = lastUserMessage?.content?.trim() || 'empty prompt';
      const chunks = [
        'E2E AI response ',
        `to: ${targetContent}`,
      ];
      let fullContent = '';

      for (const chunk of chunks) {
        fullContent += chunk;
        io.to(roomId).emit('ai_chunk', { messageId: aiMessageId, chunk, roomId });
        await wait(5);
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

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        aiModel,
        usage,
        cost,
        sessionCost: roomCostTotal,
      });
      io.to(roomId).emit('ai_cost_total', roomCostTotal);

      const finalAiMessage: Message = {
        ...initialAiMessage,
        content: fullContent,
        status: 'complete',
        timestamp: new Date().toISOString(),
        aiModel,
        usage,
        cost,
      };

      try {
        const updatedRoom = await store.saveMessageHistory(roomId, buildFinalAIHistory(historyUsedForContext, finalAiMessage));
        if (updatedRoom) {
          io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
        }
      } catch (err) {
        openaiLogger.error('Failed to save E2E fake AI history', { error: err, messageId: aiMessageId });
      }
      return;
    }

    try {
      const validMessagesForAPI = buildAIProviderMessages(systemPrompt, contextMessages);
      const hasUserOrAssistantMessage = validMessagesForAPI.some(msg => msg.role === 'user' || msg.role === 'assistant');
      if (!hasUserOrAssistantMessage && validMessagesForAPI.length <= 1) {
        openaiLogger.error('Cannot call OpenAI API without user or assistant messages in context.', { roomId });
        io.to(roomId).emit('ai_stream_error', {
          messageId: aiMessageId,
          error: 'Sorry, cannot generate a response without any context or question.',
          roomId,
        });
        store.saveMessageHistory(roomId, historyUsedForContext).catch(err => openaiLogger.error('Failed to save history after empty context error', { error: err }));
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

      io.to(roomId).emit('ai_stream_end', {
        messageId: aiMessageId,
        roomId,
        aiModel: getMessageAIModel(selectedModel),
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

      const finalAiMessage: Message = {
        ...initialAiMessage,
        content: fullContent,
        status: 'complete',
        timestamp: new Date().toISOString(),
        aiModel: getMessageAIModel(selectedModel),
        usage,
        cost,
      };
      const finalHistoryToSave = buildFinalAIHistory(historyUsedForContext, finalAiMessage);

      store.saveMessageHistory(roomId, finalHistoryToSave).then((updatedRoom) => {
        if (updatedRoom) {
          io.to(updatedRoom.creatorId).emit('room_updated', updatedRoom);
        }
        openaiLogger.info('Saved final AI message and its context history to Redis', {
          messageId: aiMessageId,
          historyLength: finalHistoryToSave.length,
          contextLengthUsed: contextMessages.length,
        });
      }).catch(err => {
        openaiLogger.error('Failed to save final AI history to Redis', { error: err, messageId: aiMessageId });
      });
    } catch (error) {
      socketLogger.error('Error processing AI stream request', {
        error: error instanceof Error ? error.message : error,
        socketId: socket.id,
        clientId,
        roomId,
      });
      io.to(roomId).emit('ai_stream_error', {
        messageId: aiMessageId,
        error: 'Sorry, an error occurred while generating the AI response.',
        roomId,
      });
      const errorAiMessage: Message = { ...initialAiMessage, status: 'error', content: 'Error generating response.' };
      store.saveMessageHistory(roomId, buildFinalAIHistory(historyUsedForContext, errorAiMessage)).catch(err => openaiLogger.error('Failed to save error AI history', { error: err }));
    }
  });
}
