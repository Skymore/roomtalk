import {
  CocoRunnerErrorEvent,
  CocoRunnerEvent,
  CocoRunnerFinalEvent,
  CocoRunnerRunRequest,
  parseCocoRunnerEventLine,
} from './cocoRunnerProtocol';

export interface CocoRunnerClient {
  run(
    request: CocoRunnerRunRequest,
    handlers: { onEvent: (event: CocoRunnerEvent) => void | Promise<void> }
  ): Promise<CocoRunnerRunResult>;
}

export interface CocoRunnerRunResult {
  events: CocoRunnerEvent[];
  finalEvent?: CocoRunnerFinalEvent;
  errorEvent?: CocoRunnerErrorEvent;
}

export class FakeCocoRunnerClient implements CocoRunnerClient {
  readonly requests: CocoRunnerRunRequest[] = [];

  constructor(private readonly scriptedEvents: CocoRunnerEvent[]) {}

  async run(
    request: CocoRunnerRunRequest,
    handlers: { onEvent: (event: CocoRunnerEvent) => void | Promise<void> }
  ): Promise<CocoRunnerRunResult> {
    this.requests.push(request);
    const emitted: CocoRunnerEvent[] = [];
    let finalEvent: CocoRunnerFinalEvent | undefined;
    let errorEvent: CocoRunnerErrorEvent | undefined;

    for (const event of this.scriptedEvents) {
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
