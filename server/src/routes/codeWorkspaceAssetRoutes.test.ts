import assert from 'assert/strict';
import express from 'express';
import { AddressInfo } from 'net';
import { Server as HttpServer } from 'http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger } from '../logger';
import { CodeAgentSandboxHandle, CodeAgentSandboxService } from '../services/codeAgentSandboxService';
import { CodeWorkspaceAssetAccess } from '../services/codeWorkspaceAssetAccess';
import { Room } from '../types';
import { registerCodeWorkspaceAssetRoutes } from './codeWorkspaceAssetRoutes';

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  assetAccess: CodeWorkspaceAssetAccess;
  files: Map<string, Buffer>;
  room: Room;
};

const createRoom = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Code Agent',
  description: '',
  createdAt: '2026-06-30T12:00:00.000Z',
  creatorId: 'client-1',
  type: 'codeAgent',
  sandboxId: 'sandbox-1',
  sandboxStatus: 'ready',
  codeAgentStatus: 'idle',
  ...overrides,
});

const createSandboxService = (files: Map<string, Buffer>): CodeAgentSandboxService => ({
  create: async () => ({
    id: 'sandbox-1',
    provider: 'fake',
    roomId: 'room-1',
    creatorId: 'client-1',
    workspace: '/workspace',
    createdAt: '2026-06-30T12:00:00.000Z',
  }),
  connect: async (sandboxId: string): Promise<CodeAgentSandboxHandle> => ({
    id: sandboxId,
    provider: 'fake',
    roomId: 'room-1',
    creatorId: 'client-1',
    workspace: '/workspace',
    createdAt: '2026-06-30T12:00:00.000Z',
  }),
  startRunner: async () => ({
    command: 'code-agent',
    stop: async () => {},
  }),
  readWorkspaceAsset: async (_handle, workspacePath, options) => {
    const body = files.get(workspacePath);
    if (!body) {
      throw new Error(`Missing workspace asset: ${workspacePath}`);
    }
    const maxBytes = options?.maxBytes ?? 25 * 1024 * 1024;
    const truncated = body.byteLength > maxBytes;
    return {
      path: workspacePath,
      body: truncated ? body.subarray(0, maxBytes) : body,
      byteSize: body.byteLength,
      truncated,
    };
  },
  destroy: async () => {},
});

const createTestServer = async (maxAssetBytes?: number): Promise<TestServer> => {
  const app = express();
  const files = new Map<string, Buffer>();
  const room = createRoom();
  const assetAccess = new CodeWorkspaceAssetAccess({
    tokenSecret: 'workspace-asset-secret',
    nowMs: () => Date.parse('2026-06-30T12:00:00.000Z'),
    createId: () => 'asset-token-id',
  });
  registerCodeWorkspaceAssetRoutes(app, {
    assetAccess,
    logger: new Logger('CodeWorkspaceAssetRoutesTest'),
    getRoomById: async roomId => roomId === room.id ? room : null,
    codeAgentSandboxService: createSandboxService(files),
    ...(maxAssetBytes !== undefined ? { maxAssetBytes } : {}),
  });

  const server = await new Promise<HttpServer>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
    assetAccess,
    files,
    room,
  };
};

describe('code workspace asset routes', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves T3-style workspace-file previews and sibling browser assets', async () => {
    server.files.set('output/report.html', Buffer.from('<!doctype html><script src="assets/app.js"></script>', 'utf8'));
    server.files.set('output/assets/app.js', Buffer.from('window.reportReady = true', 'utf8'));

    const asset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/report.html',
    });

    const entryResponse = await fetch(`${server.baseUrl}${asset.relativeUrl}`);
    assert.equal(entryResponse.status, 200);
    assert.match(entryResponse.headers.get('content-type') || '', /^text\/html/);
    assert.equal(
      entryResponse.headers.get('content-security-policy'),
      "sandbox allow-scripts allow-forms allow-popups; base-uri 'none'; object-src 'none'"
    );
    assert.equal(await entryResponse.text(), '<!doctype html><script src="assets/app.js"></script>');

    const siblingUrl = new URL('assets/app.js', `${server.baseUrl}${asset.relativeUrl}`).toString();
    const siblingResponse = await fetch(siblingUrl);
    assert.equal(siblingResponse.status, 200);
    assert.match(siblingResponse.headers.get('content-type') || '', /^text\/javascript/);
    assert.equal(await siblingResponse.text(), 'window.reportReady = true');
  });

  it('serves preview entry files inside hidden directories while blocking hidden sibling assets', async () => {
    server.files.set('.storybook/index.html', Buffer.from('<!doctype html><script src="preview.js"></script><script src=".secret.js"></script>', 'utf8'));
    server.files.set('.storybook/preview.js', Buffer.from('window.previewReady = true', 'utf8'));
    server.files.set('.storybook/.secret.js', Buffer.from('window.secretReady = true', 'utf8'));

    const asset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: '.storybook/index.html',
    });

    const entryResponse = await fetch(`${server.baseUrl}${asset.relativeUrl}`);
    assert.equal(entryResponse.status, 200);
    assert.match(entryResponse.headers.get('content-type') || '', /^text\/html/);
    assert.equal(await entryResponse.text(), '<!doctype html><script src="preview.js"></script><script src=".secret.js"></script>');

    const siblingResponse = await fetch(new URL('preview.js', `${server.baseUrl}${asset.relativeUrl}`).toString());
    assert.equal(siblingResponse.status, 200);
    assert.match(siblingResponse.headers.get('content-type') || '', /^text\/javascript/);
    assert.equal(await siblingResponse.text(), 'window.previewReady = true');

    const hiddenSiblingResponse = await fetch(new URL('.secret.js', `${server.baseUrl}${asset.relativeUrl}`).toString());
    assert.equal(hiddenSiblingResponse.status, 404);
  });

  it('serves image previews as exact workspace-file assets only', async () => {
    server.files.set('output/chart.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />', 'utf8'));
    server.files.set('output/chart.css', Buffer.from('body{}', 'utf8'));

    const asset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/chart.svg',
    });

    const imageResponse = await fetch(`${server.baseUrl}${asset.relativeUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type') || '', /^image\/svg\+xml/);

    const siblingResponse = await fetch(new URL('chart.css', `${server.baseUrl}${asset.relativeUrl}`).toString());
    assert.equal(siblingResponse.status, 404);
  });

  it('serves hidden image preview files as exact workspace-file assets like T3', async () => {
    server.files.set('output/.logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    server.files.set('output/logo.css', Buffer.from('body{}', 'utf8'));

    const asset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/.logo.png',
    });

    const imageResponse = await fetch(`${server.baseUrl}${asset.relativeUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type') || '', /^image\/png/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const siblingResponse = await fetch(new URL('logo.css', `${server.baseUrl}${asset.relativeUrl}`).toString());
    assert.equal(siblingResponse.status, 404);
  });

  it('rejects stale sandbox asset URLs and oversized previews', async () => {
    server.files.set('output/report.html', Buffer.from('x'.repeat(32), 'utf8'));
    const asset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/report.html',
    });

    server.room.sandboxId = 'sandbox-2';
    const staleResponse = await fetch(`${server.baseUrl}${asset.relativeUrl}`);
    assert.equal(staleResponse.status, 404);

    await server.close();
    server = await createTestServer(16);
    server.files.set('output/report.html', Buffer.from('x'.repeat(32), 'utf8'));
    const largeAsset = server.assetAccess.issueAssetUrl({
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/report.html',
    });

    const largeResponse = await fetch(`${server.baseUrl}${largeAsset.relativeUrl}`);
    assert.equal(largeResponse.status, 413);
  });
});
