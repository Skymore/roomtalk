import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { CodeWorkspaceAssetAccess } from './codeWorkspaceAssetAccess';
import { CodeWorkspaceFilePreviewService } from './codeWorkspaceFilePreview';
import { FakeCodeAgentSandboxService } from './fakeCodeAgentSandboxService';

const createHarness = async () => {
  const sandboxService = new FakeCodeAgentSandboxService(() => new Date('2026-07-07T12:00:00.000Z'));
  const handle = await sandboxService.create({
    roomId: 'room-1',
    creatorId: 'client-1',
    ttlMs: 60_000,
  });
  const assetAccess = new CodeWorkspaceAssetAccess({
    tokenSecret: 'workspace-preview-secret',
    nowMs: () => Date.parse('2026-07-07T12:00:00.000Z'),
    createId: () => 'preview-token-id',
  });
  const service = new CodeWorkspaceFilePreviewService({
    sandboxService,
    assetAccess,
    startTimeoutMs: 0,
    pollIntervalMs: 0,
  });
  return { sandboxService, handle, service };
};

const vitePackageJson = JSON.stringify({
  scripts: {
    dev: 'vite',
    build: 'vite build',
  },
  dependencies: {
    '@vitejs/plugin-react': '^4.0.0',
    vite: '^6.0.0',
    react: '^18.0.0',
  },
});

describe('CodeWorkspaceFilePreviewService', () => {
  it('keeps built HTML files on the static asset preview path', async () => {
    const { sandboxService, handle, service } = await createHarness();
    sandboxService.setWorkspaceFileContent(handle.id, 'package.json', vitePackageJson);
    sandboxService.setWorkspaceFileContent(handle.id, 'dist/index.html', '<!doctype html><script type="module" src="/assets/app.js"></script>');

    const preview = await service.resolve({
      roomId: 'room-1',
      sandboxId: handle.id,
      handle,
      path: 'dist/index.html',
    });

    assert.equal(preview.kind, 'static-file');
    assert.match(preview.kind === 'static-file' ? preview.asset.relativeUrl : '', /\/index\.html$/);
    assert.deepEqual(sandboxService.startedWorkspaceCommands, []);
  });

  it('returns an explicit start state for source app HTML entries', async () => {
    const { sandboxService, handle, service } = await createHarness();
    sandboxService.setWorkspaceFileContent(handle.id, 'package.json', vitePackageJson);
    sandboxService.setWorkspaceFileContent(handle.id, 'vite.config.js', 'export default {};');
    sandboxService.setWorkspaceFileContent(handle.id, 'index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');

    const preview = await service.resolve({
      roomId: 'room-1',
      sandboxId: handle.id,
      handle,
      path: 'index.html',
    });

    assert.equal(preview.kind, 'dev-server');
    assert.equal(preview.kind === 'dev-server' ? preview.frameworkId : '', 'vite');
    assert.equal(preview.kind === 'dev-server' ? preview.status : '', 'stopped');
    assert.deepEqual(sandboxService.startedWorkspaceCommands, []);
  });

  it('detects framework config files from a workspace listing', async () => {
    const { sandboxService, handle, service } = await createHarness();
    sandboxService.setWorkspaceFileContent(handle.id, 'package.json', JSON.stringify({
      scripts: { dev: 'astro dev' },
      dependencies: {},
    }));
    sandboxService.setWorkspaceFileContent(handle.id, 'astro.config.js', 'export default {};');
    sandboxService.setWorkspaceFileContent(handle.id, 'index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');

    const preview = await service.resolve({
      roomId: 'room-1',
      sandboxId: handle.id,
      handle,
      path: 'index.html',
    });

    assert.equal(preview.kind, 'dev-server');
    assert.equal(preview.kind === 'dev-server' ? preview.frameworkId : '', 'astro');
    assert.equal(preview.kind === 'dev-server' ? preview.status : '', 'stopped');
    assert.deepEqual(sandboxService.startedWorkspaceCommands, []);
  });

  it('starts a framework dev server only when requested', async () => {
    const { sandboxService, handle, service } = await createHarness();
    sandboxService.setWorkspaceFileContent(handle.id, 'package.json', vitePackageJson);
    sandboxService.setWorkspaceFileContent(handle.id, 'index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');

    const preview = await service.resolve({
      roomId: 'room-1',
      sandboxId: handle.id,
      handle,
      path: 'index.html',
      startDevServer: true,
    });

    assert.equal(preview.kind, 'dev-server');
    assert.equal(preview.kind === 'dev-server' ? preview.status : '', 'starting');
    assert.equal(sandboxService.startedWorkspaceCommandTimeouts[0], 0);
    assert.equal(
      sandboxService.startedWorkspaceCommandEnvs[0]?.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS,
      `5173-${handle.id}.example.test`,
    );
    assert.match(
      sandboxService.startedWorkspaceCommands[0],
      new RegExp(`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='5173-${handle.id}\\.example\\.test'`),
    );
    assert.match(sandboxService.startedWorkspaceCommands[0], /npm' 'run' 'dev' '--' '--host' '0\.0\.0\.0' '--port' '5173'/);
  });

  it('reuses an already-listening framework dev server', async () => {
    const { sandboxService, handle, service } = await createHarness();
    sandboxService.setWorkspaceFileContent(handle.id, 'package.json', vitePackageJson);
    sandboxService.setWorkspaceFileContent(handle.id, 'index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
    sandboxService.setWorkspacePreviewServers(handle.id, [{
      host: 'localhost',
      port: 5173,
      url: 'http://localhost:5173/',
      processName: 'vite',
      pid: 123,
    }]);

    const preview = await service.resolve({
      roomId: 'room-1',
      sandboxId: handle.id,
      handle,
      path: 'index.html',
    });

    assert.equal(preview.kind, 'dev-server');
    assert.equal(preview.kind === 'dev-server' ? preview.status : '', 'running');
    assert.equal(preview.kind === 'dev-server' ? preview.resolvedUrl : '', `https://5173-${handle.id}.example.test/`);
    assert.deepEqual(sandboxService.startedWorkspaceCommands, []);
  });
});
