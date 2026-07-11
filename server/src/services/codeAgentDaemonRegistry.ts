import { CodeAgentRunnerProcess, CodeAgentSandboxHandle } from './codeAgentSandboxService';

interface TrackedDaemonProcess {
  realProcess: CodeAgentRunnerProcess;
  exposedProcess: CodeAgentRunnerProcess;
  stop(): Promise<void>;
}

export interface EnsureCodeAgentDaemonProcessInput {
  handle: CodeAgentSandboxHandle;
  command: string;
  env: Record<string, string>;
  start: (env: Record<string, string>) => Promise<CodeAgentRunnerProcess>;
}

export class CodeAgentDaemonProcessRegistry {
  private readonly processes = new Map<string, Promise<TrackedDaemonProcess>>();
  private shuttingDown = false;

  async ensure(input: EnsureCodeAgentDaemonProcessInput): Promise<CodeAgentRunnerProcess> {
    if (this.shuttingDown) {
      throw new Error('Code agent daemon registry is shutting down');
    }
    const existing = this.processes.get(input.handle.id);
    if (existing) {
      return (await existing).exposedProcess;
    }

    let pending!: Promise<TrackedDaemonProcess>;
    pending = input.start(baseDaemonEnv(input.env)).then(realProcess => {
      const exposedProcess: CodeAgentRunnerProcess = {
        ...realProcess,
        command: input.command,
        stop: async () => {},
      };
      let stopPromise: Promise<void> | undefined;
      const tracked: TrackedDaemonProcess = {
        realProcess,
        exposedProcess,
        stop: () => {
          stopPromise ||= realProcess.stop();
          return stopPromise;
        },
      };
      realProcess.completed?.then(
        () => this.remove(input.handle.id, pending),
        () => {
          this.remove(input.handle.id, pending);
          void tracked.stop().catch(() => {});
        }
      );
      return tracked;
    }, error => {
      this.remove(input.handle.id, pending);
      throw error;
    });
    this.processes.set(input.handle.id, pending);
    return (await pending).exposedProcess;
  }

  async shutdown(handle: CodeAgentSandboxHandle): Promise<void> {
    const pending = this.processes.get(handle.id);
    if (!pending) {
      return;
    }
    this.processes.delete(handle.id);
    const tracked = await pending;
    await tracked.stop();
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    const pending = Array.from(this.processes.values());
    this.processes.clear();
    await Promise.allSettled(pending.map(async process => {
      const tracked = await process;
      await tracked.stop();
    }));
  }

  private remove(sandboxId: string, pending: Promise<TrackedDaemonProcess>) {
    if (this.processes.get(sandboxId) === pending) {
      this.processes.delete(sandboxId);
    }
  }
}

const PER_TURN_ENV_KEYS = new Set([
  'ROOMTALK_CODEX_AUTH_JSON_PATH',
  'ROOMTALK_CODEX_REFRESHED_AUTH_JSON_PATH',
  'ROOMTALK_CODEX_AUTH_REFRESH_URL',
  'ROOMTALK_CODEX_AUTH_REFRESH_TOKEN',
  'ROOMTALK_CODEX_AUTH_VERSION',
  'ROOMTALK_MODEL_GATEWAY_TOKEN',
  'ROOMTALK_STATIC_PUBLISH_TOKEN',
  'ROOMTALK_STATIC_PUBLISH_URL',
  'ROOMTALK_STATIC_PUBLISH_PUBLIC_BASE_URL',
  'ROOMTALK_STATIC_PUBLISH_PUBLIC_URL',
  'ROOMTALK_STATIC_PUBLISH_MODE',
  'ROOMTALK_ROOM_CONTEXT_TOKEN',
  'ROOMTALK_ROOM_CONTEXT_URL',
]);

const baseDaemonEnv = (env: Record<string, string>) => Object.fromEntries(
  Object.entries(env).filter(([key]) => !PER_TURN_ENV_KEYS.has(key))
);
