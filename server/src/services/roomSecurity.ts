import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);
const PASSWORD_HASH_PREFIX = 'scrypt-v1';
const KEY_LENGTH = 64;

export async function hashRoomPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return `${PASSWORD_HASH_PREFIX}:${salt}:${key.toString('base64url')}`;
}

export async function verifyRoomPassword(password: string, passwordHash: string | null): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  const [prefix, salt, expectedKey] = passwordHash.split(':');
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !expectedKey) {
    return false;
  }

  const actual = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  const expected = Buffer.from(expectedKey, 'base64url');
  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}
