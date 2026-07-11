import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../logger';
import { MemoryMediaObjectStorage } from '../testUtils/memoryMediaObjectStorage';
import {
  PublishedStaticSiteService,
  createPublishedStaticSiteServiceFromEnv,
  normalizePublishedSitePath,
  normalizePublishedSiteSlug,
} from './publishedStaticSite';

const logger = new Logger('PublishedStaticSiteTest');

const createService = (overrides: {
  storage?: MemoryMediaObjectStorage;
  nowMs?: () => number;
  createId?: () => string;
  publicBaseUrl?: string;
  allowedPublicBaseUrls?: string[];
  nodeEnv?: string;
} = {}) => {
  const storage = overrides.storage || new MemoryMediaObjectStorage();
  const service = new PublishedStaticSiteService({
    mediaObjectStorage: storage,
    logger,
    tokenSecret: 'static-publish-secret',
    publicBaseUrl: overrides.publicBaseUrl ?? 'https://room.example',
    allowedPublicBaseUrls: overrides.allowedPublicBaseUrls,
    nodeEnv: overrides.nodeEnv,
    nowMs: overrides.nowMs || (() => Date.parse('2026-06-30T12:00:00.000Z')),
    createId: overrides.createId || (() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
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
      mode: 'fullAccess',
    });

    const claims = service.verifyTurnToken(token);
    assert.equal(claims?.roomId, 'room-1');
    assert.equal(claims?.clientId, 'client-1');
    assert.equal(claims?.mode, 'fullAccess');
    assert.equal(service.verifyTurnToken(`${token}x`), null);

    now += 16 * 60 * 1000;
    assert.equal(service.verifyTurnToken(token), null);
  });

  it('publishes files from approve-for-me mode, stores a manifest, and resolves published assets', async () => {
    const { service, storage } = createService();
    const token = service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'approveForMe',
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
    assert.equal(storage.objects.has('published-sites/by-room/cm9vbS0x/index.json'), true);

    const index = await service.readFile('roomtalk-demo', '');
    assert.equal(index?.file.path, 'index.html');
    assert.match(index!.body.toString('utf8'), /doctype/);

    const asset = await service.readFile('roomtalk-demo', 'assets/app.js');
    assert.equal(asset?.file.mimeType, 'text/javascript; charset=utf-8');
    assert.equal(asset?.body.toString('utf8'), 'console.log("published")');

    const spaFallback = await service.readFile('roomtalk-demo', 'unknown/route');
    assert.equal(spaFallback?.file.path, 'index.html');
  });

  it('lists published artifacts for a room from stored manifests', async () => {
    const ids = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service } = createService({ createId: () => ids.shift() || 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;

    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'first-demo',
      title: 'First Demo',
      entry: 'index.html',
      files: [textFile('index.html', '<!doctype html>first')],
    }, claims);
    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'second-demo',
      title: 'Second Demo',
      entry: 'index.html',
      files: [textFile('index.html', '<!doctype html>second')],
    }, claims);

    const artifacts = await service.listSitesForRoom('room-1', 'https://room.ruit.me/room/abc');

    assert.deepEqual(artifacts.map(artifact => artifact.slug), ['first-demo', 'second-demo']);
    assert.deepEqual(artifacts.map(artifact => artifact.title), ['First Demo', 'Second Demo']);
    assert.deepEqual(artifacts.map(artifact => artifact.url), [
      'https://room.ruit.me/p/first-demo/',
      'https://room.ruit.me/p/second-demo/',
    ]);
    assert.equal(artifacts[0].fileCount, 1);
    assert.equal(artifacts[0].entry, 'index.html');
  });

  it('uses an allowed production client origin for publish URLs', () => {
    const { service } = createService({
      publicBaseUrl: 'https://room.ruit.me',
      allowedPublicBaseUrls: ['https://room.ruit.me', 'https://room.ruit.me'],
      nodeEnv: 'production',
    });

    assert.equal(
      service.publishApiUrlForRequest('https://room.ruit.me/rooms/abc', 'http://127.0.0.1:3012'),
      'https://room.ruit.me/api/code-agent/publish-static-site'
    );
    assert.equal(
      service.publicBaseUrlForRequest('https://room.ruit.me/rooms/abc', 'http://127.0.0.1:3012'),
      'https://room.ruit.me'
    );
    assert.equal(
      service.publishApiUrlForRequest('https://evil.example', 'http://127.0.0.1:3012'),
      'https://room.ruit.me/api/code-agent/publish-static-site'
    );
  });

  it('uses the local server origin outside production even when a public fallback is configured', () => {
    const { service } = createService({
      publicBaseUrl: 'https://room.ruit.me',
      nodeEnv: 'development',
    });

    assert.equal(
      service.publishApiUrlForRequest('https://room.ruit.me', 'http://127.0.0.1:3012'),
      'http://127.0.0.1:3012/api/code-agent/publish-static-site'
    );
    assert.equal(
      service.publicBaseUrlForRequest('https://room.ruit.me', 'http://127.0.0.1:3012'),
      'http://127.0.0.1:3012'
    );
  });

  it('does not let CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL override local request origins from env', () => {
    const service = createPublishedStaticSiteServiceFromEnv({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      env: {
        NODE_ENV: 'development',
        CLIENT_URL: 'http://localhost:3011',
        CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL: 'https://room.ruit.me',
        CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET: 'static-publish-secret',
      } as NodeJS.ProcessEnv,
    });

    assert.equal(
      service.publishApiUrlForRequest('http://localhost:3011', 'http://127.0.0.1:3012'),
      'http://127.0.0.1:3012/api/code-agent/publish-static-site'
    );
    assert.equal(
      service.publicUrlForSlug('roomtalk-demo', 'http://127.0.0.1:3012'),
      'http://127.0.0.1:3012/p/roomtalk-demo/'
    );
  });

  it('uses CLIENT_URLS as the production public origin allowlist from env', () => {
    const service = createPublishedStaticSiteServiceFromEnv({
      mediaObjectStorage: new MemoryMediaObjectStorage(),
      logger,
      env: {
        NODE_ENV: 'production',
        CLIENT_URL: 'https://room.ruit.me',
        CLIENT_URLS: 'https://room.ruit.me, https://room.ruit.me',
        CODE_AGENT_STATIC_PUBLISH_PUBLIC_URL: 'https://room.ruit.me',
        CODE_AGENT_STATIC_PUBLISH_TOKEN_SECRET: 'static-publish-secret',
      } as NodeJS.ProcessEnv,
    });

    assert.equal(
      service.publishApiUrlForRequest('https://room.ruit.me', 'http://127.0.0.1:3012'),
      'https://room.ruit.me/api/code-agent/publish-static-site'
    );
    assert.equal(
      service.publishApiUrlForRequest('https://not-allowed.example', 'http://127.0.0.1:3012'),
      'https://room.ruit.me/api/code-agent/publish-static-site'
    );
  });

  it('deletes every published object for a room', async () => {
    const ids = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service, storage } = createService({ createId: () => ids.shift() || 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;

    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'roomtalk-demo',
      entry: 'index.html',
      files: [
        textFile('index.html', '<!doctype html>v1'),
        textFile('assets/app.js', 'console.log("v1")'),
      ],
    }, claims);
    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'roomtalk-demo',
      entry: 'index.html',
      files: [
        textFile('index.html', '<!doctype html>v2'),
        textFile('assets/app.js', 'console.log("v2")'),
      ],
    }, claims);

    assert.equal([...storage.objects.keys()].filter(key => key.startsWith('published-sites/roomtalk-demo/versions/')).length, 4);

    const result = await service.deleteSitesForRoom('room-1');

    assert.deepEqual(result, { slugCount: 1, objectCount: 6 });
    assert.deepEqual([...storage.objects.keys()].filter(key => key.startsWith('published-sites/')), []);
    assert.equal(storage.deletedObjectKeys.includes('published-sites/by-room/cm9vbS0x/index.json'), true);
  });

  it('unpublishes every stored version for one slug and keeps the room index consistent', async () => {
    const ids = [
      'token-token-token-token-token000001',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service, storage } = createService({ createId: () => ids.shift() || 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'approveForMe',
    }))!;

    for (const version of ['v1', 'v2']) {
      await service.publish({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('index.html', `<!doctype html>${version}`)],
      }, claims);
    }
    await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'keep-demo',
      entry: 'index.html',
      files: [textFile('index.html', '<!doctype html>keep')],
    }, claims);

    const result = await service.unpublish({ slug: 'roomtalk-demo' }, claims);

    assert.equal(result.url, 'https://room.example/p/roomtalk-demo/');
    assert.equal(result.slug, 'roomtalk-demo');
    assert.equal(result.objectCount, 3);
    assert.equal(await service.readManifest('roomtalk-demo'), null);
    assert.equal([...storage.objects.keys()].some(key => key.startsWith('published-sites/roomtalk-demo/')), false);
    assert.deepEqual((await service.listSitesForRoom('room-1')).map(site => site.slug), ['keep-demo']);

    const finalResult = await service.unpublish({ slug: 'keep-demo' }, claims);
    assert.equal(finalResult.objectCount, 3);
    assert.deepEqual([...storage.objects.keys()].filter(key => key.startsWith('published-sites/')), []);
  });

  it('rejects invalid publish payloads and slug ownership conflicts', async () => {
    const { service } = createService();
    const firstClaims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
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
      mode: 'fullAccess',
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

    await assert.rejects(
      service.unpublish({ slug: 'roomtalk-demo' }, secondClaims),
      /belongs to another room/
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
      /requires a writable agent mode/
    );
    await assert.rejects(
      service.unpublish({ slug: 'roomtalk-demo' }, claims),
      /requires a writable agent mode/
    );
  });
});
