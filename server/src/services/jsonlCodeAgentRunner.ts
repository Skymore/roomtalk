import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerErrorEvent,
  CodeAgentRunnerEvent,
  CodeAgentRunnerFinalEvent,
  CodeAgentRunnerJsonlParser,
  CodeAgentRunnerProtocolError,
  CodeAgentRunnerRequest,
  CodeAgentRunnerRunRequest,
  serializeCodeAgentRunnerRequest,
} from './codeAgentRunnerProtocol';
import {
  CodeAgentRunnerClient,
  CodeAgentRunnerHandlers,
  CodeAgentRunnerRunContext,
  CodeAgentRunnerRunResult,
} from './fakeCodeAgentRunner';

const STDERR_TAIL_CHARS = 4000;

export class JsonlCodeAgentRunnerClient implements CodeAgentRunnerClient {
  async run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers,
    context?: CodeAgentRunnerRunContext
  ): Promise<CodeAgentRunnerRunResult> {
    const runnerProcess = context?.process;
    if (!runnerProcess?.stdin || !runnerProcess.stdout || !runnerProcess.completed || !context?.sandbox) {
      throw new Error('JsonlCodeAgentRunnerClient requires a started runner process with stdin, stdout, completion, and sandbox context');
    }

    const stderrTail = collectStderrTail(runnerProcess.stderr);
    const completion = runnerProcess.completed.then(
      exit => ({ ok: true as const, exit }),
      error => ({ ok: false as const, error })
    );

    const events: CodeAgentRunnerEvent[] = [];
    let finalEvent: CodeAgentRunnerFinalEvent | undefined;
    let errorEvent: CodeAgentRunnerErrorEvent | undefined;

    const emitEvent = async (event: CodeAgentRunnerEvent) => {
      if (finalEvent || errorEvent) {
        const terminalType = finalEvent ? 'final' : 'error';
        throw new CodeAgentRunnerProtocolError(`code agent runner emitted ${event.type} after terminal ${terminalType} event`);
      }
      events.push(event);
      if (event.type === 'final') {
        finalEvent = event;
      } else if (event.type === 'error') {
        errorEvent = event;
      }
      await handlers.onEvent(event);
    };

    const writeError = await writeCodeAgentRunnerRequest(runnerProcess.stdin, request).then(
      () => undefined,
      error => error
    );
    if (writeError) {
      const completed = await completionWithin(completion, 500);
      const stderr = stderrTail();
      const details = [
        `code agent runner stdin write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        completed ? describeCompletion(completed) : 'runner process status was not available yet',
        stderr ? `stderr: ${stderr}` : '',
      ].filter(Boolean).join('; ');
      return emitRunnerError(events, request, handlers, details, 'runner_stdin_write_failed');
    }

    try {
      const parser = new CodeAgentRunnerJsonlParser();
      for await (const chunk of runnerProcess.stdout) {
        const parsedEvents = parser.push(bufferToString(chunk));
        for (const event of parsedEvents) {
          await emitEvent(event);
        }
      }
      for (const event of parser.flush()) {
        await emitEvent(event);
      }
    } catch (error) {
      if (error instanceof CodeAgentRunnerProtocolError) {
        return emitRunnerError(events, request, handlers, error.message, 'protocol_error');
      }
      throw error;
    }

    const completed = await completion;
    if (!completed.ok) {
      const stderr = stderrTail();
      const details = [
        `code agent runner process failed: ${describeUnknownError(completed.error)}`,
        stderr ? `stderr: ${stderr}` : '',
      ].filter(Boolean).join('; ');
      return emitRunnerError(
        events,
        request,
        handlers,
        details,
        'runner_process_error'
      );
    }
    const exitCode = completed.exit.exitCode;
    const signal = completed.exit.signal;

    if (errorEvent) {
      return { events, finalEvent, errorEvent };
    }
    if (finalEvent) {
      return { events, finalEvent };
    }

    const exitDescription = exitCode === 0
      ? 'code agent runner exited without a final event'
      : `code agent runner exited before final event with code ${exitCode ?? 'null'}${signal ? ` and signal ${signal}` : ''}`;
    const stderr = stderrTail();
    return emitRunnerError(
      events,
      request,
      handlers,
      stderr ? `${exitDescription}: ${stderr}` : exitDescription,
      exitCode === 0 ? 'missing_final' : 'runner_exit'
    );
  }
}

export const writeCodeAgentRunnerRequest = (stdin: NodeJS.WritableStream, request: CodeAgentRunnerRequest) => {
  const serialized = serializeCodeAgentRunnerRequest(request);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stdin.removeListener('error', onError);
    };
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        setImmediate(cleanup);
        reject(error);
      } else {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => finish(error);
    stdin.once('error', onError);
    stdin.write(serialized, 'utf8', finish);
  });
};

const emitRunnerError = async (
  events: CodeAgentRunnerEvent[],
  request: CodeAgentRunnerRunRequest,
  handlers: CodeAgentRunnerHandlers,
  message: string,
  code: string
): Promise<CodeAgentRunnerRunResult> => {
  const errorEvent: CodeAgentRunnerErrorEvent = {
    schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
    type: 'error',
    message,
    turnId: request.turnId,
    code,
    retryable: false,
  };
  events.push(errorEvent);
  await handlers.onEvent(errorEvent);
  return { events, errorEvent };
};

const collectStderrTail = (stderr: NodeJS.ReadableStream | undefined) => {
  let tail = '';
  if (!stderr) {
    return () => tail;
  }
  stderr.on('data', chunk => {
    tail = `${tail}${bufferToString(chunk)}`.slice(-STDERR_TAIL_CHARS);
  });
  return () => tail.trim();
};

const completionWithin = <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => (
  Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
);

const describeCompletion = (
  completed: { ok: true; exit: { exitCode: number | null; signal?: string | null } } | { ok: false; error: unknown }
): string => {
  if (!completed.ok) {
    return `runner process failed: ${describeUnknownError(completed.error)}`;
  }
  return `runner process exited with code ${completed.exit.exitCode ?? 'null'}${completed.exit.signal ? ` and signal ${completed.exit.signal}` : ''}`;
};

const describeUnknownError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const fields = Object.entries(error as Error & Record<string, unknown>)
    .filter(([key, value]) => (
      !['name', 'message', 'stack'].includes(key) &&
      value !== undefined &&
      typeof value !== 'function'
    ))
    .map(([key, value]) => `${key}=${stringifyErrorField(value)}`);
  return [
    error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message,
    ...fields,
    error.stack ? `stack=${error.stack}` : '',
  ].filter(Boolean).join('; ');
};

const stringifyErrorField = (value: unknown) => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const bufferToString = (chunk: unknown) => {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
};
