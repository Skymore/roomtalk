import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  hashClientAuthToken,
  hashClientPassword,
  isClientRequestAuthorized,
  issueClientAuthToken,
  validateClientPassword,
  verifyClientPassword,
} from './clientAuth';
import { ClientAuthTokenRecord } from '../repositories/store';

describe('client auth service', () => {
  it('validates, hashes, and verifies client passwords', async () => {
    assert.equal(validateClientPassword('short'), false);
    assert.equal(validateClientPassword('long-enough'), true);

    const passwordHash = await hashClientPassword('long-enough');
    assert.equal(await verifyClientPassword('long-enough', passwordHash), true);
    assert.equal(await verifyClientPassword('wrong-password', passwordHash), false);
    assert.equal(await verifyClientPassword('long-enough', 'invalid-hash'), false);
  });

  it('allows legacy clients without a password and requires valid tokens after a password is set', async () => {
    const savedTokens = new Map<string, ClientAuthTokenRecord>();
    let passwordHash: string | null = null;
    const store = {
      async getClientPasswordHash() {
        return passwordHash;
      },
      async saveClientAuthToken(token: ClientAuthTokenRecord) {
        savedTokens.set(token.tokenHash, token);
      },
      async isClientAuthTokenValid(clientId: string, tokenHash: string) {
        return savedTokens.get(tokenHash)?.clientId === clientId;
      },
    };

    assert.equal(await isClientRequestAuthorized(store, 'client-1'), true);

    passwordHash = await hashClientPassword('long-enough');
    assert.equal(await isClientRequestAuthorized(store, 'client-1'), false);
    assert.equal(await isClientRequestAuthorized(store, 'client-1', 'bad-token'), false);

    const rawToken = await issueClientAuthToken(store, 'client-1');
    assert.equal(savedTokens.has(hashClientAuthToken(rawToken)), true);
    assert.equal(await isClientRequestAuthorized(store, 'client-1', rawToken), true);
    assert.equal(await isClientRequestAuthorized(store, 'client-2', rawToken), false);
  });
});
