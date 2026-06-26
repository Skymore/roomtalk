import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomMessagesSmokeUrl, getSafeSmokeDatabaseUrl, getSafeSmokeRedisUrl } from './persistenceSmoke';

test('buildRoomMessagesSmokeUrl includes the authorized client id', () => {
  const url = new URL(buildRoomMessagesSmokeUrl('http://127.0.0.1:3012', 'room/a b', 'client+owner'));

  assert.equal(url.origin, 'http://127.0.0.1:3012');
  assert.equal(url.pathname, '/api/rooms/room%2Fa%20b/messages');
  assert.equal(url.searchParams.get('clientId'), 'client+owner');
});

test('getSafeSmokeRedisUrl refuses non-local Redis by default', () => {
  assert.throws(
    () => getSafeSmokeRedisUrl({ PERSISTENCE_SMOKE_REDIS_URL: 'redis://example.com:6379/0' } as NodeJS.ProcessEnv),
    /refuses non-local Redis/,
  );
});

test('getSafeSmokeDatabaseUrl requires a disposable database name', () => {
  assert.throws(
    () => getSafeSmokeDatabaseUrl({ TEST_DATABASE_URL: 'postgres://127.0.0.1/production' } as NodeJS.ProcessEnv),
    /must include "test" or "e2e"/,
  );

  assert.equal(
    getSafeSmokeDatabaseUrl({ TEST_DATABASE_URL: 'postgres://127.0.0.1/message_system_e2e' } as NodeJS.ProcessEnv),
    'postgres://127.0.0.1/message_system_e2e',
  );
});
