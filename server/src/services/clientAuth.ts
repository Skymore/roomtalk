import crypto from 'crypto';
import { promisify } from 'util';
import { ClientAuthTokenRecord, RoomStore } from '../repositories/store';

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;

export const MIN_CLIENT_PASSWORD_LENGTH = 8;
export const MAX_CLIENT_PASSWORD_LENGTH = 128;
export const DEFAULT_CLIENT_AUTH_TOKEN_TTL_DAYS = 30;
export const MAX_CLIENT_AUTH_TOKEN_TTL_DAYS = 365;

export const validateClientPassword = (password: unknown): password is string => (
  typeof password === 'string' &&
  password.length >= MIN_CLIENT_PASSWORD_LENGTH &&
  password.length <= MAX_CLIENT_PASSWORD_LENGTH
);

export const hashClientPassword = async (password: string): Promise<string> => {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derivedKey = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH) as Buffer;
  return `${PASSWORD_HASH_PREFIX}:${salt}:${derivedKey.toString('base64url')}`;
};

export const verifyClientPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  const [prefix, salt, encodedHash] = passwordHash.split(':');
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !encodedHash) {
    return false;
  }

  const expected = Buffer.from(encodedHash, 'base64url');
  const actual = await scryptAsync(password, salt, expected.length) as Buffer;
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

export const createClientAuthToken = () => crypto.randomBytes(32).toString('base64url');

export const hashClientAuthToken = (token: string) => (
  crypto.createHash('sha256').update(token).digest('base64url')
);

export const resolveClientAuthTokenTtlDays = (
  value = process.env.CLIENT_AUTH_TOKEN_TTL_DAYS,
): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_CLIENT_AUTH_TOKEN_TTL_DAYS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CLIENT_AUTH_TOKEN_TTL_DAYS) {
    throw new Error(
      `CLIENT_AUTH_TOKEN_TTL_DAYS must be an integer between 1 and ${MAX_CLIENT_AUTH_TOKEN_TTL_DAYS}`,
    );
  }
  return parsed;
};

export const createClientAuthSession = (
  clientId: string,
  options: {
    accountId?: string;
    authMethod?: 'password' | 'google';
    expiresAt?: string;
    now?: Date;
    ttlDays?: number;
  } = {},
): { token: string; record: ClientAuthTokenRecord } => {
  const now = options.now || new Date();
  const token = createClientAuthToken();
  const ttlDays = options.ttlDays ?? resolveClientAuthTokenTtlDays();
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_CLIENT_AUTH_TOKEN_TTL_DAYS) {
    throw new Error(`Client auth token TTL must be an integer between 1 and ${MAX_CLIENT_AUTH_TOKEN_TTL_DAYS} days`);
  }
  const expiresAt = options.expiresAt
    || new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  return {
    token,
    record: {
      clientId,
      tokenHash: hashClientAuthToken(token),
      accountId: options.accountId,
      authMethod: options.authMethod,
      expiresAt,
      createdAt: now.toISOString(),
    },
  };
};

export const isClientRequestAuthorized = async (
  store: Pick<RoomStore, 'getClientPasswordHash' | 'getAccountByClientId' | 'isClientAuthTokenValid'>,
  clientId: string,
  token?: string | null,
) => {
  const [passwordHash, account] = await Promise.all([
    store.getClientPasswordHash(clientId),
    store.getAccountByClientId(clientId),
  ]);
  if (!passwordHash && !account) {
    return true;
  }

  if (!token) {
    return false;
  }

  return store.isClientAuthTokenValid(clientId, hashClientAuthToken(token));
};

export const issueClientAuthToken = async (
  store: Pick<RoomStore, 'saveClientAuthToken'>,
  clientId: string,
  options: {
    accountId?: string;
    authMethod?: 'password' | 'google';
    expiresAt?: string;
    now?: Date;
    ttlDays?: number;
  } = {},
) => {
  const session = createClientAuthSession(clientId, options);
  await store.saveClientAuthToken(session.record);
  return session.token;
};
