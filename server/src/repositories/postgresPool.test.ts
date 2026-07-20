import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { attachPostgresPoolErrorHandler, resolvePostgresSslConfig } from './postgresPool';
import { PostgresPool } from './postgresStore';

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

describe('attachPostgresPoolErrorHandler', () => {
  it('handles idle-client disconnects instead of letting EventEmitter throw', () => {
    let errorListener: ((error: Error) => void) | undefined;
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      }),
      on(event: 'error', listener: (error: Error) => void) {
        assert.equal(event, 'error');
        errorListener = listener;
        return this;
      },
    } satisfies PostgresPool;
    const warnings: Array<{ message: string; metadata: unknown }> = [];
    const logger = {
      warn: (message: string, metadata: unknown) => warnings.push({ message, metadata }),
    };

    assert.equal(attachPostgresPoolErrorHandler(pool, logger as any), pool);
    assert.ok(errorListener);

    const disconnect = new Error('terminating connection due to administrator command');
    errorListener(disconnect);
    assert.deepEqual(warnings, [{
      message: 'PostgreSQL idle client disconnected; pool will reconnect on demand',
      metadata: { error: disconnect },
    }]);
  });
});
