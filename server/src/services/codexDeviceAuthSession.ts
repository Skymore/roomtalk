import {
  CodexConnectionError,
  CodexConnectionService,
  CodexDeviceAuthInfo,
} from './codexConnection';

export interface CodexDeviceAuthStartResult {
  clientId: string;
  provider: 'codex';
  status: 'pending';
  deviceAuth: CodexDeviceAuthInfo;
}

export interface CodexDeviceAuthCancelResult {
  clientId: string;
  provider: 'codex';
  cancelled: boolean;
}

export interface CodexDeviceAuthSessionManagerOptions {
  deviceCodeTimeoutMs?: number;
  onBackgroundError?: (error: unknown, clientId: string) => void;
}

const DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30_000;

export class CodexDeviceAuthSessionManager {
  private readonly activeSessions = new Map<string, { abortController: AbortController; done: Promise<void> }>();
  private readonly deviceCodeTimeoutMs: number;
  private readonly onBackgroundError?: (error: unknown, clientId: string) => void;

  constructor(
    private readonly connectionService: CodexConnectionService,
    options: CodexDeviceAuthSessionManagerOptions = {}
  ) {
    this.deviceCodeTimeoutMs = options.deviceCodeTimeoutMs || DEFAULT_DEVICE_CODE_TIMEOUT_MS;
    this.onBackgroundError = options.onBackgroundError;
  }

  async startDeviceAuth(clientId: string): Promise<CodexDeviceAuthStartResult> {
    if (this.activeSessions.has(clientId)) {
      throw new CodexConnectionError(`Codex device auth is already in progress for client ${clientId}.`, 'device_auth_in_progress');
    }

    const abortController = new AbortController();
    let resolvedDeviceCode = false;
    let settleDeviceCode: (info: CodexDeviceAuthInfo) => void = () => undefined;
    let rejectDeviceCode: (error: unknown) => void = () => undefined;
    const deviceCodePromise = new Promise<CodexDeviceAuthInfo>((resolve, reject) => {
      settleDeviceCode = info => {
        resolvedDeviceCode = true;
        resolve(info);
      };
      rejectDeviceCode = reject;
    });

    const timeout = setTimeout(() => {
      rejectDeviceCode(new CodexConnectionError(
        `Codex device auth did not produce a device code within ${this.deviceCodeTimeoutMs}ms.`,
        'device_auth_code_unavailable'
      ));
    }, this.deviceCodeTimeoutMs);
    timeout.unref?.();

    const done = this.connectionService.connectWithDeviceAuth(clientId, async info => {
      if (!resolvedDeviceCode) {
        clearTimeout(timeout);
        settleDeviceCode(info);
      }
    }, { signal: abortController.signal }).catch(error => {
      clearTimeout(timeout);
      if (!resolvedDeviceCode) {
        rejectDeviceCode(error);
      }
      if (!(error instanceof CodexConnectionError && error.code === 'device_auth_cancelled')) {
        this.onBackgroundError?.(error, clientId);
      }
    }).finally(() => {
      clearTimeout(timeout);
      this.activeSessions.delete(clientId);
    });
    this.activeSessions.set(clientId, { abortController, done: done.then(() => undefined) });

    const deviceAuth = await deviceCodePromise;
    return {
      clientId,
      provider: 'codex',
      status: 'pending',
      deviceAuth,
    };
  }

  async cancelDeviceAuth(clientId: string): Promise<CodexDeviceAuthCancelResult> {
    const active = this.activeSessions.get(clientId);
    if (!active) {
      return {
        clientId,
        provider: 'codex',
        cancelled: false,
      };
    }
    active.abortController.abort();
    await active.done;
    return {
      clientId,
      provider: 'codex',
      cancelled: true,
    };
  }
}
