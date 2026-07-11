import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export interface GitHubEncryptedToken {
  algorithm: 'aes-256-gcm';
  keyVersion: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface GitHubAccountSummary {
  id: number;
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface GitHubConnectionRecord {
  clientId: string;
  provider: 'github';
  status: 'connected' | 'reauth_required';
  encryptedToken: GitHubEncryptedToken;
  authVersion: number;
  keyVersion: string;
  account: GitHubAccountSummary;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string;
  lastUsedAt?: string;
  lastError?: string;
}

export interface GitHubConnectionPublicStatus {
  clientId: string;
  provider: 'github';
  status: 'connected' | 'reauth_required' | 'disconnected';
  authVersion: number;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
  account?: GitHubAccountSummary;
}

export interface GitHubConnectionStore {
  getConnection(clientId: string): Promise<GitHubConnectionRecord | null>;
  saveConnection(record: GitHubConnectionRecord): Promise<GitHubConnectionRecord>;
  deleteConnection(clientId: string): Promise<boolean>;
}

export class InMemoryGitHubConnectionStore implements GitHubConnectionStore {
  private readonly records = new Map<string, GitHubConnectionRecord>();

  async getConnection(clientId: string): Promise<GitHubConnectionRecord | null> {
    const record = this.records.get(clientId);
    return record ? structuredClone(record) : null;
  }

  async saveConnection(record: GitHubConnectionRecord): Promise<GitHubConnectionRecord> {
    const clone = structuredClone(record);
    this.records.set(record.clientId, clone);
    return structuredClone(clone);
  }

  async deleteConnection(clientId: string): Promise<boolean> {
    return this.records.delete(clientId);
  }
}

export type GitHubConnectionErrorCode = 'invalid_token' | 'auth_secret_missing' | 'auth_decrypt_failed';

export class GitHubConnectionError extends Error {
  constructor(message: string, readonly code: GitHubConnectionErrorCode) {
    super(message);
    this.name = 'GitHubConnectionError';
  }
}

export class GitHubTokenCipher {
  private readonly key: Buffer;

  constructor(secret: string | undefined, readonly keyVersion = 'v1') {
    if (!secret?.trim()) {
      throw new GitHubConnectionError('GitHub token encryption secret is required.', 'auth_secret_missing');
    }
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(token: string): GitHubEncryptedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      keyVersion: this.keyVersion,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(blob: GitHubEncryptedToken): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(blob.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new GitHubConnectionError('Unable to decrypt GitHub token.', 'auth_decrypt_failed');
    }
  }
}

export type GitHubTokenValidator = (token: string) => Promise<GitHubAccountSummary>;

export class GitHubConnectionService {
  constructor(
    private readonly store: GitHubConnectionStore,
    private readonly cipher: GitHubTokenCipher,
    private readonly validateToken: GitHubTokenValidator = validateGitHubToken,
    private readonly now: () => Date = () => new Date()
  ) {}

  async connect(clientId: string, rawToken: string): Promise<GitHubConnectionPublicStatus> {
    const token = rawToken.trim();
    if (token.length < 20 || /\s/.test(token)) {
      throw new GitHubConnectionError('GitHub personal access token is invalid.', 'invalid_token');
    }
    const account = await this.validateToken(token).catch(error => {
      if (error instanceof GitHubConnectionError) throw error;
      throw new GitHubConnectionError('GitHub personal access token was rejected.', 'invalid_token');
    });
    const existing = await this.store.getConnection(clientId);
    const timestamp = this.now().toISOString();
    const record = await this.store.saveConnection({
      clientId,
      provider: 'github',
      status: 'connected',
      encryptedToken: this.cipher.encrypt(token),
      authVersion: (existing?.authVersion || 0) + 1,
      keyVersion: this.cipher.keyVersion,
      account,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      lastValidatedAt: timestamp,
    });
    return publicStatus(record);
  }

  async getConnectionStatus(clientId: string): Promise<GitHubConnectionPublicStatus> {
    const record = await this.store.getConnection(clientId);
    return record ? publicStatus(record) : disconnectedStatus(clientId);
  }

  async disconnect(clientId: string): Promise<GitHubConnectionPublicStatus> {
    await this.store.deleteConnection(clientId);
    return disconnectedStatus(clientId);
  }

  async getAccessToken(clientId: string): Promise<string | undefined> {
    const record = await this.store.getConnection(clientId);
    if (!record || record.status !== 'connected') return undefined;
    return this.cipher.decrypt(record.encryptedToken);
  }
}

export async function validateGitHubToken(token: string): Promise<GitHubAccountSummary> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'RoomTalk-GitHub-Connector',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new GitHubConnectionError('GitHub personal access token was rejected.', 'invalid_token');
  }
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.id !== 'number' || typeof data.login !== 'string' || !data.login) {
    throw new GitHubConnectionError('GitHub returned an invalid account response.', 'invalid_token');
  }
  return {
    id: data.id,
    login: data.login,
    ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
    ...(typeof data.avatar_url === 'string' && data.avatar_url ? { avatarUrl: data.avatar_url } : {}),
  };
}

const publicStatus = (record: GitHubConnectionRecord): GitHubConnectionPublicStatus => ({
  clientId: record.clientId,
  provider: 'github',
  status: record.status,
  authVersion: record.authVersion,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  lastValidatedAt: record.lastValidatedAt,
  lastUsedAt: record.lastUsedAt,
  lastError: record.lastError,
  account: record.account,
});

const disconnectedStatus = (clientId: string): GitHubConnectionPublicStatus => ({
  clientId,
  provider: 'github',
  status: 'disconnected',
  authVersion: 0,
  createdAt: '',
  updatedAt: '',
});
