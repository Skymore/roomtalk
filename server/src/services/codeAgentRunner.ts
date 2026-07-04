import { CodeAgentRunnerRunRequest } from './codeAgentRunnerProtocol';
import {
  CodeAgentRunnerClient,
  CodeAgentRunnerHandlers,
  CodeAgentRunnerRunContext,
  CodeAgentRunnerRunResult,
} from './fakeCodeAgentRunner';
import type { CodeAgentBackend } from '../types';

export type { CodeAgentBackend } from '../types';

export interface CodeAgentRunner {
  readonly backend: CodeAgentBackend;
  run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers,
    context?: CodeAgentRunnerRunContext
  ): Promise<CodeAgentRunnerRunResult>;
}

export class CodeAgentRunnerAdapter implements CodeAgentRunner {
  readonly backend: CodeAgentBackend;

  constructor(
    private readonly client: CodeAgentRunnerClient,
    backend: CodeAgentBackend = 'coco'
  ) {
    this.backend = backend;
  }

  run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers,
    context?: CodeAgentRunnerRunContext
  ): Promise<CodeAgentRunnerRunResult> {
    return this.client.run(request, handlers, context);
  }
}

export interface CodeAgentRunnerFactoryOptions {
  /**
   * Escape hatch for a backend-specific runner. The current CLI path shares
   * one JSONL runner client and swaps only the sandbox command/env.
   */
  codexRunner?: CodeAgentRunner;
}

export const createCodeAgentRunner = (
  backend: CodeAgentBackend,
  sharedClient: CodeAgentRunnerClient,
  options: CodeAgentRunnerFactoryOptions = {}
): CodeAgentRunner => {
  switch (backend) {
    case 'coco':
      return new CodeAgentRunnerAdapter(sharedClient);
    case 'codex':
      if (options.codexRunner) {
        if (options.codexRunner.backend !== 'codex') {
          throw new Error('Configured Codex runner must report backend=codex');
        }
        return options.codexRunner;
      }
      return new CodeAgentRunnerAdapter(sharedClient, 'codex');
    case 'codex-app-server':
      return new CodeAgentRunnerAdapter(sharedClient, 'codex-app-server');
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unsupported code-agent backend: ${exhaustive}`);
    }
  }
};
