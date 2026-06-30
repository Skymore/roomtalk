import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { resolveCorsOrigin } from './corsConfig';

describe('resolveCorsOrigin', () => {
  it('uses CLIENT_URL when configured', () => {
    assert.equal(resolveCorsOrigin({
      NODE_ENV: 'production',
      CLIENT_URL: ' https://room.ruit.me ',
    }), 'https://room.ruit.me');
  });

  it('uses CLIENT_URLS for multiple production origins', () => {
    assert.deepEqual(resolveCorsOrigin({
      NODE_ENV: 'production',
      CLIENT_URLS: ' https://room.ruit.me, https://room.ruit.me ',
    }), ['https://room.ruit.me', 'https://room.ruit.me']);
  });

  it('combines CLIENT_URLS and CLIENT_URL without duplicates', () => {
    assert.deepEqual(resolveCorsOrigin({
      NODE_ENV: 'production',
      CLIENT_URLS: 'https://room.ruit.me,https://room.ruit.me',
      CLIENT_URL: 'https://room.ruit.me',
    }), ['https://room.ruit.me', 'https://room.ruit.me']);
  });

  it('falls back to wildcard for local development without CLIENT_URL', () => {
    assert.equal(resolveCorsOrigin({
      NODE_ENV: 'development',
    }), '*');
  });

  it('denies browser cross-origin access in production without CLIENT_URL', () => {
    assert.equal(resolveCorsOrigin({
      NODE_ENV: 'production',
    }), false);
  });
});
