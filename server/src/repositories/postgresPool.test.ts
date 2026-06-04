import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { resolvePostgresSslConfig } from './postgresPool';

describe('resolvePostgresSslConfig', () => {
  it('keeps certificate validation enabled by default when SSL is on', () => {
    assert.deepEqual(resolvePostgresSslConfig({ POSTGRES_SSL: 'true' }), { rejectUnauthorized: true });
  });

  it('requires an explicit opt-out to disable certificate validation', () => {
    assert.deepEqual(resolvePostgresSslConfig({
      POSTGRES_SSL: 'true',
      POSTGRES_SSL_REJECT_UNAUTHORIZED: 'false',
    }), { rejectUnauthorized: false });
  });

  it('uses a PEM CA certificate when provided', () => {
    assert.deepEqual(resolvePostgresSslConfig({
      POSTGRES_SSL: 'true',
      POSTGRES_SSL_CA: '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----',
    }), {
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----',
    });
  });

  it('decodes a base64 PEM CA certificate when provided', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----';

    assert.deepEqual(resolvePostgresSslConfig({
      POSTGRES_SSL: 'true',
      POSTGRES_SSL_CA_BASE64: Buffer.from(ca, 'utf8').toString('base64'),
    }), {
      rejectUnauthorized: true,
      ca,
    });
  });

  it('does not configure SSL unless requested', () => {
    assert.equal(resolvePostgresSslConfig({}), undefined);
  });
});
