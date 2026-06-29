import { PassThrough, Writable } from 'stream';
import {
  E2BCommandResult,
  E2BFileEntry,
  E2BListedSandbox,
  E2BSandboxLifecyclePolicy,
  E2BSandboxDriver,
  E2BSandboxDriverHandle,
} from './e2bCocoSandboxService';

interface E2BSdkCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface E2BSdkCommandError extends Error {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

interface E2BSdkCommandHandle {
  pid: number;
  wait(): Promise<E2BSdkCommandResult>;
  kill(): Promise<boolean>;
}

interface E2BSdkCommands {
  run(command: string, options: {
    background: true;
    stdin: true;
    envs: Record<string, string>;
    timeoutMs?: number;
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  }): Promise<E2BSdkCommandHandle>;
  sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
  closeStdin?(pid: number): Promise<void>;
}

interface E2BSdkSandbox {
  sandboxId: string;
  getHost?(port: number): string;
  commands: E2BSdkCommands;
  files?: {
    list(path: string, opts?: { depth?: number }): Promise<E2BFileEntry[]>;
  };
  kill(): Promise<void>;
}

interface E2BSdkSandboxInfo {
  sandboxId: string;
  metadata: Record<string, string>;
}

interface E2BSdkPaginator {
  hasNext: boolean;
  nextItems(): Promise<E2BSdkSandboxInfo[]>;
}

interface E2BSdkSandboxClass {
  create(template: string, options: Record<string, unknown>): Promise<E2BSdkSandbox>;
  connect(sandboxId: string, options: Record<string, unknown>): Promise<E2BSdkSandbox>;
  list(options: Record<string, unknown>): E2BSdkPaginator;
}

export interface E2BSdkDriverOptions {
  apiKey?: string;
  accessToken?: string;
  domain?: string;
  apiUrl?: string;
  sandboxUrl?: string;
  requestTimeoutMs?: number;
  sandboxClass?: E2BSdkSandboxClass;
}

export const createE2BSdkDriver = (options: E2BSdkDriverOptions = {}): E2BSandboxDriver => {
  return new E2BSdkDriver(options);
};

class E2BSdkDriver implements E2BSandboxDriver {
  private sandboxClass?: E2BSdkSandboxClass;

  constructor(private readonly options: E2BSdkDriverOptions) {
    this.sandboxClass = options.sandboxClass;
  }

  async create(input: {
    templateId: string;
    timeoutMs: number;
    metadata: Record<string, string>;
    lifecycle?: E2BSandboxLifecyclePolicy;
  }): Promise<E2BSandboxDriverHandle> {
    const Sandbox = await this.loadSandboxClass();
    const sandbox = await Sandbox.create(input.templateId, {
      ...this.connectionOptions(),
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
      ...(input.lifecycle ? { lifecycle: sdkLifecycle(input.lifecycle) } : {}),
    });
    return this.wrapSandbox(sandbox);
  }

  async connect(sandboxId: string, input: { timeoutMs?: number } = {}): Promise<E2BSandboxDriverHandle> {
    const Sandbox = await this.loadSandboxClass();
    const sandbox = await Sandbox.connect(sandboxId, {
      ...this.connectionOptions(),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    return this.wrapSandbox(sandbox);
  }

  async list(input: { metadata?: Record<string, string> } = {}): Promise<E2BListedSandbox[]> {
    const Sandbox = await this.loadSandboxClass();
    const paginator = Sandbox.list({
      ...this.connectionOptions(),
      query: {
        metadata: input.metadata,
        state: ['running'],
      },
    });

    const sandboxes: E2BListedSandbox[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems();
      sandboxes.push(...page.map(item => ({
        id: item.sandboxId,
        metadata: item.metadata || {},
      })));
    }
    return sandboxes;
  }

  private async loadSandboxClass(): Promise<E2BSdkSandboxClass> {
    if (this.sandboxClass) {
      return this.sandboxClass;
    }
    const e2b = await import('e2b');
    const sandboxClass = (e2b as { Sandbox?: E2BSdkSandboxClass }).Sandbox;
    if (!sandboxClass) {
      throw new Error('E2B SDK Sandbox export is unavailable');
    }
    this.sandboxClass = sandboxClass;
    return this.sandboxClass;
  }

  private connectionOptions() {
    return Object.fromEntries(
      Object.entries({
        apiKey: this.options.apiKey,
        accessToken: this.options.accessToken,
        domain: this.options.domain,
        apiUrl: this.options.apiUrl,
        sandboxUrl: this.options.sandboxUrl,
        requestTimeoutMs: this.options.requestTimeoutMs,
      }).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== '')
    );
  }

  private wrapSandbox(sandbox: E2BSdkSandbox): E2BSandboxDriverHandle {
    return {
      id: sandbox.sandboxId,
      getHost: sandbox.getHost ? (port: number) => sandbox.getHost!(port) : undefined,
      commands: {
        run: (command, options) => startE2BCommand(sandbox, command, options?.env || {}, options?.timeoutMs),
      },
      files: sandbox.files
        ? {
            list: (path, options) => sandbox.files!.list(path, { depth: options?.depth }),
          }
        : undefined,
      kill: () => sandbox.kill(),
    };
  }
}

const sdkLifecycle = (policy: E2BSandboxLifecyclePolicy): Record<string, unknown> => {
  if (policy.onTimeout === 'kill') {
    return { onTimeout: 'kill' };
  }

  return {
    onTimeout: { action: 'pause', keepMemory: policy.keepMemory ?? true },
    ...(policy.autoResume !== undefined ? { autoResume: policy.autoResume } : {}),
  };
};

const startE2BCommand = async (
  sandbox: E2BSdkSandbox,
  command: string,
  env: Record<string, string>,
  timeoutMs?: number
): Promise<E2BCommandResult> => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commandHandle = await sandbox.commands.run(command, {
    background: true,
    stdin: true,
    envs: env,
    timeoutMs,
    onStdout: data => stdout.write(data),
    onStderr: data => stderr.write(data),
  });

  const completed = commandHandle.wait().then(
    result => ({ exitCode: result.exitCode, signal: null }),
    error => {
      if (isCommandExitError(error)) {
        return { exitCode: error.exitCode, signal: null };
      }
      throw error;
    }
  ).finally(() => {
    stdout.end();
    stderr.end();
  });

  return {
    pid: commandHandle.pid,
    stdin: createE2BStdin(sandbox, commandHandle.pid),
    stdout,
    stderr,
    completed,
    stop: async () => {
      await commandHandle.kill();
    },
  };
};

const createE2BStdin = (sandbox: E2BSdkSandbox, pid: number) => new Writable({
  write(chunk, encoding, callback) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    sandbox.commands.sendStdin(pid, data)
      .then(() => callback())
      .catch(callback);
  },
  final(callback) {
    // E2B v2 exposes closeStdin at runtime but marks it internal in types.
    // Guard it so a future SDK shape change does not break stream finalization.
    if (!sandbox.commands.closeStdin) {
      callback();
      return;
    }
    sandbox.commands.closeStdin(pid)
      .then(() => callback())
      .catch(error => {
        if (isE2BProcessAlreadyClosedError(error)) {
          callback();
          return;
        }
        callback(error);
      });
  },
});

const isCommandExitError = (error: unknown): error is E2BSdkCommandError & { exitCode: number } => (
  typeof error === 'object' &&
  error !== null &&
  typeof (error as E2BSdkCommandError).exitCode === 'number'
);

const isE2BProcessAlreadyClosedError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('[not_found]') && message.includes('process') && message.includes('not found');
};
