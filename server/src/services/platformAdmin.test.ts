import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountMatchesPlatformAdminEmail, resolvePlatformAdminEmails } from './platformAdmin';

describe('platform administrator configuration', () => {
  it('normalizes and deduplicates configured administrator emails', () => {
    assert.deepEqual(
      resolvePlatformAdminEmails(' RealRuitao@gmail.com,realruitao@gmail.com '),
      ['realruitao@gmail.com'],
    );
  });

  it('requires a verified account email for configured administrator bootstrap', () => {
    const configured = new Set(['realruitao@gmail.com']);
    assert.equal(accountMatchesPlatformAdminEmail({
      email: 'RealRuitao@gmail.com',
      emailVerified: true,
    }, configured), true);
    assert.equal(accountMatchesPlatformAdminEmail({
      email: 'realruitao@gmail.com',
      emailVerified: false,
    }, configured), false);
    assert.equal(accountMatchesPlatformAdminEmail({
      email: 'other@example.com',
      emailVerified: true,
    }, configured), false);
  });

  it('fails fast on malformed configured addresses', () => {
    assert.throws(
      () => resolvePlatformAdminEmails('not-an-email'),
      /valid comma-separated email addresses/,
    );
  });
});
