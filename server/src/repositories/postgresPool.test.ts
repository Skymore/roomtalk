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

  it('does not configure SSL unless requested', () => {
    assert.equal(resolvePostgresSslConfig({}), undefined);
  });
});
