import {
  CodeAgentRunnerEvent,
  CodeAgentRunnerApprovalRequestEvent,
  CodeAgentRunnerFinalEvent,
  CodeAgentRunnerTextDeltaEvent,
  CodeAgentRunnerToolCallEvent,
  CodeAgentRunnerToolResultEvent,
} from './codeAgentRunnerProtocol';
import { AICost, AIUsage, Message } from '../types';

export type CodeAgentMessageDraftType = 'tool_call' | 'tool_result' | 'sandbox_status';

export interface CodeAgentMessageDraft {
  id: string;
  clientId: string;
  content: string;
  roomId: string;
  timestamp: string;
  messageType: CodeAgentMessageDraftType;
  username: string;
  status: 'complete' | 'error';
  turnId: string;
  modelStepId?: string;
  modelStepSequence?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutputPreview?: string;
  exitCode?: number;
  isError?: boolean;
  aiModel?: Message['aiModel'];
  usage?: AIUsage;
  cost?: AICost;
  codeAgentMode?: 'plan' | 'edit' | 'approveForMe' | 'fullAccess' | 'acceptEdits';
}

export interface CodeAgentEventMapperContext {
  roomId: string;
  turnId: string;
  clientId?: string;
  username?: string;
  now?: Date;
  createMessageId?: (prefix: string) => string;
}

export type CodeAgentMappedRunnerEvent =
  | { kind: 'message'; message: CodeAgentMessageDraft }
  | { kind: 'ai_delta'; messageId: string; delta: string }
  | { kind: 'final'; messageId: string; answer: string; sessionId: string; usage?: CodeAgentRunnerFinalEvent['usage'] }
  | { kind: 'ignored' };

const defaultCreateMessageId = (prefix: string) => `${prefix}_${Date.now()}`;

const timestampFor = (context: CodeAgentEventMapperContext) => (context.now || new Date()).toISOString();
const clientIdFor = (context: CodeAgentEventMapperContext) => context.clientId || 'code_agent_runner';
const usernameFor = (context: CodeAgentEventMapperContext) => context.username || 'Coco';

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

const mapTextDelta = (event: CodeAgentRunnerTextDeltaEvent): CodeAgentMappedRunnerEvent => ({
  kind: 'ai_delta',
  messageId: event.messageId,
  delta: event.delta,
});

const mapToolCall = (event: CodeAgentRunnerToolCallEvent, context: CodeAgentEventMapperContext): CodeAgentMappedRunnerEvent => {
  const content = `${event.name} ${stringifyArgs(event.args)}`;
  return {
    kind: 'message',
    message: {
      id: event.messageId || event.id,
      clientId: clientIdFor(context),
      content,
      roomId: context.roomId,
      timestamp: timestampFor(context),
      messageType: 'tool_call',
      username: usernameFor(context),
      status: 'complete',
      turnId: context.turnId,
      toolCallId: event.id,
      toolName: event.name,
      toolArgs: event.args,
    },
  };
};

const mapToolResult = (event: CodeAgentRunnerToolResultEvent, context: CodeAgentEventMapperContext): CodeAgentMappedRunnerEvent => {
  const createMessageId = context.createMessageId || defaultCreateMessageId;
  const preview = outputPreview(event.output, event.truncated);
  return {
    kind: 'message',
    message: {
      id: event.messageId || createMessageId(`tool_result_${event.id}`),
      clientId: clientIdFor(context),
      content: event.output,
      roomId: context.roomId,
      timestamp: timestampFor(context),
      messageType: 'tool_result',
      username: usernameFor(context),
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

const mapApprovalRequest = (event: CodeAgentRunnerApprovalRequestEvent, context: CodeAgentEventMapperContext): CodeAgentMappedRunnerEvent => {
  const content = `${event.title}${event.message ? `\n${event.message}` : ''}`;
  return {
    kind: 'message',
    message: {
      id: event.messageId || event.id,
      clientId: clientIdFor(context),
      content,
      roomId: context.roomId,
      timestamp: timestampFor(context),
      messageType: 'tool_call',
      username: usernameFor(context),
      status: 'complete',
      turnId: context.turnId,
      toolCallId: event.id,
      toolName: 'approval_request',
      toolArgs: {
        ...event.args,
        approvalId: event.id,
        approvalType: event.approvalType,
        title: event.title,
        message: event.message,
      },
    },
  };
};

export const mapCodeAgentRunnerEvent = (
  event: CodeAgentRunnerEvent,
  context: CodeAgentEventMapperContext
): CodeAgentMappedRunnerEvent => {
  switch (event.type) {
    case 'text_delta':
      return mapTextDelta(event);
    case 'tool_call':
      return mapToolCall(event, context);
    case 'tool_result':
      return mapToolResult(event, context);
    case 'approval_request':
      return mapApprovalRequest(event, context);
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
          id: createMessageId('code_agent_error'),
          clientId: clientIdFor(context),
          content: event.message,
          roomId: context.roomId,
          timestamp: timestampFor(context),
          messageType: 'sandbox_status',
          username: usernameFor(context),
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
          id: createMessageId(`code_agent_status_${event.status}`),
          clientId: clientIdFor(context),
          content: event.message || event.status,
          roomId: context.roomId,
          timestamp: timestampFor(context),
          messageType: 'sandbox_status',
          username: usernameFor(context),
          status: event.status === 'error' ? 'error' : 'complete',
          turnId: context.turnId,
          isError: event.status === 'error',
        },
      };
    }
    case 'thread_list_result':
    case 'thread_read_result':
    case 'control_result':
    case 'user_input_inserted':
    case 'model_step':
    case 'usage':
      return { kind: 'ignored' };
  }
};
