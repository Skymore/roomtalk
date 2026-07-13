import assert from 'assert/strict';
import express from 'express';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger } from '../logger';
import { PublishedStaticSiteService } from '../services/publishedStaticSite';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import { registerPublishedStaticSiteRoutes } from './publishedStaticSiteRoutes';

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  service: PublishedStaticSiteService;
  roomIds: Set<string>;
  activeTurnIds: Set<string>;
  storage: MemoryMediaObjectStorage;
};

const createTestServer = async (): Promise<TestServer> => {
  const app = express();
  const roomIds = new Set(['room-1']);
  const activeTurnIds = new Set(['turn-1']);
  const storage = new MemoryMediaObjectStorage();
  const service = new PublishedStaticSiteService({
    mediaObjectStorage: storage,
    logger: new Logger('PublishedStaticSiteRoutesTest'),
    tokenSecret: 'static-publish-secret',
    nowMs: () => Date.parse('2026-06-30T12:00:00.000Z'),
    createId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  registerPublishedStaticSiteRoutes(app, {
    service,
    logger: new Logger('PublishedStaticSiteRoutesTest'),
    getRoomById: async roomId => roomIds.has(roomId) ? { id: roomId } : null,
    refreshAuthorization: {
      verifyTurnToken: token => token === 'refresh-token' ? {
        v: 1,
        jti: 'refresh-jti',
        roomId: 'room-1',
        clientId: 'client-1',
        turnId: 'turn-1',
        mode: 'fullAccess',
        exp: Number.MAX_SAFE_INTEGER,
      } : null,
      assertAccess: async () => undefined,
    },
    isTurnActive: async (_roomId, turnId) => activeTurnIds.has(turnId),
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    service,
    roomIds,
    activeTurnIds,
    storage,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
};

const textFile = (path: string, text: string) => ({
  path,
  contentBase64: Buffer.from(text, 'utf8').toString('base64'),
  byteSize: Buffer.byteLength(text),
});

describe('published static site routes', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('publishes and unpublishes with a scoped token', async () => {
    const token = server.service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    });

    const publishResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [
          textFile('index.html', '<!doctype html><script src="assets/app.js"></script>'),
          textFile('assets/app.js', 'window.roomtalkDemo = true'),
        ],
      }),
    });

    assert.equal(publishResponse.status, 201);
    const published = await publishResponse.json() as { url: string; slug: string; fileCount: number };
    assert.equal(published.url, `${server.baseUrl}/p/roomtalk-demo/`);
    assert.equal(published.slug, 'roomtalk-demo');
    assert.equal(published.fileCount, 2);

    const indexResponse = await fetch(`${server.baseUrl}/p/roomtalk-demo/`);
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get('content-type') || '', /^text\/html/);
    assert.equal(indexResponse.headers.get('access-control-allow-origin'), '*');
    assert.equal(indexResponse.headers.get('access-control-allow-credentials'), null);
    assert.equal(indexResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await indexResponse.text(), /doctype/);

    const assetResponse = await fetch(`${server.baseUrl}/p/roomtalk-demo/assets/app.js`, {
      headers: { origin: 'null' },
    });
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type') || '', /^text\/javascript/);
    assert.equal(assetResponse.headers.get('access-control-allow-origin'), '*');
    assert.equal(assetResponse.headers.get('access-control-allow-credentials'), null);
    assert.equal(await assetResponse.text(), 'window.roomtalkDemo = true');

    const unpublishResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ slug: 'roomtalk-demo' }),
    });
    assert.equal(unpublishResponse.status, 200);
    const unpublished = await unpublishResponse.json() as { url: string; slug: string; objectCount: number };
    assert.equal(unpublished.url, `${server.baseUrl}/p/roomtalk-demo/`);
    assert.equal(unpublished.slug, 'roomtalk-demo');
    assert.equal(unpublished.objectCount, 4);

    const unpublishedResponse = await fetch(`${server.baseUrl}/p/roomtalk-demo/`);
    assert.equal(unpublishedResponse.status, 404);
  });

  it('refreshes a short-lived publish token only while the turn is running', async () => {
    const refresh = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site/token`, {
      method: 'POST',
      headers: { authorization: 'Bearer refresh-token' },
    });
    assert.equal(refresh.status, 200);
    const payload = await refresh.json() as { token: string; expiresInSeconds: number };
    assert.equal(payload.expiresInSeconds, 15 * 60);
    assert.equal(server.service.verifyTurnToken(payload.token)?.turnId, 'turn-1');

    server.activeTurnIds.delete('turn-1');
    const afterCompletion = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site/token`, {
      method: 'POST',
      headers: { authorization: 'Bearer refresh-token' },
    });
    assert.equal(afterCompletion.status, 409);
    assert.equal((await afterCompletion.json() as { code: string }).code, 'turn_not_running');

    const staleAccess = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${payload.token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(staleAccess.status, 409);
  });

  it('prepares direct uploads and finalizes after object storage receives the files', async () => {
    const token = server.service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    });
    const prepareResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site/prepare`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'direct-demo',
        entry: 'index.html',
        files: [{ path: 'index.html', byteSize: 24 }],
      }),
    });
    assert.equal(prepareResponse.status, 201);
    const prepared = await prepareResponse.json() as {
      uploadToken: string;
      files: Array<{ uploadUrl: string; mimeType: string; byteSize: number }>;
    };
    const objectKey = decodeURIComponent(new URL(prepared.files[0].uploadUrl).pathname.slice(1));
    await server.storage.putMediaObject({
      objectKey,
      body: Buffer.alloc(24),
      mimeType: prepared.files[0].mimeType,
      byteSize: 24,
    });

    const finalizeResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site/finalize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ uploadToken: prepared.uploadToken }),
    });
    assert.equal(finalizeResponse.status, 201);
    const published = await finalizeResponse.json() as { slug: string; totalBytes: number; url: string };
    assert.equal(published.slug, 'direct-demo');
    assert.equal(published.totalBytes, 24);
    assert.equal(published.url, `${server.baseUrl}/p/direct-demo/`);
  });

  it('does not serve a published site after its room is deleted', async () => {
    const token = server.service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    });

    const publishResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('index.html', '<!doctype html>published')],
      }),
    });
    assert.equal(publishResponse.status, 201);

    server.roomIds.delete('room-1');

    const response = await fetch(`${server.baseUrl}/p/roomtalk-demo/`);
    assert.equal(response.status, 404);
  });

  it('rejects missing tokens and returns 404 for missing sites', async () => {
    const publishResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(publishResponse.status, 401);

    const unpublishResponse = await fetch(`${server.baseUrl}/api/code-agent/publish-static-site`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'missing-site' }),
    });
    assert.equal(unpublishResponse.status, 401);

    const missingResponse = await fetch(`${server.baseUrl}/p/missing-site/`);
    assert.equal(missingResponse.status, 404);
  });
});
