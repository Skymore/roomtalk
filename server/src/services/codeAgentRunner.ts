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
  readonly backend: CodeAgentBackend;

  constructor(
    private readonly client: CocoRunnerClient,
    backend: CodeAgentBackend = 'coco'
  ) {
    this.backend = backend;
  }

  run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers,
    context?: CocoRunnerRunContext
  ): Promise<CocoRunnerRunResult> {
    return this.client.run(request, handlers, context);
  }
}

export interface CodeAgentRunnerFactoryOptions {
  /**
   * Long-term escape hatch for a dedicated Codex runner. Route 1 uses the
   * shared Coco JSONL runner client and swaps only the sandbox command.
   */
  codexRunner?: CodeAgentRunner;
}

export const createCodeAgentRunner = (
  backend: CodeAgentBackend,
  cocoClient: CocoRunnerClient,
  options: CodeAgentRunnerFactoryOptions = {}
): CodeAgentRunner => {
  switch (backend) {
    case 'coco':
      return new CocoCodeAgentRunner(cocoClient);
    case 'codex':
      if (options.codexRunner) {
        if (options.codexRunner.backend !== 'codex') {
          throw new Error('Configured Codex runner must report backend=codex');
        }
        return options.codexRunner;
      }
      return new CocoCodeAgentRunner(cocoClient, 'codex');
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported code-agent backend: ${exhaustive}`);
    }
  }
};
