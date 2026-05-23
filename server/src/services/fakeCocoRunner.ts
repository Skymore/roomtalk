import {
  CocoRunnerErrorEvent,
  CocoRunnerEvent,
  CocoRunnerFinalEvent,
  CocoRunnerRunRequest,
  parseCocoRunnerEventLine,
} from './cocoRunnerProtocol';
import { CocoRunnerProcess, CocoSandboxHandle } from './cocoSandboxService';

export interface CocoRunnerHandlers {
  onEvent: (event: CocoRunnerEvent) => void | Promise<void>;
}

export interface CocoRunnerRunContext {
  process: CocoRunnerProcess;
  sandbox: CocoSandboxHandle;
}

export interface CocoRunnerClient {
  run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers,
    context?: CocoRunnerRunContext
  ): Promise<CocoRunnerRunResult>;
}

export interface CocoRunnerRunResult {
  events: CocoRunnerEvent[];
  finalEvent?: CocoRunnerFinalEvent;
  errorEvent?: CocoRunnerErrorEvent;
}

export class FakeCocoRunnerClient implements CocoRunnerClient {
  readonly requests: CocoRunnerRunRequest[] = [];

  constructor(
    private readonly scriptedEvents: CocoRunnerEvent[],
    private readonly options: { eventDelayMs?: number } = {}
  ) {}

  async run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers
  ): Promise<CocoRunnerRunResult> {
    this.requests.push(request);
    const emitted: CocoRunnerEvent[] = [];
    let finalEvent: CocoRunnerFinalEvent | undefined;
    let errorEvent: CocoRunnerErrorEvent | undefined;

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

const cloneEvent = (event: CocoRunnerEvent): CocoRunnerEvent => {
  return parseCocoRunnerEventLine(JSON.stringify(event));
};
