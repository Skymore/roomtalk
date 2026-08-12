import {
  CodexConnectionError,
  CodexConnectionService,
  CodexDeviceAuthInfo,
} from './codexConnection';

export interface CodexDeviceAuthStartResult {
  clientId: string;
  provider: 'codex';
  status: 'pending';
  authVersion: number;
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
  private readonly activeSessions = new Map<string, {
    abortController: AbortController;
    authVersion?: number;
  }>();
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
    while (true) {
      const active = this.activeSessions.get(clientId);
      if (!active) {
        break;
      }
      const current = active.authVersion === undefined
        ? undefined
        : await this.connectionService.getConnectionStatus(clientId);
      if (this.activeSessions.get(clientId) !== active) {
        continue;
      }
      if (
        !current
        || (current.status === 'pending' && current.authVersion === active.authVersion)
      ) {
        throw new CodexConnectionError(`Codex device auth is already in progress for client ${clientId}.`, 'device_auth_in_progress');
      }
      active.abortController.abort();
      if (this.activeSessions.get(clientId) === active) {
        this.activeSessions.delete(clientId);
      }
      break;
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
      abortController.abort();
      rejectDeviceCode(new CodexConnectionError(
        `Codex device auth did not produce a device code within ${this.deviceCodeTimeoutMs}ms.`,
        'device_auth_code_unavailable'
      ));
    }, this.deviceCodeTimeoutMs);
    timeout.unref?.();

    const activeSession = {
      abortController,
      authVersion: undefined as number | undefined,
    };
    this.activeSessions.set(clientId, activeSession);

    void this.connectionService.connectWithDeviceAuth(clientId, async info => {
      if (!resolvedDeviceCode) {
        clearTimeout(timeout);
        settleDeviceCode(info);
      }
    }, {
      signal: abortController.signal,
      onAttemptStarted: authVersion => {
        activeSession.authVersion = authVersion;
      },
    }).catch(error => {
      clearTimeout(timeout);
      if (!resolvedDeviceCode) {
        rejectDeviceCode(error);
      }
      if (!(error instanceof CodexConnectionError && error.code === 'device_auth_cancelled')) {
        this.onBackgroundError?.(error, clientId);
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (this.activeSessions.get(clientId) === activeSession) {
        this.activeSessions.delete(clientId);
      }
    });

    const deviceAuth = await deviceCodePromise;
    return {
      clientId,
      provider: 'codex',
      status: 'pending',
      authVersion: activeSession.authVersion!,
      deviceAuth,
    };
  }

  async cancelDeviceAuth(clientId: string, expectedAuthVersion: number): Promise<CodexDeviceAuthCancelResult> {
    const active = this.activeSessions.get(clientId);
    const cancelled = await this.connectionService.cancelDeviceAuthAttempt(clientId, expectedAuthVersion);
    if (active?.authVersion === expectedAuthVersion) {
      active.abortController.abort();
    }
    return {
      clientId,
      provider: 'codex',
      cancelled,
    };
  }

  abortLocalDeviceAuth(clientId: string): boolean {
    const active = this.activeSessions.get(clientId);
    active?.abortController.abort();
    return Boolean(active);
  }
}
