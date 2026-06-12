import crypto from 'crypto';
import { promisify } from 'util';
import { RoomStore } from '../repositories/store';

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;

export const MIN_CLIENT_PASSWORD_LENGTH = 8;
export const MAX_CLIENT_PASSWORD_LENGTH = 128;

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
  } = {},
) => {
  const token = createClientAuthToken();
  await store.saveClientAuthToken({
    clientId,
    tokenHash: hashClientAuthToken(token),
    accountId: options.accountId,
    authMethod: options.authMethod,
    expiresAt: options.expiresAt,
    createdAt: new Date().toISOString(),
  });
  return token;
};
