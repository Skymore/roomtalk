import {
  CocoRunnerEvent,
  CocoRunnerFinalEvent,
  CocoRunnerTextDeltaEvent,
  CocoRunnerToolCallEvent,
  CocoRunnerToolResultEvent,
} from './cocoRunnerProtocol';

export type CocoMessageDraftType = 'tool_call' | 'tool_result' | 'sandbox_status';

export interface CocoMessageDraft {
  id: string;
  clientId: 'coco_runner';
  content: string;
  roomId: string;
  timestamp: string;
  messageType: CocoMessageDraftType;
  username: 'Coco';
  status: 'complete' | 'error';
  turnId: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutputPreview?: string;
  exitCode?: number;
  isError?: boolean;
}

export interface CocoEventMapperContext {
  roomId: string;
  turnId: string;
  now?: Date;
  createMessageId?: (prefix: string) => string;
}

export type CocoMappedRunnerEvent =
  | { kind: 'message'; message: CocoMessageDraft }
  | { kind: 'ai_delta'; messageId: string; delta: string }
  | { kind: 'final'; messageId: string; answer: string; sessionId: string; usage?: CocoRunnerFinalEvent['usage'] }
  | { kind: 'ignored' };

const defaultCreateMessageId = (prefix: string) => `${prefix}_${Date.now()}`;

const timestampFor = (context: CocoEventMapperContext) => (context.now || new Date()).toISOString();

const stringifyArgs = (args: Record<string, unknown>) => {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return '[unserializable args]';
  }
};

const outputPreview = (output: string, truncated?: boolean) => {
  const suffix = truncated ? '\n[output truncated by runner]' : '';
  if (output.length <= 4096) {
    return `${output}${suffix}`;
  }
  return `${output.slice(0, 4096)}\n[display truncated]${suffix}`;
};

const mapTextDelta = (event: CocoRunnerTextDeltaEvent): CocoMappedRunnerEvent => ({
  kind: 'ai_delta',
  messageId: event.messageId,
  delta: event.delta,
});

const mapToolCall = (event: CocoRunnerToolCallEvent, context: CocoEventMapperContext): CocoMappedRunnerEvent => {
  const content = `${event.name} ${stringifyArgs(event.args)}`;
  return {
    kind: 'message',
    message: {
      id: event.messageId || event.id,
      clientId: 'coco_runner',
      content,
      roomId: context.roomId,
      timestamp: timestampFor(context),
      messageType: 'tool_call',
      username: 'Coco',
      status: 'complete',
      turnId: context.turnId,
      toolCallId: event.id,
      toolName: event.name,
      toolArgs: event.args,
    },
  };
};

const mapToolResult = (event: CocoRunnerToolResultEvent, context: CocoEventMapperContext): CocoMappedRunnerEvent => {
  const createMessageId = context.createMessageId || defaultCreateMessageId;
  const preview = outputPreview(event.output, event.truncated);
  return {
    kind: 'message',
    message: {
      id: event.messageId || createMessageId(`tool_result_${event.id}`),
      clientId: 'coco_runner',
      content: event.output,
      roomId: context.roomId,
      timestamp: timestampFor(context),
      messageType: 'tool_result',
      username: 'Coco',
      status: event.success ? 'complete' : 'error',
      turnId: context.turnId,
      toolCallId: event.id,
      toolName: event.name,
      toolOutputPreview: preview,
      exitCode: event.exitCode,
      isError: !event.success,
    },
  };
};

export const mapCocoRunnerEvent = (
  event: CocoRunnerEvent,
  context: CocoEventMapperContext
): CocoMappedRunnerEvent => {
  switch (event.type) {
    case 'text_delta':
      return mapTextDelta(event);
    case 'tool_call':
      return mapToolCall(event, context);
    case 'tool_result':
      return mapToolResult(event, context);
    case 'final':
      return {
        kind: 'final',
        messageId: event.messageId,
        answer: event.answer,
        sessionId: event.sessionId,
        usage: event.usage,
      };
    case 'error': {
      const createMessageId = context.createMessageId || defaultCreateMessageId;
      return {
        kind: 'message',
        message: {
          id: createMessageId('coco_error'),
          clientId: 'coco_runner',
          content: event.message,
          roomId: context.roomId,
          timestamp: timestampFor(context),
          messageType: 'sandbox_status',
          username: 'Coco',
          status: 'error',
          turnId: context.turnId,
          isError: true,
        },
      };
    }
    case 'status': {
      if (event.status === 'starting' || event.status === 'running' || event.status === 'ready' || event.status === 'complete') {
        return { kind: 'ignored' };
      }
      const createMessageId = context.createMessageId || defaultCreateMessageId;
      return {
        kind: 'message',
        message: {
          id: createMessageId(`coco_status_${event.status}`),
          clientId: 'coco_runner',
          content: event.message || event.status,
          roomId: context.roomId,
          timestamp: timestampFor(context),
          messageType: 'sandbox_status',
          username: 'Coco',
          status: event.status === 'error' ? 'error' : 'complete',
          turnId: context.turnId,
          isError: event.status === 'error',
        },
      };
    }
  }
};
