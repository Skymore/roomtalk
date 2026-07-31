import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveClientLoginRateLimitConfig } from './clientLoginRateLimiter';

describe('client login rate limiter configuration', () => {
  it('uses conservative distributed login-attempt defaults', () => {
    assert.deepEqual(resolveClientLoginRateLimitConfig({}), {
      windowSeconds: 900,
      maxAttemptsPerClientIp: 10,
      maxAttemptsPerClient: 30,
      maxAttemptsPerIp: 100,
    });
  });

  it('accepts explicit positive limits and rejects malformed values', () => {
    assert.deepEqual(resolveClientLoginRateLimitConfig({
      CLIENT_AUTH_LOGIN_WINDOW_SECONDS: '60',
      CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT_IP: '3',
      CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT: '7',
      CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: '11',
    }), {
      windowSeconds: 60,
      maxAttemptsPerClientIp: 3,
      maxAttemptsPerClient: 7,
      maxAttemptsPerIp: 11,
    });
    assert.throws(
      () => resolveClientLoginRateLimitConfig({ CLIENT_AUTH_LOGIN_WINDOW_SECONDS: '0' }),
      /CLIENT_AUTH_LOGIN_WINDOW_SECONDS/,
    );
    assert.throws(
      () => resolveClientLoginRateLimitConfig({ CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT: '1.5' }),
      /CLIENT_AUTH_LOGIN_MAX_ATTEMPTS_PER_CLIENT/,
    );
  });
});
