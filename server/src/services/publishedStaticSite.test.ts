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
    assert.equal(storage.objects.has('published-sites/roomtalk-demo/versions.json'), true);
    assert.equal(storage.objects.has(`published-sites/roomtalk-demo/version-manifests/${result.versionId}.json`), true);
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

  it('keeps immutable manifests for every publish and reads each version independently', async () => {
    let now = Date.parse('2026-06-30T12:00:00.000Z');
    const ids = [
      'token000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version1-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version2-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service } = createService({
      nowMs: () => now,
      createId: () => ids.shift() || 'fallback-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;

    const first = await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'versioned-demo',
      files: [textFile('index.html', '<!doctype html>first')],
    }, claims);
    now += 60_000;
    const second = await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'versioned-demo',
      files: [textFile('index.html', '<!doctype html>second')],
    }, claims);

    const [artifact] = await service.listSitesForRoom('room-1');
    assert.equal(artifact.versionId, second.versionId);
    assert.deepEqual(
      new Set(artifact.versions.map(version => version.versionId)),
      new Set([second.versionId, first.versionId])
    );
    assert.equal(artifact.versions[0].isCurrent, true);
    assert.equal(artifact.versions[1].isCurrent, false);
    assert.equal(artifact.versions[1].url, `https://room.example/p/versioned-demo/__versions/${first.versionId}/`);
    assert.match((await service.readFile('versioned-demo', ''))!.body.toString('utf8'), /second/);
    assert.match((await service.readFile('versioned-demo', '', first.versionId))!.body.toString('utf8'), /first/);
    assert.match((await service.readFile('versioned-demo', '', second.versionId))!.body.toString('utf8'), /second/);

    const activated = await service.activateVersion({ slug: 'versioned-demo', versionId: first.versionId }, claims);
    assert.equal(activated.url, 'https://room.example/p/versioned-demo/');
    assert.equal(activated.versionUrl, `https://room.example/p/versioned-demo/__versions/${first.versionId}/`);
    assert.match((await service.readFile('versioned-demo', ''))!.body.toString('utf8'), /first/);
    const [afterActivation] = await service.listSitesForRoom('room-1');
    assert.equal(afterActivation.versionId, first.versionId);
    assert.equal(afterActivation.versions.find(version => version.versionId === first.versionId)?.isCurrent, true);
  });

  it('rebuilds pre-version-index history from retained room object keys', async () => {
    const ids = [
      'token000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version1-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version2-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service, storage } = createService({ createId: () => ids.shift() || 'fallback' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1', clientId: 'client-1', turnId: 'turn-1', mode: 'fullAccess',
    }))!;
    const first = await service.publish({
      roomId: 'room-1', turnId: 'turn-1', slug: 'legacy-demo', files: [textFile('index.html', 'first')],
    }, claims);
    const second = await service.publish({
      roomId: 'room-1', turnId: 'turn-1', slug: 'legacy-demo', files: [textFile('index.html', 'second')],
    }, claims);
    storage.objects.delete('published-sites/legacy-demo/versions.json');
    for (const key of [...storage.objects.keys()]) {
      if (key.startsWith('published-sites/legacy-demo/version-manifests/')) storage.objects.delete(key);
    }

    const [artifact] = await service.listSitesForRoom('room-1');
    assert.deepEqual(
      new Set(artifact.versions.map(version => version.versionId)),
      new Set([second.versionId, first.versionId])
    );
    assert.equal(storage.objects.has('published-sites/legacy-demo/versions.json'), true);
    assert.match((await service.readFile('legacy-demo', '', first.versionId))!.body.toString('utf8'), /first/);
  });

  it('deduplicates concurrent history rebuilds and trusts an existing version index', async () => {
    class CountingStorage extends MemoryMediaObjectStorage {
      headCalls: string[] = [];
      putCalls: string[] = [];

      override async headObject(input: { objectKey: string }) {
        this.headCalls.push(input.objectKey);
        return super.headObject(input);
      }

      override async putMediaObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
        this.putCalls.push(input.objectKey);
        return super.putMediaObject(input);
      }
    }

    const storage = new CountingStorage();
    const ids = [
      'token000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version1-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version2-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service } = createService({ storage, createId: () => ids.shift() || 'fallback' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1', clientId: 'client-1', turnId: 'turn-1', mode: 'fullAccess',
    }))!;
    await service.publish({
      roomId: 'room-1', turnId: 'turn-1', slug: 'dedupe-demo', files: [textFile('index.html', 'first')],
    }, claims);
    await service.publish({
      roomId: 'room-1', turnId: 'turn-1', slug: 'dedupe-demo', files: [textFile('index.html', 'second')],
    }, claims);
    storage.objects.delete('published-sites/dedupe-demo/versions.json');
    for (const key of [...storage.objects.keys()]) {
      if (key.startsWith('published-sites/dedupe-demo/version-manifests/')) storage.objects.delete(key);
    }
    storage.headCalls = [];
    storage.putCalls = [];

    const rebuilt = createService({ storage }).service;
    const [left, right] = await Promise.all([
      rebuilt.listSitesForRoom('room-1'),
      rebuilt.listSitesForRoom('room-1'),
    ]);
    assert.equal(left[0].versions.length, 2);
    assert.equal(right[0].versions.length, 2);
    assert.equal(storage.putCalls.filter(key => key === 'published-sites/dedupe-demo/versions.json').length, 1);

    storage.headCalls = [];
    await rebuilt.listSitesForRoom('room-1');
    assert.deepEqual(storage.headCalls, []);
  });

  it('restores the previous version when the room index commit fails', async () => {
    class FailingRoomIndexStorage extends MemoryMediaObjectStorage {
      failRoomIndex = false;

      override async putMediaObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
        if (this.failRoomIndex && input.objectKey.startsWith('published-sites/by-room/')) {
          throw new Error('room index unavailable');
        }
        return super.putMediaObject(input);
      }
    }

    const storage = new FailingRoomIndexStorage();
    const ids = [
      'token000-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version1-bbbb-cccc-dddd-eeeeeeeeeeee',
      'version2-bbbb-cccc-dddd-eeeeeeeeeeee',
    ];
    const { service } = createService({ storage, createId: () => ids.shift() || 'fallback' });
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;
    const first = await service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'rollback-demo',
      files: [textFile('index.html', '<!doctype html>first')],
    }, claims);

    storage.failRoomIndex = true;
    await assert.rejects(() => service.publish({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'rollback-demo',
      files: [textFile('index.html', '<!doctype html>second')],
    }, claims), /room index unavailable/);

    assert.equal((await service.readManifest('rollback-demo'))?.versionId, first.versionId);
    assert.match((await service.readFile('rollback-demo', ''))!.body.toString('utf8'), /first/);
    assert.deepEqual((await service.listSitesForRoom('room-1'))[0].versions.map(version => version.versionId), [first.versionId]);
    assert.equal([...storage.objects.keys()].some(key => key.includes('version2')), false);
  });

  it('prepares direct object-storage uploads up to 100 MB and finalizes only verified objects', async () => {
    const { service, storage } = createService();
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;

    const maximum = await service.prepareDirectUpload({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'maximum-site',
      entry: 'index.html',
      files: [{ path: 'index.html', byteSize: 100 * 1024 * 1024 }],
    }, claims);
    assert.equal(maximum.files[0].byteSize, 100 * 1024 * 1024);

    await assert.rejects(() => service.prepareDirectUpload({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'too-large',
      entry: 'index.html',
      files: [{ path: 'index.html', byteSize: (100 * 1024 * 1024) + 1 }],
    }, claims), /too large/);

    const prepared = await service.prepareDirectUpload({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'direct-site',
      title: 'Direct site',
      entry: 'index.html',
      files: [
        { path: 'index.html', byteSize: 15 },
        { path: 'assets/app.js', byteSize: 17 },
      ],
    }, claims);
    for (const file of prepared.files) {
      const objectKey = decodeURIComponent(new URL(file.uploadUrl).pathname.slice(1));
      await storage.putMediaObject({
        objectKey,
        body: Buffer.alloc(file.byteSize),
        mimeType: file.mimeType,
        byteSize: file.byteSize,
      });
    }

    const result = await service.finalizeDirectUpload({ uploadToken: prepared.uploadToken }, claims);
    assert.equal(result.slug, 'direct-site');
    assert.equal(result.fileCount, 2);
    assert.equal(result.totalBytes, 32);
    assert.equal((await service.readManifest('direct-site'))?.versionId, prepared.versionId);
  });

  it('refuses to finalize a direct upload when an object is missing or has the wrong size', async () => {
    const { service, storage } = createService();
    const claims = service.verifyTurnToken(service.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'fullAccess',
    }))!;
    const prepared = await service.prepareDirectUpload({
      roomId: 'room-1',
      turnId: 'turn-1',
      slug: 'incomplete-site',
      files: [{ path: 'index.html', byteSize: 10 }],
    }, claims);

    await assert.rejects(
      () => service.finalizeDirectUpload({ uploadToken: prepared.uploadToken }, claims),
      /upload is missing/
    );
    const objectKey = decodeURIComponent(new URL(prepared.files[0].uploadUrl).pathname.slice(1));
    await storage.putMediaObject({
      objectKey,
      body: Buffer.alloc(9),
      mimeType: prepared.files[0].mimeType,
      byteSize: 9,
    });
    await assert.rejects(
      () => service.finalizeDirectUpload({ uploadToken: prepared.uploadToken }, claims),
      /size does not match/
    );
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
      allowedPublicBaseUrls: ['https://room.ruit.me', 'https://admin.room.ruit.me'],
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
        CLIENT_URLS: 'https://room.ruit.me, https://admin.room.ruit.me',
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

    assert.deepEqual(result, { slugCount: 1, objectCount: 9 });
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

    let firstVersionId = '';
    for (const version of ['v1', 'v2']) {
      const published = await service.publish({
        roomId: 'room-1',
        turnId: 'turn-1',
        slug: 'roomtalk-demo',
        entry: 'index.html',
        files: [textFile('index.html', `<!doctype html>${version}`)],
      }, claims);
      if (!firstVersionId) firstVersionId = published.versionId;
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
    assert.equal(result.objectCount, 6);
    assert.equal(await service.readManifest('roomtalk-demo'), null);
    assert.equal(await service.readFile('roomtalk-demo', '', firstVersionId), null);
    assert.equal([...storage.objects.keys()].some(key => key.startsWith('published-sites/roomtalk-demo/')), false);
    assert.deepEqual((await service.listSitesForRoom('room-1')).map(site => site.slug), ['keep-demo']);

    const finalResult = await service.unpublish({ slug: 'keep-demo' }, claims);
    assert.equal(finalResult.objectCount, 5);
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
