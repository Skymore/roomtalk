import assert from 'assert/strict';
import { describe, it } from 'node:test';
import {
  createClientAuthSession,
  hashClientAuthToken,
  hashClientPassword,
  isClientRequestAuthorized,
  issueClientAuthToken,
  resolveClientAuthTokenTtlDays,
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
      async getAccountByClientId() {
        return null;
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

  it('requires a valid token for clients linked to an account even without a password', async () => {
    const savedTokens = new Map<string, ClientAuthTokenRecord>();
    const store = {
      async getClientPasswordHash() {
        return null;
      },
      async getAccountByClientId(clientId: string) {
        return clientId === 'client-1'
          ? {
              accountId: 'account-1',
              primaryClientId: 'client-1',
              provider: 'google' as const,
              providerSubject: 'google-subject-1',
              createdAt: '2026-05-03T00:00:00.000Z',
              updatedAt: '2026-05-03T00:00:00.000Z',
            }
          : null;
      },
      async saveClientAuthToken(token: ClientAuthTokenRecord) {
        savedTokens.set(token.tokenHash, token);
      },
      async isClientAuthTokenValid(clientId: string, tokenHash: string) {
        return savedTokens.get(tokenHash)?.clientId === clientId;
      },
    };

    assert.equal(await isClientRequestAuthorized(store, 'client-2'), true);
    assert.equal(await isClientRequestAuthorized(store, 'client-1'), false);

    const rawToken = await issueClientAuthToken(store, 'client-1', {
      accountId: 'account-1',
      authMethod: 'google',
    });
    assert.equal(savedTokens.get(hashClientAuthToken(rawToken))?.authMethod, 'google');
    assert.equal(await isClientRequestAuthorized(store, 'client-1', rawToken), true);
  });

  it('issues bounded expiring sessions and validates the configured TTL', () => {
    const session = createClientAuthSession('client-1', {
      accountId: 'account-1',
      authMethod: 'password',
      now: new Date('2026-07-31T00:00:00.000Z'),
      ttlDays: 2,
    });
    assert.equal(session.record.createdAt, '2026-07-31T00:00:00.000Z');
    assert.equal(session.record.expiresAt, '2026-08-02T00:00:00.000Z');
    assert.equal(session.record.tokenHash, hashClientAuthToken(session.token));
    assert.equal(resolveClientAuthTokenTtlDays(''), 30);
    assert.equal(resolveClientAuthTokenTtlDays('365'), 365);
    assert.throws(() => resolveClientAuthTokenTtlDays('0'), /CLIENT_AUTH_TOKEN_TTL_DAYS/);
    assert.throws(() => resolveClientAuthTokenTtlDays('366'), /CLIENT_AUTH_TOKEN_TTL_DAYS/);
  });

  it('propagates account storage failures so authorization fails closed', async () => {
    await assert.rejects(
      isClientRequestAuthorized({
        async getClientPasswordHash() {
          throw new Error('password storage unavailable');
        },
        async getAccountByClientId() {
          return null;
        },
        async isClientAuthTokenValid() {
          return false;
        },
      }, 'client-1'),
      /password storage unavailable/,
    );
    await assert.rejects(
      isClientRequestAuthorized({
        async getClientPasswordHash() {
          return 'scrypt:salt:hash';
        },
        async getAccountByClientId() {
          return null;
        },
        async isClientAuthTokenValid() {
          throw new Error('token storage unavailable');
        },
      }, 'client-1', 'token'),
      /token storage unavailable/,
    );
  });
});
