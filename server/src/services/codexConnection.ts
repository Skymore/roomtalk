import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export type CodexConnectionStatus = 'pending' | 'connected' | 'reauth_required' | 'disconnected';

export interface CodexEncryptedAuthJson {
  algorithm: 'aes-256-gcm';
  keyVersion: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CodexConnectionRecord {
  clientId: string;
  provider: 'codex';
  status: CodexConnectionStatus;
  encryptedAuthJson?: CodexEncryptedAuthJson;
  authVersion: number;
  keyVersion: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  activeRunId?: string;
  lockedUntil?: string;
  lastError?: string;
}

export interface CodexConnectionAccountSummary {
  email?: string;
  name?: string;
  accountId?: string;
  userId?: string;
  planType?: string;
}

export interface CodexConnectionPublicStatus {
  clientId: string;
  provider: 'codex';
  status: CodexConnectionStatus;
  authVersion: number;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  locked: boolean;
  lastError?: string;
  account?: CodexConnectionAccountSummary;
}

export interface CodexDeviceAuthInfo {
  url: string;
  code: string;
  expiresAt?: string;
}

export interface CodexDeviceAuthResult {
  authJson: string;
  loginStatus: string;
}

export interface CodexDeviceAuthDriver {
  runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<CodexDeviceAuthResult>;
}

export interface CodexAuthWorkResult<T> {
  result: T;
  refreshedAuthJson?: string;
  loginStatus?: string;
}

export interface CodexConnectionStore {
  getConnection(clientId: string): Promise<CodexConnectionRecord | null>;
  saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord>;
  deleteConnection(clientId: string): Promise<boolean>;
  acquireConnectionLock(clientId: string, runId: string, lockedUntil: string, now: string): Promise<CodexConnectionRecord | null>;
  releaseConnectionLock(clientId: string, runId: string, now: string): Promise<CodexConnectionRecord | null>;
}

export type CodexConnectionErrorCode =
  | 'connection_not_found'
  | 'connection_not_ready'
  | 'connection_locked'
  | 'device_auth_in_progress'
  | 'device_auth_code_unavailable'
  | 'device_auth_cancelled'
  | 'device_auth_failed'
  | 'auth_secret_missing'
  | 'auth_decrypt_failed';

export class CodexConnectionError extends Error {
  constructor(message: string, readonly code: CodexConnectionErrorCode) {
    super(message);
    this.name = 'CodexConnectionError';
  }
}

export class CodexAuthCipher {
  private readonly key: Buffer;

  constructor(
    secret: string | undefined,
    readonly keyVersion = 'v1'
  ) {
    if (!secret || !secret.trim()) {
      throw new CodexConnectionError('Codex auth encryption secret is required.', 'auth_secret_missing');
    }
    this.key = createHash('sha256').update(secret).digest();
  }

  encryptAuthJson(authJson: string): CodexEncryptedAuthJson {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(authJson, 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      keyVersion: this.keyVersion,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decryptAuthJson(blob: CodexEncryptedAuthJson): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(blob.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      throw new CodexConnectionError('Unable to decrypt Codex auth.', 'auth_decrypt_failed');
    }
  }
}

export interface CodexConnectionServiceOptions {
  lockTtlMs?: number;
  now?: () => Date;
}

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

export class CodexConnectionService {
  private readonly lockTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: CodexConnectionStore,
    private readonly cipher: CodexAuthCipher,
    private readonly deviceAuthDriver: CodexDeviceAuthDriver,
    options: CodexConnectionServiceOptions = {}
  ) {
    this.lockTtlMs = options.lockTtlMs || DEFAULT_LOCK_TTL_MS;
    this.now = options.now || (() => new Date());
  }

  async connectWithDeviceAuth(
    clientId: string,
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>,
    options: { signal?: AbortSignal } = {}
  ): Promise<CodexConnectionPublicStatus> {
    const existing = await this.store.getConnection(clientId);
    const createdAt = existing?.createdAt || this.timestamp();
    const pending = await this.store.saveConnection({
      clientId,
      provider: 'codex',
      status: 'pending',
      encryptedAuthJson: existing?.encryptedAuthJson,
      authVersion: existing?.authVersion || 0,
      keyVersion: this.cipher.keyVersion,
      createdAt,
      updatedAt: this.timestamp(),
      lastValidatedAt: existing?.lastValidatedAt,
      lastUsedAt: existing?.lastUsedAt,
    });

    try {
      const result = await this.deviceAuthDriver.runDeviceAuth({ clientId, onDeviceCode, signal: options.signal });
      const connected = await this.store.saveConnection({
        ...pending,
        status: 'connected',
        encryptedAuthJson: this.cipher.encryptAuthJson(result.authJson),
        authVersion: pending.authVersion + 1,
        keyVersion: this.cipher.keyVersion,
        updatedAt: this.timestamp(),
        lastValidatedAt: this.timestamp(),
        lastError: undefined,
      });
      return publicStatus(connected, this.now(), summarizeCodexAuthAccount(result.authJson));
    } catch (error) {
      if (isCodexConnectionError(error, 'device_auth_cancelled') || options.signal?.aborted) {
        if (existing) {
          await this.store.saveConnection({
            ...existing,
            activeRunId: undefined,
            lockedUntil: undefined,
            lastError: undefined,
            updatedAt: this.timestamp(),
          });
        } else {
          await this.store.deleteConnection(clientId);
        }
        throw new CodexConnectionError(`Codex device auth was cancelled for client ${clientId}.`, 'device_auth_cancelled');
      }
      const failed = await this.store.saveConnection({
        ...pending,
        status: 'reauth_required',
        updatedAt: this.timestamp(),
        lastError: 'Codex device auth failed',
      });
      throw new CodexConnectionError(`Codex device auth failed for client ${clientId}.`, 'device_auth_failed');
    }
  }

  async getConnectionStatus(clientId: string): Promise<CodexConnectionPublicStatus> {
    const record = await this.store.getConnection(clientId);
    if (!record) {
      return {
        clientId,
        provider: 'codex',
        status: 'disconnected',
        authVersion: 0,
        createdAt: '',
        updatedAt: '',
        locked: false,
      };
    }
    return publicStatus(record, this.now(), this.accountSummaryForRecord(record));
  }

  async disconnect(clientId: string): Promise<CodexConnectionPublicStatus> {
    await this.store.deleteConnection(clientId);
    return this.getConnectionStatus(clientId);
  }

  async withCodexAuth<T>(
    clientId: string,
    runId: string,
    work: (authJson: string) => Promise<CodexAuthWorkResult<T>>
  ): Promise<T> {
    const now = this.now();
    const lockedUntil = new Date(now.getTime() + this.lockTtlMs).toISOString();
    const locked = await this.store.acquireConnectionLock(clientId, runId, lockedUntil, now.toISOString());
    if (!locked) {
      const current = await this.store.getConnection(clientId);
      if (!current) {
        throw new CodexConnectionError(`No Codex connection found for client ${clientId}.`, 'connection_not_found');
      }
      if (isLocked(current, now)) {
        throw new CodexConnectionError(`Codex connection is already in use for client ${clientId}.`, 'connection_locked');
      }
      throw new CodexConnectionError(`Codex connection is not ready for client ${clientId}.`, 'connection_not_ready');
    }

    try {
      if (locked.status !== 'connected' || !locked.encryptedAuthJson) {
        throw new CodexConnectionError(`Codex connection is not ready for client ${clientId}.`, 'connection_not_ready');
      }
      const authJson = this.cipher.decryptAuthJson(locked.encryptedAuthJson);
      const workResult = await work(authJson);
      const updatedAt = this.timestamp();
      await this.store.saveConnection({
        ...locked,
        encryptedAuthJson: workResult.refreshedAuthJson
          ? this.cipher.encryptAuthJson(workResult.refreshedAuthJson)
          : locked.encryptedAuthJson,
        authVersion: workResult.refreshedAuthJson ? locked.authVersion + 1 : locked.authVersion,
        keyVersion: this.cipher.keyVersion,
        updatedAt,
        lastUsedAt: updatedAt,
        lastValidatedAt: workResult.loginStatus ? updatedAt : locked.lastValidatedAt,
        activeRunId: runId,
        lockedUntil,
        status: 'connected',
        lastError: undefined,
      });
      return workResult.result;
    } finally {
      await this.store.releaseConnectionLock(clientId, runId, this.timestamp());
    }
  }

  private timestamp() {
    return this.now().toISOString();
  }

  private accountSummaryForRecord(record: CodexConnectionRecord): CodexConnectionAccountSummary | undefined {
    if (!record.encryptedAuthJson) {
      return undefined;
    }
    try {
      return summarizeCodexAuthAccount(this.cipher.decryptAuthJson(record.encryptedAuthJson));
    } catch {
      return undefined;
    }
  }
}

const isCodexConnectionError = (error: unknown, code: CodexConnectionErrorCode) => (
  error instanceof CodexConnectionError && error.code === code
);

export class InMemoryCodexConnectionStore implements CodexConnectionStore {
  private readonly records = new Map<string, CodexConnectionRecord>();

  async getConnection(clientId: string): Promise<CodexConnectionRecord | null> {
    return cloneRecord(this.records.get(clientId) || null);
  }

  async saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord> {
    const cloned = cloneRecord(record)!;
    this.records.set(record.clientId, cloned);
    return cloneRecord(cloned)!;
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    return this.records.delete(clientId);
  }

  async acquireConnectionLock(
    clientId: string,
    runId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record || record.status !== 'connected' || !record.encryptedAuthJson) {
      return null;
    }
    if (isLocked(record, new Date(now)) && record.activeRunId !== runId) {
      return null;
    }
    const updated: CodexConnectionRecord = {
      ...record,
      activeRunId: runId,
      lockedUntil,
      updatedAt: now,
    };
    this.records.set(clientId, updated);
    return cloneRecord(updated)!;
  }

  async releaseConnectionLock(clientId: string, runId: string, now: string): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record || record.activeRunId !== runId) {
      return cloneRecord(record || null);
    }
    const updated: CodexConnectionRecord = {
      ...record,
      activeRunId: undefined,
      lockedUntil: undefined,
      updatedAt: now,
    };
    this.records.set(clientId, updated);
    return cloneRecord(updated)!;
  }
}

const publicStatus = (
  record: CodexConnectionRecord,
  now: Date,
  account?: CodexConnectionAccountSummary
): CodexConnectionPublicStatus => ({
  clientId: record.clientId,
  provider: 'codex',
  status: record.status,
  authVersion: record.authVersion,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  lastValidatedAt: record.lastValidatedAt,
  lastUsedAt: record.lastUsedAt,
  locked: isLocked(record, now),
  lastError: record.lastError,
  ...(account ? { account } : {}),
});

export const summarizeCodexAuthAccount = (authJson: string): CodexConnectionAccountSummary | undefined => {
  const parsed = parseJsonObject(authJson);
  if (!parsed) {
    return undefined;
  }

  const openaiAuth = objectValue(parsed.OPENAI_AUTH) || objectValue(parsed.openaiAuth);
  const tokens = objectValue(parsed.tokens) || objectValue(openaiAuth?.tokens) || openaiAuth || parsed;
  const idClaims = decodeJwtPayload(stringValue(tokens.id_token) || stringValue(tokens.idToken) || stringValue(parsed.id_token));
  const accessClaims = decodeJwtPayload(stringValue(tokens.access_token) || stringValue(tokens.accessToken) || stringValue(parsed.access_token));
  const authClaim = objectValue(idClaims?.['https://api.openai.com/auth'])
    || objectValue(accessClaims?.['https://api.openai.com/auth']);
  const profileClaim = objectValue(accessClaims?.['https://api.openai.com/profile'])
    || objectValue(idClaims?.['https://api.openai.com/profile']);

  const summary: CodexConnectionAccountSummary = {
    email: firstString(idClaims?.email, profileClaim?.email, parsed.email, openaiAuth?.email),
    name: firstString(idClaims?.name, profileClaim?.name, parsed.name, openaiAuth?.name),
    accountId: firstString(
      tokens.account_id,
      tokens.accountId,
      parsed.account_id,
      parsed.accountId,
      authClaim?.chatgpt_account_id,
    ),
    userId: firstString(
      authClaim?.chatgpt_user_id,
      authClaim?.chatgpt_account_user_id,
      authClaim?.user_id,
      idClaims?.sub,
      accessClaims?.sub,
    ),
    planType: firstString(authClaim?.chatgpt_plan_type, parsed.plan_type, parsed.planType),
  };

  return Object.values(summary).some(Boolean) ? summary : undefined;
};

const parseJsonObject = (value: string): Record<string, unknown> | undefined => {
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const decodeJwtPayload = (token: string | undefined): Record<string, unknown> | undefined => {
  if (!token) {
    return undefined;
  }
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return objectValue(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')));
  } catch {
    return undefined;
  }
};

const objectValue = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);

const stringValue = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
};

const isLocked = (record: CodexConnectionRecord, now: Date) => (
  Boolean(record.activeRunId && record.lockedUntil && Date.parse(record.lockedUntil) > now.getTime())
);

const cloneRecord = (record: CodexConnectionRecord | null): CodexConnectionRecord | null => {
  if (!record) {
    return null;
  }
  return JSON.parse(JSON.stringify(record)) as CodexConnectionRecord;
};
