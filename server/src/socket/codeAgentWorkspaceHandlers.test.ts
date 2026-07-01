import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CodeWorkspaceAssetAccess } from '../services/codeWorkspaceAssetAccess';
import { CocoWorkspaceChanges, CocoWorkspaceEntry, CocoWorkspaceRef } from '../services/cocoSandboxService';
import { Message, Room, RoomMember } from '../types';
import { registerCodeAgentWorkspaceHandlers } from './codeAgentWorkspaceHandlers';

class FakeSocket {
  id = 'socket-1';
  handshake = {
    headers: {
      origin: 'https://room.ruit.me',
    },
  };
  handlers = new Map<string, (...args: any[]) => unknown>();

  on(event: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(event, handler);
  }

  async invoke<T>(event: string, payload: unknown): Promise<T> {
    const handler = this.handlers.get(event);
    assert.ok(handler, `Expected handler for ${event}`);
    return new Promise<T>((resolve) => {
      void handler(payload, resolve);
    });
  }
}

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const room = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  name: 'Coco',
  description: '',
  createdAt: '2026-05-03T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'coco',
  sandboxStatus: 'ready',
  sandboxId: 'sandbox-1',
  cocoStatus: 'idle',
  cocoSessionId: 'session-1',
  ...overrides,
});

const message = (overrides: Partial<Message>): Message => ({
  id: overrides.id || 'message-1',
  clientId: overrides.clientId || 'coco_runner',
  content: overrides.content || '',
  roomId: overrides.roomId || 'room-1',
  timestamp: '2026-05-03T00:00:00.000Z',
  messageType: overrides.messageType || 'tool_call',
  ...overrides,
});

const member = (roomId = 'room-1', clientId = 'client-1'): RoomMember => ({
  roomId,
  clientId,
  role: 'owner',
  joinedAt: '2026-05-03T00:00:00.000Z',
});

const createHarness = (options: {
  clientId?: string | null;
  currentRoom?: Room;
  members?: RoomMember[];
  messages?: Message[];
  workspaceEntries?: CocoWorkspaceEntry[];
  workspaceRefs?: CocoWorkspaceRef[];
  workspaceHeadRef?: string;
  workspaceChanges?: CocoWorkspaceChanges;
  workspaceDiffPatch?: string;
  workspaceFileContent?: string;
  cocoAccess?: ReturnType<typeof createCocoAccessControl>;
  codeWorkspaceAssetAccess?: CodeWorkspaceAssetAccess;
  publishedArtifacts?: any[];
} = {}) => {
  const socket = new FakeSocket();
  const currentRoom = options.currentRoom || room();
  const members = options.members || [member(currentRoom.id, options.clientId ?? 'client-1')];
  const messages = options.messages || [];
  const listWorkspaceEntriesCalls: Array<{ sandboxId: string; maxDepth?: number; maxEntries?: number }> = [];
  const searchWorkspaceEntriesCalls: Array<{ sandboxId: string; query: string; maxDepth?: number; maxEntries?: number }> = [];
  const listWorkspaceRefsCalls: Array<{ sandboxId: string; query?: string; maxRefs?: number }> = [];
  const getWorkspaceChangesCalls: Array<{ sandboxId: string }> = [];
  const getWorkspaceDiffCalls: Array<{ sandboxId: string; maxBytes?: number; ignoreWhitespace?: boolean; scope?: string; baseRef?: string }> = [];
  const readWorkspaceFileCalls: Array<{ sandboxId: string; path: string; maxBytes?: number }> = [];
  const writeWorkspaceFileCalls: Array<{ sandboxId: string; path: string; content: string; encoding?: 'utf-8' | 'base64' }> = [];
  const createWorkspaceDirectoryCalls: Array<{ sandboxId: string; path: string }> = [];
  const renameWorkspaceEntryCalls: Array<{ sandboxId: string; fromPath: string; toPath: string }> = [];
  const deleteWorkspaceEntryCalls: Array<{ sandboxId: string; path: string }> = [];
  const listSitesForRoomCalls: Array<{ roomId: string; requestBaseUrl?: string }> = [];
  const store = {
    getClientId: async () => options.clientId === undefined ? 'client-1' : options.clientId,
    getRoomById: async (roomId: string) => roomId === currentRoom.id ? currentRoom : null,
    getRoomMember: async (roomId: string, clientId: string) => (
      members.find(item => item.roomId === roomId && item.clientId === clientId) || null
    ),
    readMessagesByRoom: async (roomId: string) => messages.filter(item => item.roomId === roomId),
  };

  registerCodeAgentWorkspaceHandlers({
    io: {} as any,
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
    openaiLogger: logger as any,
    normalizeAIModel: (() => ({})) as any,
    getAIClientForModel: (() => ({})) as any,
    cocoAccess: options.cocoAccess ?? createCocoAccessControl({ enabled: true }),
    codeWorkspaceAssetAccess: options.codeWorkspaceAssetAccess,
    publishedStaticSiteService: {
      publicBaseUrlForRequest: (clientOrigin?: string) => clientOrigin,
      listSitesForRoom: async (roomId: string, requestBaseUrl?: string) => {
        listSitesForRoomCalls.push({ roomId, requestBaseUrl });
        return options.publishedArtifacts || [];
      },
    } as any,
    cocoSandboxService: {
      create: async () => ({
        id: 'sandbox-1',
        provider: 'e2b',
        roomId: currentRoom.id,
        creatorId: currentRoom.creatorId,
        workspace: '/workspace',
        createdAt: '2026-05-03T00:00:00.000Z',
      }),
      connect: async (sandboxId: string) => ({
        id: sandboxId,
        provider: 'e2b',
        roomId: currentRoom.id,
        creatorId: currentRoom.creatorId,
        workspace: '/workspace',
        createdAt: '2026-05-03T00:00:00.000Z',
      }),
      startRunner: async () => ({
        command: 'coco',
        stop: async () => {},
      }),
      getWorkspaceChanges: async (handle) => {
        getWorkspaceChangesCalls.push({ sandboxId: handle.id });
        return options.workspaceChanges || {
          available: false,
          changedFiles: [],
          diffSummary: null,
        };
      },
      getWorkspaceDiff: async (handle, diffOptions) => {
        getWorkspaceDiffCalls.push({
          sandboxId: handle.id,
          maxBytes: diffOptions?.maxBytes,
          ignoreWhitespace: diffOptions?.ignoreWhitespace,
          scope: diffOptions?.scope,
          ...(diffOptions?.baseRef ? { baseRef: diffOptions.baseRef } : {}),
        });
        const patch = options.workspaceDiffPatch || '';
        return {
          available: true,
          patch,
          byteSize: Buffer.byteLength(patch),
          truncated: false,
        };
      },
      listWorkspaceRefs: async (handle, refsOptions) => {
        listWorkspaceRefsCalls.push({
          sandboxId: handle.id,
          query: refsOptions?.query,
          maxRefs: refsOptions?.maxRefs,
        });
        return {
          available: true,
          refs: options.workspaceRefs || [],
          ...(options.workspaceHeadRef ? { headRef: options.workspaceHeadRef } : {}),
        };
      },
      listWorkspaceEntries: async (handle, listOptions) => {
        listWorkspaceEntriesCalls.push({
          sandboxId: handle.id,
          maxDepth: listOptions?.maxDepth,
          maxEntries: listOptions?.maxEntries,
        });
        return options.workspaceEntries || [];
      },
      searchWorkspaceEntries: async (handle, searchOptions) => {
        searchWorkspaceEntriesCalls.push({
          sandboxId: handle.id,
          query: searchOptions.query,
          maxDepth: searchOptions.maxDepth,
          maxEntries: searchOptions.maxEntries,
        });
        return options.workspaceEntries || [];
      },
      readWorkspaceFile: async (handle, path, readOptions) => {
        readWorkspaceFileCalls.push({
          sandboxId: handle.id,
          path,
          maxBytes: readOptions?.maxBytes,
        });
        const content = options.workspaceFileContent ?? 'hello';
        return {
          path,
          content,
          byteSize: Buffer.byteLength(content),
          truncated: false,
          encoding: 'utf-8' as const,
        };
      },
      writeWorkspaceFile: async (handle, input) => {
        writeWorkspaceFileCalls.push({
          sandboxId: handle.id,
          path: input.path,
          content: input.content,
          encoding: input.encoding,
        });
        return {
          path: input.path,
          name: input.path.split('/').pop() || input.path,
          type: 'file' as const,
          size: Buffer.byteLength(input.content),
        };
      },
      createWorkspaceDirectory: async (handle, path) => {
        createWorkspaceDirectoryCalls.push({ sandboxId: handle.id, path });
        return {
          path,
          name: path.split('/').pop() || path,
          type: 'directory' as const,
        };
      },
      renameWorkspaceEntry: async (handle, input) => {
        renameWorkspaceEntryCalls.push({ sandboxId: handle.id, fromPath: input.fromPath, toPath: input.toPath });
        return {
          path: input.toPath,
          name: input.toPath.split('/').pop() || input.toPath,
          type: 'file' as const,
        };
      },
      deleteWorkspaceEntry: async (handle, path) => {
        deleteWorkspaceEntryCalls.push({ sandboxId: handle.id, path });
      },
      destroy: async () => {},
    },
  });

  return {
    socket,
    getWorkspaceChangesCalls,
    getWorkspaceDiffCalls,
    listWorkspaceEntriesCalls,
    searchWorkspaceEntriesCalls,
    listWorkspaceRefsCalls,
    readWorkspaceFileCalls,
    writeWorkspaceFileCalls,
    createWorkspaceDirectoryCalls,
    renameWorkspaceEntryCalls,
    deleteWorkspaceEntryCalls,
    listSitesForRoomCalls,
  };
};

describe('code-agent workspace socket handlers', () => {
  it('returns Coco workspace snapshots through the registered socket session', async () => {
    const { socket, getWorkspaceChangesCalls, listWorkspaceEntriesCalls, listSitesForRoomCalls } = createHarness({
      workspaceChanges: {
        available: true,
        changedFiles: ['src/App.tsx', 'src/index.css'],
        diffSummary: { files: 2, additions: 12, deletions: 3 },
      },
      publishedArtifacts: [
        {
          slug: 'roomtalk-demo',
          title: 'RoomTalk Demo',
          url: 'https://room.ruit.me/p/roomtalk-demo/',
          entry: 'index.html',
          versionId: '20260630T120000Z_aaaaaaaa',
          fileCount: 1,
          totalBytes: 128,
          createdAt: '2026-06-30T12:00:00.000Z',
          updatedAt: '2026-06-30T12:00:00.000Z',
        },
      ],
      messages: [
        message({
          id: 'tool-call-1',
          messageType: 'tool_call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          toolArgs: { file_path: '/workspace/src/App.tsx' },
        }),
        message({
          id: 'tool-result-1',
          messageType: 'tool_result',
          toolCallId: 'tool-1',
          toolName: 'Read',
          toolOutputPreview: 'ok',
        }),
      ],
    });

    const response = await socket.invoke<any>('get_code_workspace_snapshot', { roomId: 'room-1' });

    assert.equal(response.success, true);
    assert.equal(response.snapshot.roomId, 'room-1');
    assert.equal(response.snapshot.backend, 'coco');
    assert.deepEqual(response.snapshot.status, { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true });
    assert.deepEqual(response.snapshot.summary, { toolCalls: 1, toolResults: 1, toolErrors: 0, lastToolName: 'Read' });
    assert.deepEqual(response.snapshot.changes, {
      available: true,
      changedFiles: ['src/App.tsx', 'src/index.css'],
      diffSummary: { files: 2, additions: 12, deletions: 3 },
    });
    assert.deepEqual(response.snapshot.artifacts, [
      {
        slug: 'roomtalk-demo',
        title: 'RoomTalk Demo',
        url: 'https://room.ruit.me/p/roomtalk-demo/',
        entry: 'index.html',
        versionId: '20260630T120000Z_aaaaaaaa',
        fileCount: 1,
        totalBytes: 128,
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      },
    ]);
    assert.deepEqual(response.snapshot.commands, [{ id: 'tool-1', name: 'Read', status: 'succeeded', exitCode: undefined, preview: 'ok' }]);
    assert.deepEqual(getWorkspaceChangesCalls, [{ sandboxId: 'sandbox-1' }]);
    assert.deepEqual(listSitesForRoomCalls, [{ roomId: 'room-1', requestBaseUrl: 'https://room.ruit.me' }]);
    assert.deepEqual(listWorkspaceEntriesCalls, []);
  });

  it('lists Coco workspace entries through the registered socket session', async () => {
    const { socket, listWorkspaceEntriesCalls } = createHarness({
      workspaceEntries: [
        { path: 'output', name: 'output', type: 'directory' },
        { path: 'output/report.html', name: 'report.html', type: 'file', size: 120 },
      ],
    });

    const response = await socket.invoke<any>('list_code_workspace_entries', { roomId: 'room-1' });

    assert.equal(response.success, true);
    assert.equal(response.truncated, false);
    assert.deepEqual(response.entries, [
      { path: 'output', name: 'output', type: 'directory' },
      { path: 'output/report.html', name: 'report.html', type: 'file', size: 120 },
    ]);
    assert.deepEqual(listWorkspaceEntriesCalls, [{ sandboxId: 'sandbox-1', maxDepth: 24, maxEntries: 25001 }]);
  });

  it('searches Coco workspace entries through the registered socket session', async () => {
    const { socket, searchWorkspaceEntriesCalls } = createHarness({
      workspaceEntries: [
        { path: 'src/components/Composer.tsx', name: 'Composer.tsx', type: 'file' },
        { path: 'src/components/composePrompt.ts', name: 'composePrompt.ts', type: 'file' },
        { path: 'docs/composition.md', name: 'composition.md', type: 'file' },
      ],
    });

    const response = await socket.invoke<any>('search_code_workspace_entries', {
      roomId: 'room-1',
      query: '@cmp',
      limit: 2,
    });

    assert.equal(response.success, true);
    assert.equal(response.truncated, true);
    assert.deepEqual(response.entries, [
      { path: 'src/components/Composer.tsx', name: 'Composer.tsx', type: 'file' },
      { path: 'src/components/composePrompt.ts', name: 'composePrompt.ts', type: 'file' },
    ]);
    assert.deepEqual(searchWorkspaceEntriesCalls, [{
      sandboxId: 'sandbox-1',
      query: '@cmp',
      maxDepth: 24,
      maxEntries: 3,
    }]);
  });

  it('lists T3-style workspace refs through the registered socket session', async () => {
    const { socket, listWorkspaceRefsCalls } = createHarness({
      workspaceRefs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'origin/feature/search', kind: 'remote', remoteName: 'origin' },
      ],
      workspaceHeadRef: 'feature/search',
    });

    const response = await socket.invoke<any>('list_code_workspace_refs', {
      roomId: 'room-1',
      query: 'main',
      limit: 25,
    });

    assert.equal(response.success, true);
    assert.deepEqual(response.refs, {
      available: true,
      headRef: 'feature/search',
      refs: [
        { name: 'main', kind: 'local' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'origin/feature/search', kind: 'remote', remoteName: 'origin' },
      ],
    });
    assert.deepEqual(listWorkspaceRefsCalls, [{ sandboxId: 'sandbox-1', query: 'main', maxRefs: 25 }]);
  });

  it('reads Coco workspace files through the registered socket session', async () => {
    const { socket, readWorkspaceFileCalls } = createHarness({
      workspaceFileContent: 'export default {}',
    });

    const response = await socket.invoke<any>('read_code_workspace_file', {
      roomId: 'room-1',
      path: 'src/App.tsx',
    });

    assert.equal(response.success, true);
    assert.deepEqual(response.file, {
      path: 'src/App.tsx',
      content: 'export default {}',
      byteSize: 17,
      truncated: false,
      encoding: 'utf-8',
    });
    assert.deepEqual(readWorkspaceFileCalls, [{ sandboxId: 'sandbox-1', path: 'src/App.tsx', maxBytes: 10485760 }]);
  });

  it('reads Coco workspace diffs through the registered socket session', async () => {
    const patch = [
      'diff --git a/src/App.tsx b/src/App.tsx',
      'index 1111111..2222222 100644',
      '--- a/src/App.tsx',
      '+++ b/src/App.tsx',
      '@@ -1 +1 @@',
      '-export default {}',
      '+export default function App() {}',
      '',
    ].join('\n');
    const { socket, getWorkspaceDiffCalls } = createHarness({
      workspaceDiffPatch: patch,
    });

    const response = await socket.invoke<any>('read_code_workspace_diff', { roomId: 'room-1' });

    assert.equal(response.success, true);
    assert.deepEqual(response.diff, {
      available: true,
      patch,
      byteSize: Buffer.byteLength(patch),
      truncated: false,
    });
    assert.deepEqual(getWorkspaceDiffCalls, [{ sandboxId: 'sandbox-1', maxBytes: 10485760, ignoreWhitespace: false, scope: 'branch' }]);
  });

  it('forwards the T3 whitespace diff option through the socket session', async () => {
    const { socket, getWorkspaceDiffCalls } = createHarness({
      workspaceDiffPatch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
    });

    const response = await socket.invoke<any>('read_code_workspace_diff', {
      roomId: 'room-1',
      ignoreWhitespace: true,
    });

    assert.equal(response.success, true);
    assert.deepEqual(getWorkspaceDiffCalls, [{ sandboxId: 'sandbox-1', maxBytes: 10485760, ignoreWhitespace: true, scope: 'branch' }]);
  });

  it('forwards the T3 working tree diff scope through the socket session', async () => {
    const { socket, getWorkspaceDiffCalls } = createHarness({
      workspaceDiffPatch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
    });

    const response = await socket.invoke<any>('read_code_workspace_diff', {
      roomId: 'room-1',
      scope: 'unstaged',
    });

    assert.equal(response.success, true);
    assert.deepEqual(getWorkspaceDiffCalls, [{ sandboxId: 'sandbox-1', maxBytes: 10485760, ignoreWhitespace: false, scope: 'unstaged' }]);
  });

  it('forwards the T3 branch base ref through the socket session', async () => {
    const { socket, getWorkspaceDiffCalls } = createHarness({
      workspaceDiffPatch: 'diff --git a/src/App.tsx b/src/App.tsx\n',
    });

    const response = await socket.invoke<any>('read_code_workspace_diff', {
      roomId: 'room-1',
      scope: 'branch',
      baseRef: 'origin/main',
    });

    assert.equal(response.success, true);
    assert.deepEqual(getWorkspaceDiffCalls, [{
      sandboxId: 'sandbox-1',
      maxBytes: 10485760,
      ignoreWhitespace: false,
      scope: 'branch',
      baseRef: 'origin/main',
    }]);
  });

  it('creates T3-style workspace asset URLs through the socket control plane', async () => {
    const assetAccess = new CodeWorkspaceAssetAccess({
      tokenSecret: 'workspace-asset-secret',
      nowMs: () => Date.parse('2026-06-30T12:00:00.000Z'),
      createId: () => 'asset-token-id',
    });
    const { socket, readWorkspaceFileCalls } = createHarness({
      codeWorkspaceAssetAccess: assetAccess,
    });

    const response = await socket.invoke<any>('create_code_workspace_asset_url', {
      roomId: 'room-1',
      path: 'output/report.html',
    });

    assert.equal(response.success, true);
    assert.equal(response.asset.expiresAt, '2026-06-30T13:00:00.000Z');
    assert.match(response.asset.relativeUrl, /^\/api\/coco\/workspace-assets\/[^/]+\/report\.html$/);
    assert.deepEqual(readWorkspaceFileCalls, [{ sandboxId: 'sandbox-1', path: 'output/report.html', maxBytes: 1 }]);

    const token = response.asset.relativeUrl.split('/')[4];
    assert.deepEqual(assetAccess.resolveAsset(token, 'assets/app.js'), {
      roomId: 'room-1',
      sandboxId: 'sandbox-1',
      path: 'output/assets/app.js',
      mimeType: 'text/javascript; charset=utf-8',
    });
  });

  it('mutates Coco workspace entries through the registered socket session', async () => {
    const {
      socket,
      writeWorkspaceFileCalls,
      createWorkspaceDirectoryCalls,
      renameWorkspaceEntryCalls,
      deleteWorkspaceEntryCalls,
    } = createHarness();

    assert.deepEqual(await socket.invoke<any>('write_code_workspace_file', {
      roomId: 'room-1',
      path: 'src/App.tsx',
      content: 'export default {}',
      encoding: 'utf-8',
    }), {
      success: true,
      entry: { path: 'src/App.tsx', name: 'App.tsx', type: 'file', size: 17 },
    });
    assert.deepEqual(await socket.invoke<any>('create_code_workspace_directory', {
      roomId: 'room-1',
      path: 'src/components',
    }), {
      success: true,
      entry: { path: 'src/components', name: 'components', type: 'directory' },
    });
    assert.deepEqual(await socket.invoke<any>('rename_code_workspace_entry', {
      roomId: 'room-1',
      fromPath: 'src/App.tsx',
      toPath: 'src/Main.tsx',
    }), {
      success: true,
      entry: { path: 'src/Main.tsx', name: 'Main.tsx', type: 'file' },
    });
    assert.deepEqual(await socket.invoke<any>('delete_code_workspace_entry', {
      roomId: 'room-1',
      path: 'src/Main.tsx',
    }), { success: true });

    assert.deepEqual(writeWorkspaceFileCalls, [{
      sandboxId: 'sandbox-1',
      path: 'src/App.tsx',
      content: 'export default {}',
      encoding: 'utf-8',
    }]);
    assert.deepEqual(createWorkspaceDirectoryCalls, [{ sandboxId: 'sandbox-1', path: 'src/components' }]);
    assert.deepEqual(renameWorkspaceEntryCalls, [{ sandboxId: 'sandbox-1', fromPath: 'src/App.tsx', toPath: 'src/Main.tsx' }]);
    assert.deepEqual(deleteWorkspaceEntryCalls, [{ sandboxId: 'sandbox-1', path: 'src/Main.tsx' }]);
  });

  it('rejects workspace snapshots before socket registration', async () => {
    const { socket } = createHarness({ clientId: null });

    const response = await socket.invoke<any>('get_code_workspace_snapshot', { roomId: 'room-1' });

    assert.deepEqual(response, { success: false, error: 'You are not registered' });
  });

  it('applies Coco rollout controls to workspace snapshots', async () => {
    const { socket } = createHarness({
      cocoAccess: createCocoAccessControl({ enabled: true, allowedClientIds: ['client-2'] }),
    });

    const response = await socket.invoke<any>('get_code_workspace_snapshot', { roomId: 'room-1' });

    assert.deepEqual(response, { success: false, error: 'Coco is not enabled for this user' });
  });
});
