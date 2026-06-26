import { CocoRunnerRunRequest } from './cocoRunnerProtocol';
import {
  CocoRunnerClient,
  CocoRunnerHandlers,
  CocoRunnerRunContext,
  CocoRunnerRunResult,
} from './fakeCocoRunner';

export type CodeAgentBackend = 'coco' | 'codex';

export interface CodeAgentRunner {
  readonly backend: CodeAgentBackend;
  run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers,
    context?: CocoRunnerRunContext
  ): Promise<CocoRunnerRunResult>;
}

export class CocoCodeAgentRunner implements CodeAgentRunner {
  readonly backend = 'coco' as const;

  constructor(private readonly client: CocoRunnerClient) {}

  run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers,
    context?: CocoRunnerRunContext
  ): Promise<CocoRunnerRunResult> {
    return this.client.run(request, handlers, context);
  }
}

export const createCodeAgentRunner = (
  backend: CodeAgentBackend,
  cocoClient: CocoRunnerClient
): CodeAgentRunner => {
  switch (backend) {
    case 'coco':
      return new CocoCodeAgentRunner(cocoClient);
    case 'codex':
      throw new Error(`Code-agent backend is not implemented: ${backend}`);
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported code-agent backend: ${exhaustive}`);
    }
  }
};
