import {
  COCO_RUNNER_SCHEMA_VERSION,
  CocoRunnerErrorEvent,
  CocoRunnerEvent,
  CocoRunnerFinalEvent,
  CocoRunnerJsonlParser,
  CocoRunnerProtocolError,
  CocoRunnerRunRequest,
  serializeCocoRunnerRequest,
} from './cocoRunnerProtocol';
import {
  CocoRunnerClient,
  CocoRunnerHandlers,
  CocoRunnerRunContext,
  CocoRunnerRunResult,
} from './fakeCocoRunner';

const STDERR_TAIL_CHARS = 4000;

export class JsonlCocoRunnerClient implements CocoRunnerClient {
  async run(
    request: CocoRunnerRunRequest,
    handlers: CocoRunnerHandlers,
    context?: CocoRunnerRunContext
  ): Promise<CocoRunnerRunResult> {
    const runnerProcess = context?.process;
    if (!runnerProcess?.stdin || !runnerProcess.stdout || !runnerProcess.completed || !context?.sandbox) {
      throw new Error('JsonlCocoRunnerClient requires a started runner process with stdin, stdout, completion, and sandbox context');
    }

    const stderrTail = collectStderrTail(runnerProcess.stderr);
    const completion = runnerProcess.completed.then(
      exit => ({ ok: true as const, exit }),
      error => ({ ok: false as const, error })
    );
    await writeRequest(runnerProcess.stdin, request);

    const events: CocoRunnerEvent[] = [];
    let finalEvent: CocoRunnerFinalEvent | undefined;
    let errorEvent: CocoRunnerErrorEvent | undefined;

    const emitEvent = async (event: CocoRunnerEvent) => {
      if (finalEvent || errorEvent) {
        const terminalType = finalEvent ? 'final' : 'error';
        throw new CocoRunnerProtocolError(`Coco runner emitted ${event.type} after terminal ${terminalType} event`);
      }
      events.push(event);
      if (event.type === 'final') {
        finalEvent = event;
      } else if (event.type === 'error') {
        errorEvent = event;
      }
      await handlers.onEvent(event);
    };

    try {
      const parser = new CocoRunnerJsonlParser();
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
      if (error instanceof CocoRunnerProtocolError) {
        return emitRunnerError(events, request, handlers, error.message, 'protocol_error');
      }
      throw error;
    }

    const completed = await completion;
    if (!completed.ok) {
      return emitRunnerError(
        events,
        request,
        handlers,
        `Coco runner process failed: ${completed.error instanceof Error ? completed.error.message : String(completed.error)}`,
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
      ? 'Coco runner exited without a final event'
      : `Coco runner exited before final event with code ${exitCode ?? 'null'}${signal ? ` and signal ${signal}` : ''}`;
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

const writeRequest = (stdin: NodeJS.WritableStream, request: CocoRunnerRunRequest) => {
  const serialized = serializeCocoRunnerRequest(request);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.removeListener('error', finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    stdin.once('error', finish);
    stdin.end(serialized, 'utf8', finish);
  });
};

const emitRunnerError = async (
  events: CocoRunnerEvent[],
  request: CocoRunnerRunRequest,
  handlers: CocoRunnerHandlers,
  message: string,
  code: string
): Promise<CocoRunnerRunResult> => {
  const errorEvent: CocoRunnerErrorEvent = {
    schemaVersion: COCO_RUNNER_SCHEMA_VERSION,
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

const bufferToString = (chunk: unknown) => {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
};
