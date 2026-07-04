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
};

const createTestServer = async (): Promise<TestServer> => {
  const app = express();
  const roomIds = new Set(['room-1']);
  const service = new PublishedStaticSiteService({
    mediaObjectStorage: new MemoryMediaObjectStorage(),
    logger: new Logger('PublishedStaticSiteRoutesTest'),
    tokenSecret: 'static-publish-secret',
    nowMs: () => Date.parse('2026-06-30T12:00:00.000Z'),
    createId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  registerPublishedStaticSiteRoutes(app, {
    service,
    logger: new Logger('PublishedStaticSiteRoutesTest'),
    getRoomById: async roomId => roomIds.has(roomId) ? { id: roomId } : null,
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    service,
    roomIds,
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

  it('publishes with a scoped token and serves the site publicly', async () => {
    const token = server.service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    });

    const publishResponse = await fetch(`${server.baseUrl}/api/coco/publish-static-site`, {
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
    assert.equal(indexResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await indexResponse.text(), /doctype/);

    const assetResponse = await fetch(`${server.baseUrl}/p/roomtalk-demo/assets/app.js`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type') || '', /^text\/javascript/);
    assert.equal(await assetResponse.text(), 'window.roomtalkDemo = true');
  });

  it('does not serve a published site after its room is deleted', async () => {
    const token = server.service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    });

    const publishResponse = await fetch(`${server.baseUrl}/api/coco/publish-static-site`, {
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
    const publishResponse = await fetch(`${server.baseUrl}/api/coco/publish-static-site`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(publishResponse.status, 401);

    const missingResponse = await fetch(`${server.baseUrl}/p/missing-site/`);
    assert.equal(missingResponse.status, 404);
  });
});
