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
  authRefreshOwnerId?: string;
  authRefreshLockedUntil?: string;
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

export interface CodexAuthSnapshot {
  authVersion: number;
}

export interface CodexConnectionAuthUpdate {
  encryptedAuthJson: CodexEncryptedAuthJson;
  keyVersion: string;
  updatedAt: string;
  lastUsedAt: string;
  lastValidatedAt?: string;
}

export interface CodexChatgptAuthRefreshResult {
  authJson: string;
  authVersion: number;
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
}

export interface CodexConnectionStore {
  getConnection(clientId: string): Promise<CodexConnectionRecord | null>;
  saveConnection(record: CodexConnectionRecord): Promise<CodexConnectionRecord>;
  deleteConnection(clientId: string): Promise<boolean>;
  compareAndSwapAuth(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionAuthUpdate
  ): Promise<CodexConnectionRecord | null>;
  touchConnection(clientId: string, lastUsedAt: string, lastValidatedAt?: string): Promise<CodexConnectionRecord | null>;
  acquireAuthRefreshLease(
    clientId: string,
    ownerId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null>;
  releaseAuthRefreshLease(clientId: string, ownerId: string, now: string): Promise<CodexConnectionRecord | null>;
}

export type CodexConnectionErrorCode =
  | 'connection_not_found'
  | 'connection_not_ready'
  | 'device_auth_in_progress'
  | 'device_auth_code_unavailable'
  | 'device_auth_cancelled'
  | 'device_auth_failed'
  | 'auth_refresh_failed'
  | 'auth_refresh_timeout'
  | 'auth_refresh_unavailable'
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
  authRefreshLockTtlMs?: number;
  authRefreshWaitMs?: number;
  authRefreshPollMs?: number;
  refreshTokenUrl?: string;
  oauthClientId?: string;
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  now?: () => Date;
}

export const CODE_AGENT_CODEX_AUTH_API_PREFIX = '/api/code-agent/codex-auth';

const DEFAULT_AUTH_REFRESH_LOCK_TTL_MS = 30_000;
const DEFAULT_AUTH_REFRESH_WAIT_MS = 30_000;
const DEFAULT_AUTH_REFRESH_POLL_MS = 100;
const DEFAULT_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export class CodexConnectionService {
  private readonly authRefreshLockTtlMs: number;
  private readonly authRefreshWaitMs: number;
  private readonly authRefreshPollMs: number;
  private readonly refreshTokenUrl: string;
  private readonly oauthClientId: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly store: CodexConnectionStore,
    private readonly cipher: CodexAuthCipher,
    private readonly deviceAuthDriver: CodexDeviceAuthDriver,
    options: CodexConnectionServiceOptions = {}
  ) {
    this.authRefreshLockTtlMs = options.authRefreshLockTtlMs || DEFAULT_AUTH_REFRESH_LOCK_TTL_MS;
    this.authRefreshWaitMs = options.authRefreshWaitMs || DEFAULT_AUTH_REFRESH_WAIT_MS;
    this.authRefreshPollMs = options.authRefreshPollMs || DEFAULT_AUTH_REFRESH_POLL_MS;
    this.refreshTokenUrl = options.refreshTokenUrl || DEFAULT_REFRESH_TOKEN_URL;
    this.oauthClientId = options.oauthClientId || DEFAULT_OAUTH_CLIENT_ID;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.createId = options.createId || (() => randomBytes(12).toString('hex'));
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
            authRefreshOwnerId: undefined,
            authRefreshLockedUntil: undefined,
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
    _runId: string,
    work: (authJson: string, snapshot: CodexAuthSnapshot) => Promise<CodexAuthWorkResult<T>>
  ): Promise<T> {
    const connection = await this.readyConnection(clientId);
    const authJson = this.cipher.decryptAuthJson(connection.encryptedAuthJson!);
    const workResult = await work(authJson, { authVersion: connection.authVersion });
    const updatedAt = this.timestamp();
    const refreshedAuthJson = workResult.refreshedAuthJson;
    const authChanged = refreshedAuthJson && !sameCodexAuthCredentials(authJson, refreshedAuthJson);

    if (authChanged) {
      const updated = await this.store.compareAndSwapAuth(clientId, connection.authVersion, {
        encryptedAuthJson: this.cipher.encryptAuthJson(refreshedAuthJson),
        keyVersion: this.cipher.keyVersion,
        updatedAt,
        lastUsedAt: updatedAt,
        lastValidatedAt: workResult.loginStatus ? updatedAt : undefined,
      });
      if (updated) {
        return workResult.result;
      }
    }

    await this.store.touchConnection(
      clientId,
      updatedAt,
      workResult.loginStatus ? updatedAt : undefined
    );
    return workResult.result;
  }

  async refreshChatgptAuth(
    clientId: string,
    observedAuthVersion: number
  ): Promise<CodexChatgptAuthRefreshResult> {
    const attempts = Math.max(1, Math.ceil(this.authRefreshWaitMs / this.authRefreshPollMs));
    const ownerId = this.createId();

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.readyConnection(clientId);
      if (current.authVersion > observedAuthVersion) {
        return this.chatgptRefreshResult(current);
      }

      const now = this.now();
      const lockedUntil = new Date(now.getTime() + this.authRefreshLockTtlMs).toISOString();
      const leased = await this.store.acquireAuthRefreshLease(
        clientId,
        ownerId,
        lockedUntil,
        now.toISOString()
      );
      if (!leased) {
        await sleep(this.authRefreshPollMs);
        continue;
      }

      try {
        if (leased.authVersion > observedAuthVersion) {
          return this.chatgptRefreshResult(leased);
        }
        const authJson = this.cipher.decryptAuthJson(leased.encryptedAuthJson!);
        const refreshedAuthJson = await this.requestChatgptTokenRefresh(authJson);
        const updatedAt = this.timestamp();
        const updated = await this.store.compareAndSwapAuth(clientId, leased.authVersion, {
          encryptedAuthJson: this.cipher.encryptAuthJson(refreshedAuthJson),
          keyVersion: this.cipher.keyVersion,
          updatedAt,
          lastUsedAt: updatedAt,
          lastValidatedAt: updatedAt,
        });
        if (updated) {
          return this.chatgptRefreshResult(updated, refreshedAuthJson);
        }
        return this.chatgptRefreshResult(await this.readyConnection(clientId));
      } finally {
        await this.store.releaseAuthRefreshLease(clientId, ownerId, this.timestamp());
      }
    }

    throw new CodexConnectionError(
      `Timed out waiting to refresh Codex auth for client ${clientId}.`,
      'auth_refresh_timeout'
    );
  }

  private async readyConnection(clientId: string): Promise<CodexConnectionRecord> {
    const connection = await this.store.getConnection(clientId);
    if (!connection) {
      throw new CodexConnectionError(`No Codex connection found for client ${clientId}.`, 'connection_not_found');
    }
    if (connection.status !== 'connected' || !connection.encryptedAuthJson) {
      throw new CodexConnectionError(`Codex connection is not ready for client ${clientId}.`, 'connection_not_ready');
    }
    return connection;
  }

  private async requestChatgptTokenRefresh(authJson: string): Promise<string> {
    const parsed = parseJsonObject(authJson);
    const tokens = parsed ? codexAuthTokensObject(parsed) : undefined;
    const refreshToken = stringValue(tokens?.refresh_token) || stringValue(tokens?.refreshToken);
    if (!parsed || !tokens || !refreshToken) {
      throw new CodexConnectionError('Codex auth does not include a refresh token.', 'auth_refresh_unavailable');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.refreshTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.oauthClientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(Math.max(1_000, this.authRefreshLockTtlMs - 1_000)),
      });
    } catch {
      throw new CodexConnectionError('Codex auth refresh request failed.', 'auth_refresh_failed');
    }
    if (!response.ok) {
      throw new CodexConnectionError(
        `Codex auth refresh failed with HTTP ${response.status}.`,
        'auth_refresh_failed'
      );
    }

    const payload = objectValue(await response.json().catch(() => undefined));
    const accessToken = stringValue(payload?.access_token) || stringValue(payload?.accessToken);
    if (!accessToken) {
      throw new CodexConnectionError('Codex auth refresh response did not include an access token.', 'auth_refresh_failed');
    }
    tokens.access_token = accessToken;
    const idToken = stringValue(payload?.id_token) || stringValue(payload?.idToken);
    const nextRefreshToken = stringValue(payload?.refresh_token) || stringValue(payload?.refreshToken);
    if (idToken) tokens.id_token = idToken;
    if (nextRefreshToken) tokens.refresh_token = nextRefreshToken;
    parsed.last_refresh = this.timestamp();
    return JSON.stringify(parsed);
  }

  private chatgptRefreshResult(
    connection: CodexConnectionRecord,
    decryptedAuthJson?: string
  ): CodexChatgptAuthRefreshResult {
    const authJson = decryptedAuthJson || this.cipher.decryptAuthJson(connection.encryptedAuthJson!);
    const parsed = parseJsonObject(authJson);
    const tokens = parsed ? codexAuthTokensObject(parsed) : undefined;
    const accessToken = stringValue(tokens?.access_token) || stringValue(tokens?.accessToken);
    const account = summarizeCodexAuthAccount(authJson);
    if (!accessToken || !account?.accountId) {
      throw new CodexConnectionError(
        'Codex auth does not include an access token and ChatGPT account id.',
        'auth_refresh_unavailable'
      );
    }
    return {
      authJson,
      authVersion: connection.authVersion,
      accessToken,
      chatgptAccountId: account.accountId,
      ...(account.planType ? { chatgptPlanType: account.planType } : {}),
    };
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

  async compareAndSwapAuth(
    clientId: string,
    expectedAuthVersion: number,
    update: CodexConnectionAuthUpdate
  ): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record || record.status !== 'connected' || record.authVersion !== expectedAuthVersion) {
      return null;
    }
    const updated: CodexConnectionRecord = {
      ...record,
      encryptedAuthJson: update.encryptedAuthJson,
      authVersion: expectedAuthVersion + 1,
      keyVersion: update.keyVersion,
      updatedAt: update.updatedAt,
      lastUsedAt: update.lastUsedAt,
      lastValidatedAt: update.lastValidatedAt || record.lastValidatedAt,
      lastError: undefined,
    };
    this.records.set(clientId, updated);
    return cloneRecord(updated)!;
  }

  async touchConnection(
    clientId: string,
    lastUsedAt: string,
    lastValidatedAt?: string
  ): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record) {
      return null;
    }
    const updated: CodexConnectionRecord = {
      ...record,
      updatedAt: lastUsedAt,
      lastUsedAt,
      lastValidatedAt: lastValidatedAt || record.lastValidatedAt,
    };
    this.records.set(clientId, updated);
    return cloneRecord(updated)!;
  }

  async acquireAuthRefreshLease(
    clientId: string,
    ownerId: string,
    lockedUntil: string,
    now: string
  ): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record || record.status !== 'connected' || !record.encryptedAuthJson) {
      return null;
    }
    if (isAuthRefreshLocked(record, new Date(now)) && record.authRefreshOwnerId !== ownerId) {
      return null;
    }
    const updated: CodexConnectionRecord = {
      ...record,
      authRefreshOwnerId: ownerId,
      authRefreshLockedUntil: lockedUntil,
    };
    this.records.set(clientId, updated);
    return cloneRecord(updated)!;
  }

  async releaseAuthRefreshLease(clientId: string, ownerId: string, now: string): Promise<CodexConnectionRecord | null> {
    const record = this.records.get(clientId);
    if (!record || record.authRefreshOwnerId !== ownerId) {
      return cloneRecord(record || null);
    }
    const updated: CodexConnectionRecord = {
      ...record,
      authRefreshOwnerId: undefined,
      authRefreshLockedUntil: undefined,
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
  locked: isAuthRefreshLocked(record, now),
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

const isAuthRefreshLocked = (record: CodexConnectionRecord, now: Date) => (
  Boolean(
    record.authRefreshOwnerId &&
    record.authRefreshLockedUntil &&
    Date.parse(record.authRefreshLockedUntil) > now.getTime()
  )
);

const codexAuthTokensObject = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const openaiAuth = objectValue(parsed.OPENAI_AUTH) || objectValue(parsed.openaiAuth);
  return objectValue(parsed.tokens) || objectValue(openaiAuth?.tokens) || openaiAuth || parsed;
};

const sameCodexAuthCredentials = (left: string, right: string): boolean => {
  const leftParsed = parseJsonObject(left);
  const rightParsed = parseJsonObject(right);
  if (!leftParsed || !rightParsed) {
    return left === right;
  }
  const credentialValues = (parsed: Record<string, unknown>) => {
    const tokens = codexAuthTokensObject(parsed);
    return [
      stringValue(tokens.access_token) || stringValue(tokens.accessToken),
      stringValue(tokens.refresh_token) || stringValue(tokens.refreshToken),
      stringValue(tokens.id_token) || stringValue(tokens.idToken),
      stringValue(tokens.account_id) || stringValue(tokens.accountId),
    ];
  };
  return JSON.stringify(credentialValues(leftParsed)) === JSON.stringify(credentialValues(rightParsed));
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const cloneRecord = (record: CodexConnectionRecord | null): CodexConnectionRecord | null => {
  if (!record) {
    return null;
  }
  return JSON.parse(JSON.stringify(record)) as CodexConnectionRecord;
};
