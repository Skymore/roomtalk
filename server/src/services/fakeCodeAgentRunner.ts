import {
  CodeAgentRunnerErrorEvent,
  CodeAgentRunnerEvent,
  CodeAgentRunnerFinalEvent,
  CodeAgentRunnerRunRequest,
  parseCodeAgentRunnerEventLine,
} from './codeAgentRunnerProtocol';
import { CodeAgentRunnerProcess, CodeAgentSandboxHandle } from './codeAgentSandboxService';

export interface CodeAgentRunnerHandlers {
  onEvent: (event: CodeAgentRunnerEvent) => void | Promise<void>;
}

export interface CodeAgentRunnerRunContext {
  process: CodeAgentRunnerProcess;
  sandbox: CodeAgentSandboxHandle;
}

export interface CodeAgentRunnerClient {
  run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers,
    context?: CodeAgentRunnerRunContext
  ): Promise<CodeAgentRunnerRunResult>;
}

export interface CodeAgentRunnerRunResult {
  events: CodeAgentRunnerEvent[];
  finalEvent?: CodeAgentRunnerFinalEvent;
  errorEvent?: CodeAgentRunnerErrorEvent;
}

export class FakeCodeAgentRunnerClient implements CodeAgentRunnerClient {
  readonly requests: CodeAgentRunnerRunRequest[] = [];

  constructor(
    private readonly scriptedEvents: CodeAgentRunnerEvent[],
    private readonly options: { eventDelayMs?: number } = {}
  ) {}

  async run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers
  ): Promise<CodeAgentRunnerRunResult> {
    this.requests.push(request);
    const emitted: CodeAgentRunnerEvent[] = [];
    let finalEvent: CodeAgentRunnerFinalEvent | undefined;
    let errorEvent: CodeAgentRunnerErrorEvent | undefined;

    for (const event of this.scriptedEvents) {
      if (this.options.eventDelayMs && this.options.eventDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.options.eventDelayMs));
      }

      const cloned = cloneEvent(event);
      emitted.push(cloned);
      await handlers.onEvent(cloned);

      if (cloned.type === 'final') {
        finalEvent = cloned;
        break;
      }
      if (cloned.type === 'error') {
        errorEvent = cloned;
        break;
      }
    }

    return { events: emitted, finalEvent, errorEvent };
  }
}

const cloneEvent = (event: CodeAgentRunnerEvent): CodeAgentRunnerEvent => {
  return parseCodeAgentRunnerEventLine(JSON.stringify(event));
};
