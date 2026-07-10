import { CodeAgentBackend } from '../types';
import {
  CODE_AGENT_RUNNER_SCHEMA_VERSION,
  CodeAgentRunnerErrorEvent,
  CodeAgentRunnerEvent,
  CodeAgentRunnerFinalEvent,
  CodeAgentRunnerProtocolError,
  CodeAgentRunnerRunRequest,
  CodeAgentRunnerThreadListRequest,
  CodeAgentRunnerThreadListResultEvent,
  CodeAgentRunnerThreadReadRequest,
  CodeAgentRunnerThreadReadResultEvent,
} from './codeAgentRunnerProtocol';
import { CodeAgentRunnerProcess } from './codeAgentSandboxService';
import {
  CodeAgentDaemonBackend,
  CodeAgentDaemonThreadQueryRequest,
  CodeAgentDaemonJsonlParser,
  createCodeAgentDaemonRunRequest,
  createCodeAgentDaemonThreadQueryRequest,
  isCodeAgentDaemonControlEvent,
  isCodeAgentDaemonRunnerEvent,
  serializeCodeAgentDaemonRequest,
} from './codeAgentDaemonProtocol';
import {
  CodeAgentRunnerClient,
  CodeAgentRunnerHandlers,
  CodeAgentRunnerRunContext,
  CodeAgentRunnerRunResult,
} from './fakeCodeAgentRunner';

const STDERR_TAIL_CHARS = 4000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_TURN_RELEASE_TIMEOUT_MS = 10_000;

export type CodeAgentDaemonThreadQueryResult =
  | CodeAgentRunnerThreadListResultEvent
  | CodeAgentRunnerThreadReadResultEvent;

export class JsonlCodeAgentDaemonRunnerClient implements CodeAgentRunnerClient {
  private readonly connections = new WeakMap<CodeAgentRunnerProcess, DaemonConnection>();

  constructor(private readonly turnReleaseTimeoutMs = DAEMON_TURN_RELEASE_TIMEOUT_MS) {}

  async run(
    request: CodeAgentRunnerRunRequest,
    handlers: CodeAgentRunnerHandlers,
    context?: CodeAgentRunnerRunContext
  ): Promise<CodeAgentRunnerRunResult> {
    const process = context?.process;
    if (!process?.stdin || !process.stdout || !process.completed || !context?.sandbox) {
      throw new Error('JsonlCodeAgentDaemonRunnerClient requires a daemon process with stdin, stdout, completion, and sandbox context');
    }

    let connection = this.connections.get(process);
    if (!connection) {
      connection = new DaemonConnection(process, this.turnReleaseTimeoutMs);
      this.connections.set(process, connection);
    }
    await connection.ready();
    return connection.run(
      createCodeAgentDaemonRunRequest(
        request,
        daemonBackend(context.backend),
        context.runnerEnv
      ),
      handlers
    );
  }

  async query<T extends CodeAgentDaemonThreadQueryResult>(
    process: CodeAgentRunnerProcess,
    request: CodeAgentRunnerThreadListRequest | CodeAgentRunnerThreadReadRequest,
    expectedType: T['type'],
    env?: Record<string, string>
  ): Promise<T> {
    if (!process.stdin || !process.stdout || !process.completed) {
      throw new Error('JsonlCodeAgentDaemonRunnerClient requires a daemon process with stdin, stdout, and completion');
    }

    let connection = this.connections.get(process);
    if (!connection) {
      connection = new DaemonConnection(process, this.turnReleaseTimeoutMs);
      this.connections.set(process, connection);
    }
    await connection.ready();
    return connection.query(createCodeAgentDaemonThreadQueryRequest(request, env), expectedType);
  }
}

class DaemonConnection {
  private readonly parser = new CodeAgentDaemonJsonlParser();
  private readonly stderrTail: () => string;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private activeRun?: ActiveDaemonRun;
  private activeQuery?: ActiveDaemonQuery;
  private eventChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly process: CodeAgentRunnerProcess,
    private readonly turnReleaseTimeoutMs: number
  ) {
    this.stderrTail = collectStderrTail(process.stderr);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    process.stdout?.on('data', chunk => this.handleChunk(bufferToString(chunk)));
    process.stdout?.once('end', () => this.handleEnd());
    process.stdout?.once('error', error => this.failActive(error instanceof Error ? error : new Error(String(error))));
    process.completed?.then(
      exit => {
        if (exit.exitCode !== 0) {
          this.failActive(new Error(`sandbox daemon exited with code ${exit.exitCode ?? 'null'}${exit.signal ? ` and signal ${exit.signal}` : ''}`));
        }
      },
      error => {
        this.failActive(new Error(`sandbox daemon process failed: ${describeUnknownError(error)}`));
      }
    );
  }

  ready(): Promise<void> {
    return withTimeout(
      this.readyPromise,
      DAEMON_READY_TIMEOUT_MS,
      () => new Error(`sandbox daemon did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms`)
    );
  }

  async run(
    request: ReturnType<typeof createCodeAgentDaemonRunRequest>,
    handlers: CodeAgentRunnerHandlers
  ): Promise<CodeAgentRunnerRunResult> {
    if (this.closed) {
      return emitRunnerError([], request.turnId, handlers, 'sandbox daemon is closed', 'daemon_closed');
    }
    if (this.activeRun) {
      return emitRunnerError([], request.turnId, handlers, `sandbox daemon client is already running turn ${this.activeRun.turnId}`, 'daemon_busy');
    }
    if (this.activeQuery) {
      return emitRunnerError([], request.turnId, handlers, 'sandbox daemon client is already running a thread query', 'daemon_busy');
    }

    const activeRun = new ActiveDaemonRun(request.turnId, handlers, this.turnReleaseTimeoutMs);
    this.activeRun = activeRun;
    const writeError = await writeCodeAgentDaemonRequest(this.process.stdin!, request).then(
      () => undefined,
      error => error
    );
    if (writeError) {
      this.activeRun = undefined;
      const stderr = this.stderrTail();
      return emitRunnerError(
        [],
        request.turnId,
        handlers,
        [
          `sandbox daemon stdin write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
          stderr ? `stderr: ${stderr}` : '',
        ].filter(Boolean).join('; '),
        'daemon_stdin_write_failed'
      );
    }

    try {
      return await activeRun.result;
    } finally {
      if (this.activeRun === activeRun) {
        this.activeRun = undefined;
      }
    }
  }

  async query<T extends CodeAgentDaemonThreadQueryResult>(
    request: CodeAgentDaemonThreadQueryRequest,
    expectedType: T['type']
  ): Promise<T> {
    if (this.closed) {
      throw new Error('sandbox daemon is closed');
    }
    if (this.activeRun) {
      throw new Error(`sandbox daemon client is already running turn ${this.activeRun.turnId}`);
    }
    if (this.activeQuery) {
      throw new Error('sandbox daemon client is already running a thread query');
    }

    const activeQuery = new ActiveDaemonQuery(expectedType);
    this.activeQuery = activeQuery;
    const writeError = await writeCodeAgentDaemonRequest(this.process.stdin!, request).then(
      () => undefined,
      error => error
    );
    if (writeError) {
      this.activeQuery = undefined;
      const stderr = this.stderrTail();
      throw new Error([
        `sandbox daemon stdin write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        stderr ? `stderr: ${stderr}` : '',
      ].filter(Boolean).join('; '));
    }

    try {
      return await activeQuery.result as T;
    } finally {
      if (this.activeQuery === activeQuery) {
        this.activeQuery = undefined;
      }
    }
  }

  private handleChunk(chunk: string) {
    try {
      for (const event of this.parser.push(chunk)) {
        this.handleEvent(event);
      }
    } catch (error) {
      this.failActive(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleEnd() {
    this.closed = true;
    try {
      for (const event of this.parser.flush()) {
        this.handleEvent(event);
      }
    } catch (error) {
      this.failActive(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.failActive(new Error('sandbox daemon stdout ended'));
  }

  private handleEvent(event: ReturnType<CodeAgentDaemonJsonlParser['flush']>[number]) {
    if (isCodeAgentDaemonControlEvent(event)) {
      if (event.type === 'daemon_ready') {
        this.readyResolve();
      } else if (event.type === 'turn_released') {
        this.activeRun?.handleReleased(event.turnId);
      }
      return;
    }
    if (isCodeAgentDaemonRunnerEvent(event)) {
      const activeRun = this.activeRun;
      const activeQuery = this.activeQuery;
      if (!activeRun && !activeQuery) {
        return;
      }
      this.eventChain = this.eventChain
        .then(() => activeRun ? activeRun.handleEvent(event) : activeQuery!.handleEvent(event))
        .catch(error => this.failActive(error instanceof Error ? error : new Error(String(error))));
    }
  }

  private failActive(error: Error) {
    if (!this.closed && error.message.includes('stdout ended')) {
      this.closed = true;
    }
    this.readyReject(error);
    const active = this.activeRun;
    if (active) {
      this.activeRun = undefined;
      const stderr = this.stderrTail();
      active.fail(stderr ? `${error.message}; stderr: ${stderr}` : error.message, error instanceof CodeAgentRunnerProtocolError ? 'protocol_error' : 'daemon_process_error');
    }
    const activeQuery = this.activeQuery;
    if (activeQuery) {
      this.activeQuery = undefined;
      const stderr = this.stderrTail();
      activeQuery.fail(stderr ? `${error.message}; stderr: ${stderr}` : error.message);
    }
  }
}

class ActiveDaemonRun {
  readonly events: CodeAgentRunnerEvent[] = [];
  finalEvent?: CodeAgentRunnerFinalEvent;
  errorEvent?: CodeAgentRunnerErrorEvent;
  readonly result: Promise<CodeAgentRunnerRunResult>;
  private resolve!: (result: CodeAgentRunnerRunResult) => void;
  private released = false;
  private settled = false;
  private terminalHandled = false;
  private releaseTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly turnId: string,
    private readonly handlers: CodeAgentRunnerHandlers,
    private readonly releaseTimeoutMs: number
  ) {
    this.result = new Promise<CodeAgentRunnerRunResult>(resolve => {
      this.resolve = resolve;
    });
  }

  async handleEvent(event: CodeAgentRunnerEvent): Promise<void> {
    if (this.finalEvent || this.errorEvent) {
      const terminalType = this.finalEvent ? 'final' : 'error';
      throw new CodeAgentRunnerProtocolError(`sandbox daemon emitted ${event.type} after terminal ${terminalType} event`);
    }
    this.events.push(event);
    if (event.type === 'final') {
      this.finalEvent = event;
    } else if (event.type === 'error') {
      this.errorEvent = event;
    }
    await this.handlers.onEvent(event);
    if (this.finalEvent || this.errorEvent) {
      this.terminalHandled = true;
    }
    if (this.errorEvent && doesDaemonErrorBypassRelease(this.errorEvent.code)) {
      this.finish({ events: this.events, errorEvent: this.errorEvent });
      return;
    }
    if (this.released) {
      this.finishTerminal();
    } else if (this.finalEvent || this.errorEvent) {
      this.releaseTimer = setTimeout(() => this.finishTerminal(), Math.max(1, this.releaseTimeoutMs));
    }
  }

  handleReleased(turnId: string) {
    if (turnId !== this.turnId) {
      return;
    }
    this.released = true;
    this.finishTerminal();
  }

  fail(message: string, code: string) {
    if (this.settled) {
      return;
    }
    const errorEvent: CodeAgentRunnerErrorEvent = {
      schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
      type: 'error',
      turnId: this.turnId,
      message,
      code,
      retryable: false,
    };
    if (this.finalEvent || this.errorEvent) {
      this.finalEvent = undefined;
      this.errorEvent = errorEvent;
      this.events.push(errorEvent);
      this.finish({ events: this.events, errorEvent });
      return;
    }
    this.events.push(errorEvent);
    this.errorEvent = errorEvent;
    Promise.resolve(this.handlers.onEvent(errorEvent)).then(
      () => this.finish({ events: this.events, errorEvent }),
      () => this.finish({ events: this.events, errorEvent })
    );
  }

  private finishTerminal() {
    if (this.terminalHandled && (this.finalEvent || this.errorEvent)) {
      this.finish({ events: this.events, finalEvent: this.finalEvent, errorEvent: this.errorEvent });
    }
  }

  private finish(result: CodeAgentRunnerRunResult) {
    if (this.settled) return;
    this.settled = true;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.resolve(result);
  }
}

const doesDaemonErrorBypassRelease = (code: string | undefined): boolean => (
  code === 'daemon_busy'
  || code === 'invalid_json'
  || code === 'invalid_request'
  || code === 'unsupported_daemon_request'
  || code === 'unsupported_backend'
);

class ActiveDaemonQuery {
  readonly result: Promise<CodeAgentDaemonThreadQueryResult>;
  private resolve!: (event: CodeAgentDaemonThreadQueryResult) => void;
  private reject!: (error: Error) => void;

  constructor(private readonly expectedType: CodeAgentDaemonThreadQueryResult['type']) {
    this.result = new Promise<CodeAgentDaemonThreadQueryResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  async handleEvent(event: CodeAgentRunnerEvent): Promise<void> {
    if (event.type === 'error') {
      this.reject(new Error(event.message));
      return;
    }
    if (event.type === this.expectedType) {
      this.resolve(event as CodeAgentDaemonThreadQueryResult);
    }
  }

  fail(message: string) {
    this.reject(new Error(message));
  }
}

export const writeCodeAgentDaemonRequest = (stdin: NodeJS.WritableStream, request: Parameters<typeof serializeCodeAgentDaemonRequest>[0]) => {
  const serialized = serializeCodeAgentDaemonRequest(request);
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

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(createError()), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
};

const emitRunnerError = async (
  events: CodeAgentRunnerEvent[],
  turnId: string,
  handlers: CodeAgentRunnerHandlers,
  message: string,
  code: string
): Promise<CodeAgentRunnerRunResult> => {
  const errorEvent: CodeAgentRunnerErrorEvent = {
    schemaVersion: CODE_AGENT_RUNNER_SCHEMA_VERSION,
    type: 'error',
    turnId,
    message,
    code,
    retryable: false,
  };
  events.push(errorEvent);
  await handlers.onEvent(errorEvent);
  return { events, errorEvent };
};

const daemonBackend = (backend?: CodeAgentBackend): CodeAgentDaemonBackend => {
  if (backend === 'codex' || backend === 'codex-app-server') {
    return backend;
  }
  return 'code-agent';
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
