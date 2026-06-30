import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import {
  PublishedStaticSiteService,
  normalizePublishedSitePath,
  normalizePublishedSiteSlug,
} from './publishedStaticSite';

const logger = new Logger('PublishedStaticSiteTest');

const createService = (overrides: {
  storage?: MemoryMediaObjectStorage;
  nowMs?: () => number;
} = {}) => {
  const storage = overrides.storage || new MemoryMediaObjectStorage();
  const service = new PublishedStaticSiteService({
    mediaObjectStorage: storage,
    logger,
    tokenSecret: 'static-publish-secret',
    publicBaseUrl: 'https://room.example',
    nowMs: overrides.nowMs || (() => Date.parse('2026-06-30T12:00:00.000Z')),
    createId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
  return { service, storage };
};

const textFile = (path: string, text: string) => ({
  path,
  contentBase64: Buffer.from(text, 'utf8').toString('base64'),
  byteSize: Buffer.byteLength(text),
});

describe('PublishedStaticSiteService', () => {
  it('normalizes slugs and safe relative paths', () => {
    assert.equal(normalizePublishedSiteSlug('RoomTalk Demo!!', 'fallback'), 'roomtalk-demo');
    assert.equal(normalizePublishedSitePath('assets/app.js'), 'assets/app.js');
    assert.equal(normalizePublishedSitePath('../secret.txt'), null);
    assert.equal(normalizePublishedSitePath('/absolute/index.html'), null);
    assert.equal(normalizePublishedSitePath('.env'), null);
  });

  it('issues and verifies scoped turn tokens', () => {
    let now = Date.parse('2026-06-30T12:00:00.000Z');
    const { service } = createService({ nowMs: () => now });
    const token = service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'acceptEdits',
    });

    const claims = service.verifyTurnToken(token);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.mode, 'acceptEdits');
    assert.equal(service.verifyTurnToken(`${token}x`), null);

    now += 16 * 60 * 1000;
    assert.equal(service.verifyTurnToken(token), null);
  });

  it('publishes files, stores a manifest, and resolves published assets', async () => {
    const { service, storage } = createService();
    const token = service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'acceptEdits',
    });
    const claims = service.verifyTurnToken(token)!;

    const result = await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'roomtalk-demo',
      title: 'RoomTalk Demo',
      entry: 'index.html',
      files: [
        textFile('index.html', '<!doctype html><script src="/assets/app.js"></script>'),
        textFile('assets/app.js', 'console.log("published")'),
      ],
    }, claims);

    assert.equal(result.url, 'https://room.example/p/roomtalk-demo/');
    assert.equal(result.slug, 'roomtalk-demo');
    assert.equal(result.fileCount, 2);
    assert.equal(storage.objects.has('published-sites/roomtalk-demo/manifest.json'), true);

    const index = await service.readFile('roomtalk-demo', '');
    assert.equal(index?.file.path, 'index.html');
    assert.match(index!.body.toString('utf8'), /doctype/);

    const asset = await service.readFile('roomtalk-demo', 'assets/app.js');
    assert.equal(asset?.file.mimeType, 'text/javascript; charset=utf-8');
    assert.equal(asset?.body.toString('utf8'), 'console.log("published")');

    const spaFallback = await service.readFile('roomtalk-demo', 'unknown/route');
    assert.equal(spaFallback?.file.path, 'index.html');
  });

  it('rejects invalid publish payloads and slug ownership conflicts', async () => {
    const { service } = createService();
    const firstClaims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'acceptEdits',
    }))!;

    await assert.rejects(
      service.publish({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('../index.html', '<!doctype html>')],
      }, firstClaims),
      /Invalid static file path/
    );

    await assert.rejects(
      service.publish({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('app.js', 'console.log("missing entry")')],
      }, firstClaims),
      /Entry file was not included/
    );

    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'roomtalk-demo',
      entry: 'index.html',
      files: [textFile('index.html', '<!doctype html>')],
    }, firstClaims);

    const secondClaims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-2',
      clientId: 'client-2',
      turnId: 'turn-2',
      mode: 'acceptEdits',
    }))!;

    await assert.rejects(
      service.publish({
        roomId: 'room-2',
        turnId: 'turn-2',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('index.html', '<!doctype html>')],
      }, secondClaims),
      /already owned by another room/
    );
  });

  it('rejects publish attempts from plan-mode tokens', async () => {
    const { service } = createService();
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'plan',
    }))!;

    await assert.rejects(
      service.publish({
        roomId: 'room-1',
        turnId: 'turn-1',
        files: [textFile('index.html', '<!doctype html>')],
      }, claims),
      /requires edit mode/
    );
  });
});
