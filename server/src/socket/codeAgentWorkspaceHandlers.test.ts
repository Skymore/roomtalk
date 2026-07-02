import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CodeWorkspaceAssetAccess } from '../services/codeWorkspaceAssetAccess';
import { CocoWorkspaceChanges, CocoWorkspaceEntry, CocoWorkspacePreviewServer, CocoWorkspaceRef } from '../services/cocoSandboxService';
import { Message, Room, RoomMember } from '../types';
import { registerCodeAgentWorkspaceHandlers } from './codeAgentWorkspaceHandlers';

class FakeSocket {
  id: string;
  handshake = {
    headers: {
      origin: 'https://room.ruit.me',
    },
  };
  handlers = new Map<string, (...args: any[]) => unknown>();
  emittedEvents: Array<{ event: string; payload: unknown }> = [];

  constructor(id = 'socket-1') {
    this.id = id;
  }

  on(event: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload: unknown) {
    this.emittedEvents.push({ event, payload });
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

const normalizeHarnessWorkspacePath = (value: string, workspaceRoot: string): string => {
  const normalizedValue = value.trim().replace(/\\/g, '/');
  const workspacePrefix = workspaceRoot.replace(/\/+$/, '');
  const relativePath = normalizedValue.startsWith(`${workspacePrefix}/`)
    ? normalizedValue.slice(workspacePrefix.length + 1)
    : normalizedValue.replace(/^\/+/, '');
  return relativePath.split('/').filter(Boolean).join('/');
};

const createHarness = (options: {
  clientId?: string | null;
  socketId?: string;
  currentRoom?: Room;
  members?: RoomMember[];
  messages?: Message[];
  workspaceEntries?: CocoWorkspaceEntry[];
  workspaceRefs?: CocoWorkspaceRef[];
  workspaceHeadRef?: string;
  workspaceChanges?: CocoWorkspaceChanges;
  workspaceDiffPatch?: string;
  workspaceFileContent?: string;
  workspacePreviewServers?: CocoWorkspacePreviewServer[];
  workspaceRoot?: string;
  workspacePreviewTargetResolvedUrl?: string;
  cocoAccess?: ReturnType<typeof createCocoAccessControl>;
  codeWorkspaceAssetAccess?: CodeWorkspaceAssetAccess;
  publishedArtifacts?: any[];
} = {}) => {
  const socket = new FakeSocket(options.socketId);
  const currentRoom = options.currentRoom || room();
  const members = options.members || [member(currentRoom.id, options.clientId ?? 'client-1')];
  const messages = options.messages || [];
  const listWorkspaceEntriesCalls: Array<{ sandboxId: string; maxDepth?: number; maxEntries?: number }> = [];
  const searchWorkspaceEntriesCalls: Array<{ sandboxId: string; query: string; maxDepth?: number; maxEntries?: number }> = [];
  const listWorkspaceRefsCalls: Array<{ sandboxId: string; query?: string; maxRefs?: number }> = [];
  const getWorkspaceChangesCalls: Array<{ sandboxId: string }> = [];
  const getWorkspaceDiffCalls: Array<{ sandboxId: string; maxBytes?: number; ignoreWhitespace?: boolean; scope?: string; baseRef?: string }> = [];
  const readWorkspaceFileCalls: Array<{ sandboxId: string; path: string; maxBytes?: number }> = [];
  const resolveWorkspacePreviewTargetCalls: Array<{ sandboxId: string; port: number; protocol?: 'http' | 'https'; path?: string }> = [];
  const listWorkspacePreviewServersCalls: Array<{ sandboxId: string }> = [];
  const writeWorkspaceFileCalls: Array<{ sandboxId: string; path: string; content: string; encoding?: 'utf-8' | 'base64' }> = [];
  const createWorkspaceDirectoryCalls: Array<{ sandboxId: string; path: string }> = [];
  const renameWorkspaceEntryCalls: Array<{ sandboxId: string; fromPath: string; toPath: string }> = [];
  const deleteWorkspaceEntryCalls: Array<{ sandboxId: string; path: string }> = [];
  const listSitesForRoomCalls: Array<{ roomId: string; requestBaseUrl?: string }> = [];
  const socketEvents: Array<{ roomId: string; event: string; payload: unknown }> = [];
  const io = {
    to: (roomId: string) => ({
      emit: (event: string, payload: unknown) => {
        socketEvents.push({ roomId, event, payload });
      },
    }),
  };
  const workspaceRoot = options.workspaceRoot || '/workspace';
  const store = {
    getClientId: async () => options.clientId === undefined ? 'client-1' : options.clientId,
    getRoomById: async (roomId: string) => roomId === currentRoom.id ? currentRoom : null,
    getRoomMember: async (roomId: string, clientId: string) => (
      members.find(item => item.roomId === roomId && item.clientId === clientId) || null
    ),
    readMessagesByRoom: async (roomId: string) => messages.filter(item => item.roomId === roomId),
  };

  registerCodeAgentWorkspaceHandlers({
    io: io as any,
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
        workspace: workspaceRoot,
        createdAt: '2026-05-03T00:00:00.000Z',
      }),
      connect: async (sandboxId: string) => ({
        id: sandboxId,
        provider: 'e2b',
        roomId: currentRoom.id,
        creatorId: currentRoom.creatorId,
        workspace: workspaceRoot,
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
          changedFileStats: [],
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
          path: normalizeHarnessWorkspacePath(path, workspaceRoot),
          content,
          byteSize: Buffer.byteLength(content),
          truncated: false,
          encoding: 'utf-8' as const,
        };
      },
      resolveWorkspacePreviewTarget: async (handle, input) => {
        resolveWorkspacePreviewTargetCalls.push({
          sandboxId: handle.id,
          port: input.port,
          protocol: input.protocol,
          path: input.path,
        });
        const path = input.path ?? '/';
        return {
          requestedUrl: `${input.protocol ?? 'http'}://localhost:${input.port}${path}`,
          resolvedUrl: options.workspacePreviewTargetResolvedUrl ?? `https://${input.port}-sandbox.e2b.dev${path}`,
          resolutionKind: 'e2b-port-host' as const,
        };
      },
      listWorkspacePreviewServers: async (handle) => {
        listWorkspacePreviewServersCalls.push({ sandboxId: handle.id });
        return options.workspacePreviewServers || [];
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
          size: input.encoding === 'base64'
            ? Buffer.from(input.content, 'base64').byteLength
            : Buffer.byteLength(input.content),
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
    resolveWorkspacePreviewTargetCalls,
    listWorkspacePreviewServersCalls,
    writeWorkspaceFileCalls,
    createWorkspaceDirectoryCalls,
    renameWorkspaceEntryCalls,
    deleteWorkspaceEntryCalls,
    listSitesForRoomCalls,
    socketEvents,
  };
};

describe('code-agent workspace socket handlers', () => {
  it('returns Coco workspace snapshots through the registered socket session', async () => {
    const { socket, getWorkspaceChangesCalls, listWorkspaceEntriesCalls, listSitesForRoomCalls } = createHarness({
      workspaceRoot: '/workspace/room-1',
      workspaceChanges: {
        available: true,
        changedFiles: ['src/App.tsx', 'src/index.css'],
        changedFileStats: [
          { path: 'src/App.tsx', additions: 10, deletions: 2 },
          { path: 'src/index.css', additions: 2, deletions: 1 },
        ],
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
    assert.equal(response.snapshot.workspaceRoot, '/workspace/room-1');
    assert.deepEqual(response.snapshot.status, { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true });
    assert.deepEqual(response.snapshot.summary, { toolCalls: 1, toolResults: 1, toolErrors: 0, lastToolName: 'Read' });
    assert.deepEqual(response.snapshot.changes, {
      available: true,
      changedFiles: ['src/App.tsx', 'src/index.css'],
      changedFileStats: [
        { path: 'src/App.tsx', additions: 10, deletions: 2 },
        { path: 'src/index.css', additions: 2, deletions: 1 },
      ],
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

  it('tracks cloud preview sessions and viewport changes through the socket control plane', async () => {
    const { socket, socketEvents } = createHarness({
      currentRoom: room({ sandboxStatus: 'creating', sandboxId: undefined }),
    });

    const opened = await socket.invoke<any>('open_code_workspace_preview_session', {
      roomId: 'room-1',
      tabId: 'browser:new',
      url: 'https://example.com/app',
      title: 'Example',
      viewport: { _tag: 'fill' },
    });

    assert.equal(opened.success, true);
    assert.deepEqual(opened.session.navStatus, {
      _tag: 'Loading',
      url: 'https://example.com/app',
      title: 'Example',
    });
    assert.deepEqual(opened.session.viewport, { _tag: 'fill' });
    assert.equal(socketEvents.at(-1)?.event, 'code_workspace_preview_event');
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'opened');

    const resized = await socket.invoke<any>('resize_code_workspace_preview_session', {
      roomId: 'room-1',
      tabId: 'browser:new',
      viewport: { _tag: 'freeform', width: 393, height: 852 },
    });

    assert.equal(resized.success, true);
    assert.deepEqual(resized.session.viewport, { _tag: 'freeform', width: 393, height: 852 });
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'resized');

    const reported = await socket.invoke<any>('report_code_workspace_preview_session', {
      roomId: 'room-1',
      tabId: 'browser:new',
      navStatus: {
        _tag: 'Success',
        url: 'https://example.com/app',
        title: 'Example App',
      },
      renderedViewport: { width: 393, height: 852 },
    });

    assert.equal(reported.success, true);
    assert.deepEqual(reported.session.navStatus, {
      _tag: 'Success',
      url: 'https://example.com/app',
      title: 'Example App',
    });
    assert.deepEqual(reported.session.renderedViewport, { width: 393, height: 852 });
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'status');

    const resizedAgain = await socket.invoke<any>('resize_code_workspace_preview_session', {
      roomId: 'room-1',
      tabId: 'browser:new',
      viewport: { _tag: 'fill' },
    });

    assert.equal(resizedAgain.success, true);
    assert.deepEqual(resizedAgain.session.viewport, { _tag: 'fill' });
    assert.equal(resizedAgain.session.renderedViewport, undefined);
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'resized');

    const listed = await socket.invoke<any>('list_code_workspace_preview_sessions', {
      roomId: 'room-1',
    });
    assert.equal(listed.success, true);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].tabId, 'browser:new');

    const closed = await socket.invoke<any>('close_code_workspace_preview_session', {
      roomId: 'room-1',
      tabId: 'browser:new',
    });
    assert.equal(closed.success, true);
    assert.deepEqual(closed.sessions, []);
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'closed');
  });

  it('resolves environment-port browser preview targets through the ready sandbox', async () => {
    const { socket, resolveWorkspacePreviewTargetCalls } = createHarness();

    const resolved = await socket.invoke<any>('resolve_code_workspace_preview_target', {
      roomId: 'room-1',
      target: {
        kind: 'environment-port',
        port: 5173,
        path: '/dashboard?tab=preview',
      },
    });

    assert.equal(resolved.success, true);
    assert.deepEqual(resolved.target, {
      requestedUrl: 'http://localhost:5173/dashboard?tab=preview',
      resolvedUrl: 'https://5173-sandbox.e2b.dev/dashboard?tab=preview',
      resolutionKind: 'e2b-port-host',
    });
    assert.deepEqual(resolveWorkspacePreviewTargetCalls, [{
      sandboxId: 'sandbox-1',
      port: 5173,
      protocol: undefined,
      path: '/dashboard?tab=preview',
    }]);
  });

  it('lists browser preview servers through the ready sandbox', async () => {
    const { socket, listWorkspacePreviewServersCalls } = createHarness({
      workspacePreviewServers: [
        {
          host: 'localhost',
          port: 5173,
          url: 'http://localhost:5173/',
          processName: 'vite',
          pid: 1234,
        },
      ],
    });

    const listed = await socket.invoke<any>('list_code_workspace_preview_servers', {
      roomId: 'room-1',
    });

    assert.equal(listed.success, true);
    assert.deepEqual(listed.servers, [
      {
        host: 'localhost',
        port: 5173,
        url: 'http://localhost:5173/',
        processName: 'vite',
        pid: 1234,
      },
    ]);
    assert.deepEqual(listWorkspacePreviewServersCalls, [{ sandboxId: 'sandbox-1' }]);
  });

  it('routes cloud preview automation requests through registered socket hosts', async () => {
    const { socket, socketEvents } = createHarness({
      currentRoom: room({ sandboxStatus: 'creating', sandboxId: undefined }),
    });

    const connected = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-1',
      focused: true,
      supportedOperations: ['status', 'navigate', 'resize'],
    });

    assert.equal(connected.success, true);
    assert.equal(connected.connectionId, 'automation-1');
    assert.equal(connected.host.clientId, 'client-1');
    assert.deepEqual(connected.host.supportedOperations, ['status', 'navigate', 'resize']);
    assert.equal(socket.emittedEvents.at(-1)?.event, 'code_workspace_preview_automation_event');
    assert.equal((socket.emittedEvents.at(-1)?.payload as any).type, 'connected');

    const focused = await socket.invoke<any>('focus_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-1',
      focused: false,
    });

    assert.equal(focused.success, true);
    assert.equal(focused.host.focused, false);

    const listed = await socket.invoke<any>('list_code_workspace_preview_automation_hosts', {
      roomId: 'room-1',
    });

    assert.equal(listed.success, true);
    assert.equal(listed.hosts.length, 1);
    assert.equal(listed.hosts[0].connectionId, 'automation-1');

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'request-1',
      operation: 'navigate',
      tabId: 'browser:new',
      input: { url: 'https://example.com/app' },
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const requestEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
    ));
    assert.ok(requestEvent);
    assert.equal((requestEvent.payload as any).connectionId, 'automation-1');
    assert.deepEqual((requestEvent.payload as any).request, {
      requestId: 'request-1',
      roomId: 'room-1',
      tabId: 'browser:new',
      tabIdExplicit: true,
      operation: 'navigate',
      input: { url: 'https://example.com/app' },
      timeoutMs: 1000,
    });

    const responseAck = await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-1',
      requestId: 'request-1',
      ok: true,
      result: { url: 'https://example.com/app', loading: false },
    });
    const requestAck = await requestPromise;

    assert.equal(responseAck.success, true);
    assert.equal(requestAck.success, true);
    assert.deepEqual(requestAck.response.result, { url: 'https://example.com/app', loading: false });
    assert.equal(socketEvents.at(-1)?.event, 'code_workspace_preview_automation_response');
  });

  it('unregisters disposed preview automation hosts and fails their pending requests', async () => {
    const currentRoom = room({ id: 'room-preview-dispose', sandboxStatus: 'ready', sandboxId: 'sandbox-1' });
    const { socket, socketEvents } = createHarness({
      currentRoom,
    });

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-disposed',
      tabId: 'browser:disposed',
      focused: true,
      supportedOperations: ['status'],
    });

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'request-disposed',
      operation: 'status',
      tabId: 'browser:disposed',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const requestEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'request-disposed'
    ));
    assert.ok(requestEvent);
    assert.equal((requestEvent.payload as any).connectionId, 'automation-disposed');

    const disconnectAck = await socket.invoke<any>('disconnect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-disposed',
    });
    const requestAck = await requestPromise;

    assert.equal(disconnectAck.success, true);
    assert.equal(requestAck.success, false);
    assert.equal(requestAck.error, 'Preview automation host disconnected');
    assert.equal(socketEvents.at(-1)?.event, 'code_workspace_preview_automation_host_event');
    assert.equal((socketEvents.at(-1)?.payload as any).type, 'disconnected');

    const listed = await socket.invoke<any>('list_code_workspace_preview_automation_hosts', {
      roomId: currentRoom.id,
    });
    assert.deepEqual(listed.hosts, []);

    const lateResponse = await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-disposed',
      requestId: 'request-disposed',
      ok: true,
      result: { available: true },
    });
    assert.equal(lateResponse.success, false);
    assert.equal(lateResponse.error, 'Preview automation host is not connected');
  });

  it('fails pending preview automation requests when reconnect replaces a host', async () => {
    const currentRoom = room({ id: 'room-preview-reconnect', sandboxStatus: 'ready', sandboxId: 'sandbox-1' });
    const { socket } = createHarness({
      currentRoom,
    });

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-old',
      tabId: 'browser:reconnect',
      focused: true,
      supportedOperations: ['status'],
    });

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'request-replaced',
      operation: 'status',
      tabId: 'browser:reconnect',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const reconnectAck = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-new',
      tabId: 'browser:reconnect',
      focused: true,
      supportedOperations: ['status'],
    });
    const requestAck = await requestPromise;

    assert.equal(reconnectAck.success, true);
    assert.equal(requestAck.success, false);
    assert.equal(requestAck.error, 'Preview automation host disconnected');

    const listed = await socket.invoke<any>('list_code_workspace_preview_automation_hosts', {
      roomId: currentRoom.id,
    });
    assert.deepEqual(listed.hosts.map((host: any) => host.connectionId), ['automation-new']);
  });

  it('normalizes cloud preview automation tool input before routing', async () => {
    const { socket } = createHarness({
      currentRoom: room({ sandboxStatus: 'ready', sandboxId: 'sandbox-1' }),
    });

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-tool-input',
      tabId: 'browser:target',
      focused: true,
      supportedOperations: ['navigate'],
    });

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'request-tool-input',
      operation: 'navigate',
      input: {
        tabId: 'browser:target',
        timeoutMs: 2345,
        url: 'https://example.com/app',
        readiness: 'domContentLoaded',
      },
    });

    await new Promise(resolve => setImmediate(resolve));
    const requestEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'request-tool-input'
    ));

    assert.ok(requestEvent);
    assert.equal((requestEvent.payload as any).connectionId, 'automation-tool-input');
    assert.deepEqual((requestEvent.payload as any).request, {
      requestId: 'request-tool-input',
      roomId: 'room-1',
      tabId: 'browser:target',
      tabIdExplicit: true,
      operation: 'navigate',
      input: {
        url: 'https://example.com/app',
        readiness: 'domContentLoaded',
      },
      timeoutMs: 2345,
    });

    await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-tool-input',
      requestId: 'request-tool-input',
      ok: true,
      result: { tabId: 'browser:target', url: 'https://example.com/app', loading: false },
    });

    const requestAck = await requestPromise;
    assert.equal(requestAck.success, true);
    assert.deepEqual(requestAck.response.result, {
      tabId: 'browser:target',
      url: 'https://example.com/app',
      loading: false,
    });
  });

  it('rejects invalid cloud preview automation input before dispatching to hosts', async () => {
    const { socket } = createHarness({
      currentRoom: room({ sandboxStatus: 'ready', sandboxId: 'sandbox-1' }),
    });

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-validation',
      focused: true,
      supportedOperations: ['navigate', 'click'],
    });
    const emittedBefore = socket.emittedEvents.length;

    const invalidNavigate = await socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'request-invalid-navigate',
      operation: 'navigate',
      input: {
        url: 'https://example.com/app',
        target: { kind: 'environment-port', port: 5173 },
      },
    });
    const invalidClick = await socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'request-invalid-click',
      operation: 'click',
      input: {
        selector: '#save',
        locator: 'role=button[name="Save"]',
      },
    });

    assert.equal(invalidNavigate.success, false);
    assert.equal(invalidNavigate.error, 'Preview automation navigate requires exactly one of url or target');
    assert.equal(invalidClick.success, false);
    assert.equal(invalidClick.error, 'Preview automation click accepts at most one of selector or locator');
    assert.equal(socket.emittedEvents.length, emittedBefore);
  });

  it('preserves typed cloud preview automation failure details', async () => {
    const { socket, socketEvents } = createHarness({
      currentRoom: room({ sandboxStatus: 'ready', sandboxId: 'sandbox-1' }),
    });

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-errors',
      tabId: 'browser:preview',
      focused: true,
      supportedOperations: ['type'],
    });

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'request-not-editable',
      operation: 'type',
      tabId: 'browser:preview',
      input: { selector: '#submit', text: 'hello' },
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const responseAck = await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-errors',
      requestId: 'request-not-editable',
      ok: false,
      error: {
        _tag: 'PreviewAutomationTargetNotEditableError',
        message: 'Preview automation type request request-not-editable requires an editable target in tab browser:preview.',
        detail: {
          requestId: 'request-not-editable',
          operation: 'type',
          roomId: 'room-1',
          tabId: 'browser:preview',
          selectorKind: 'selector',
          selectorLength: 7,
        },
      },
    });
    const requestAck = await requestPromise;

    const expectedError = {
      _tag: 'PreviewAutomationTargetNotEditableError',
      message: 'Preview automation type request request-not-editable requires an editable target in tab browser:preview.',
      detail: {
        requestId: 'request-not-editable',
        operation: 'type',
        roomId: 'room-1',
        tabId: 'browser:preview',
        selectorKind: 'selector',
        selectorLength: 7,
      },
    };
    assert.equal(responseAck.success, true);
    assert.equal(requestAck.success, true);
    assert.deepEqual(requestAck.response.error, expectedError);
    assert.deepEqual((socketEvents.at(-1)?.payload as any).response.error, expectedError);
  });

  it('routes tab-targeted preview automation to the matching host', async () => {
    const { socket } = createHarness({
      currentRoom: room({ sandboxStatus: 'ready', sandboxId: 'sandbox-1' }),
    });

    const leftConnected = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-left',
      tabId: 'browser:left',
      focused: false,
      supportedOperations: ['status', 'snapshot'],
    });
    const rightConnected = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-right',
      tabId: 'browser:right',
      focused: true,
      supportedOperations: ['status', 'snapshot'],
    });

    assert.equal(leftConnected.success, true);
    assert.equal(leftConnected.host.tabId, 'browser:left');
    assert.equal(rightConnected.success, true);
    assert.equal(rightConnected.host.tabId, 'browser:right');

    const listed = await socket.invoke<any>('list_code_workspace_preview_automation_hosts', {
      roomId: 'room-1',
    });
    assert.equal(listed.success, true);
    assert.ok(listed.hosts.some((host: any) => host.connectionId === 'automation-left'));
    assert.ok(listed.hosts.some((host: any) => host.connectionId === 'automation-right'));

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'tab-targeted-request',
      operation: 'snapshot',
      tabId: 'browser:left',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const requestEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'tab-targeted-request'
    ));
    assert.ok(requestEvent);
    assert.equal((requestEvent.payload as any).connectionId, 'automation-left');

    await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-left',
      requestId: 'tab-targeted-request',
      ok: true,
      result: { tabId: 'browser:left', screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    });

    const requestAck = await requestPromise;
    assert.equal(requestAck.success, true);
    assert.deepEqual(requestAck.response.result, {
      tabId: 'browser:left',
      screenshot: { mimeType: 'image/png', data: 'cG5n' },
    });

    const missing = await socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'tab-targeted-missing',
      operation: 'snapshot',
      tabId: 'browser:missing',
      input: {},
      timeoutMs: 1000,
    });
    assert.equal(missing.success, false);
    assert.equal(missing.error, 'No preview automation host supports snapshot');
  });

  it('keeps preview automation on the learned tab when later requests omit tabId', async () => {
    const currentRoom = room({ id: 'room-preview-assignment', sandboxStatus: 'ready', sandboxId: 'sandbox-1' });
    const { socket } = createHarness({ currentRoom });

    const panelConnected = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-panel-assignment',
      focused: true,
      supportedOperations: ['status', 'open', 'navigate', 'resize'],
    });
    const browserConnected = await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-browser-assignment',
      tabId: 'browser:learned',
      focused: false,
      supportedOperations: ['snapshot', 'click'],
    });

    assert.equal(panelConnected.success, true);
    assert.equal(browserConnected.success, true);

    const openPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'assignment-open',
      operation: 'open',
      input: { url: 'https://example.com/app' },
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const openEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'assignment-open'
    ));
    assert.ok(openEvent);
    assert.equal((openEvent.payload as any).connectionId, 'automation-panel-assignment');
    assert.deepEqual((openEvent.payload as any).request, {
      requestId: 'assignment-open',
      roomId: currentRoom.id,
      operation: 'open',
      input: { url: 'https://example.com/app' },
      timeoutMs: 1000,
    });

    await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-panel-assignment',
      requestId: 'assignment-open',
      ok: true,
      result: {
        tabId: 'browser:learned',
        url: 'https://example.com/app',
        loading: false,
      },
    });
    assert.equal((await openPromise).success, true);

    const snapshotPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'assignment-snapshot',
      operation: 'snapshot',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const snapshotEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'assignment-snapshot'
    ));
    assert.ok(snapshotEvent);
    assert.equal((snapshotEvent.payload as any).connectionId, 'automation-browser-assignment');
    assert.deepEqual((snapshotEvent.payload as any).request, {
      requestId: 'assignment-snapshot',
      roomId: currentRoom.id,
      tabId: 'browser:learned',
      tabIdExplicit: false,
      operation: 'snapshot',
      input: {},
      timeoutMs: 1000,
    });

    await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-browser-assignment',
      requestId: 'assignment-snapshot',
      ok: true,
      result: {
        tabId: 'browser:learned',
        screenshot: { mimeType: 'image/png', data: 'cG5n' },
      },
    });
    assert.equal((await snapshotPromise).success, true);

    const navigatePromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'assignment-navigate',
      operation: 'navigate',
      input: { url: 'https://example.com/settings' },
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const navigateEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'assignment-navigate'
    ));
    assert.ok(navigateEvent);
    assert.equal((navigateEvent.payload as any).connectionId, 'automation-panel-assignment');
    assert.deepEqual((navigateEvent.payload as any).request, {
      requestId: 'assignment-navigate',
      roomId: currentRoom.id,
      tabId: 'browser:learned',
      tabIdExplicit: false,
      operation: 'navigate',
      input: { url: 'https://example.com/settings' },
      timeoutMs: 1000,
    });

    await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'automation-panel-assignment',
      requestId: 'assignment-navigate',
      ok: true,
      result: {
        tabId: 'browser:learned',
        url: 'https://example.com/settings',
        loading: false,
      },
    });
    assert.equal((await navigatePromise).success, true);
  });

  it('does not move an assigned preview automation session to another client runtime implicitly', async () => {
    const currentRoom = room({ id: 'room-preview-affinity', sandboxStatus: 'ready', sandboxId: 'sandbox-1' });
    const members = [member(currentRoom.id, 'client-1'), member(currentRoom.id, 'client-2')];
    const firstRuntime = createHarness({
      clientId: 'client-1',
      socketId: 'socket-preview-affinity-1',
      currentRoom,
      members,
    });
    const secondRuntime = createHarness({
      clientId: 'client-2',
      socketId: 'socket-preview-affinity-2',
      currentRoom,
      members,
    });

    await firstRuntime.socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'runtime-one-panel',
      focused: true,
      supportedOperations: ['open'],
    });
    await secondRuntime.socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'runtime-two-browser',
      tabId: 'browser:learned',
      focused: true,
      supportedOperations: ['snapshot'],
    });

    const openPromise = firstRuntime.socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'runtime-affinity-open',
      operation: 'open',
      input: { url: 'https://example.com/app' },
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    await firstRuntime.socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'runtime-one-panel',
      requestId: 'runtime-affinity-open',
      ok: true,
      result: {
        tabId: 'browser:learned',
        url: 'https://example.com/app',
        loading: false,
      },
    });
    assert.equal((await openPromise).success, true);

    const snapshotPromise = firstRuntime.socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'runtime-affinity-snapshot',
      operation: 'snapshot',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const leakedRequest = secondRuntime.socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'runtime-affinity-snapshot'
    ));
    if (leakedRequest) {
      await secondRuntime.socket.invoke<any>('respond_code_workspace_preview_automation', {
        roomId: currentRoom.id,
        connectionId: 'runtime-two-browser',
        requestId: 'runtime-affinity-snapshot',
        ok: true,
        result: { tabId: 'browser:learned', screenshot: { mimeType: 'image/png', data: 'cG5n' } },
      });
    }
    const snapshotAck = await snapshotPromise;

    assert.equal(leakedRequest, undefined);
    assert.equal(snapshotAck.success, false);
    assert.equal(snapshotAck.error, 'No preview automation host supports snapshot');
  });

  it('fails over assigned preview automation only after the runtime disconnects', async () => {
    const currentRoom = room({ id: 'room-preview-failover', sandboxStatus: 'ready', sandboxId: 'sandbox-1' });
    const members = [member(currentRoom.id, 'client-1'), member(currentRoom.id, 'client-2')];
    const firstRuntime = createHarness({
      clientId: 'client-1',
      socketId: 'socket-preview-failover-1',
      currentRoom,
      members,
    });
    const secondRuntime = createHarness({
      clientId: 'client-2',
      socketId: 'socket-preview-failover-2',
      currentRoom,
      members,
    });

    await firstRuntime.socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'failover-runtime-one',
      focused: true,
      supportedOperations: ['open'],
    });
    await secondRuntime.socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'failover-runtime-two',
      focused: true,
      supportedOperations: ['status'],
    });

    const openPromise = firstRuntime.socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'failover-open',
      operation: 'open',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    await firstRuntime.socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'failover-runtime-one',
      requestId: 'failover-open',
      ok: true,
      result: { tabId: 'browser:first-runtime' },
    });
    assert.equal((await openPromise).success, true);

    firstRuntime.socket.handlers.get('disconnect')?.();

    const statusPromise = firstRuntime.socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      requestId: 'failover-status',
      operation: 'status',
      input: {},
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const statusEvent = secondRuntime.socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'failover-status'
    ));
    assert.ok(statusEvent);
    assert.equal((statusEvent.payload as any).connectionId, 'failover-runtime-two');
    assert.deepEqual((statusEvent.payload as any).request, {
      requestId: 'failover-status',
      roomId: currentRoom.id,
      operation: 'status',
      input: {},
      timeoutMs: 1000,
    });

    await secondRuntime.socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: currentRoom.id,
      connectionId: 'failover-runtime-two',
      requestId: 'failover-status',
      ok: true,
      result: {
        tabId: 'browser:second-runtime',
        url: 'https://example.com/second',
        loading: false,
      },
    });

    const statusAck = await statusPromise;
    assert.equal(statusAck.success, true);
    assert.deepEqual(statusAck.response.result, {
      tabId: 'browser:second-runtime',
      url: 'https://example.com/second',
      loading: false,
    });
  });

  it('saves cloud preview automation recordings into the workspace before responding', async () => {
    const { socket, writeWorkspaceFileCalls, socketEvents } = createHarness();
    const recordingData = Buffer.from('recorded-video').toString('base64');

    await socket.invoke<any>('connect_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-recording',
      focused: true,
      supportedOperations: ['recordingStop'],
    });

    const requestPromise = socket.invoke<any>('request_code_workspace_preview_automation', {
      roomId: 'room-1',
      requestId: 'recording-request-1',
      operation: 'recordingStop',
      tabId: 'browser:preview',
      timeoutMs: 1000,
    });

    await new Promise(resolve => setImmediate(resolve));
    const requestEvent = socket.emittedEvents.find((entry) => (
      entry.event === 'code_workspace_preview_automation_event'
      && (entry.payload as any).type === 'request'
      && (entry.payload as any).request?.requestId === 'recording-request-1'
    ));
    assert.ok(requestEvent);

    const responseAck = await socket.invoke<any>('respond_code_workspace_preview_automation', {
      roomId: 'room-1',
      connectionId: 'automation-recording',
      requestId: 'recording-request-1',
      ok: true,
      result: {
        id: 'preview-recording-browser-preview-2026-05-03T00-00-00-000Z',
        tabId: 'browser:preview',
        path: 'ignored-client-path.webm',
        mimeType: 'video/webm',
        sizeBytes: recordingData.length,
        createdAt: '2026-05-03T00:00:00.000Z',
        encoding: 'base64',
        data: recordingData,
      },
    });
    const requestAck = await requestPromise;

    assert.equal(responseAck.success, true);
    assert.equal(requestAck.success, true);
    assert.deepEqual(writeWorkspaceFileCalls, [{
      sandboxId: 'sandbox-1',
      path: '.roomtalk/preview-recordings/preview-recording-browser-preview-2026-05-03T00-00-00-000Z.webm',
      content: recordingData,
      encoding: 'base64',
    }]);
    assert.deepEqual(requestAck.response.result, {
      id: 'preview-recording-browser-preview-2026-05-03T00-00-00-000Z',
      tabId: 'browser:preview',
      path: '.roomtalk/preview-recordings/preview-recording-browser-preview-2026-05-03T00-00-00-000Z.webm',
      mimeType: 'video/webm',
      sizeBytes: 'recorded-video'.length,
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    assert.equal((requestAck.response.result as any).data, undefined);
    assert.equal((socketEvents.at(-1)?.payload as any).response.result.data, undefined);
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

  it('creates workspace asset URLs through the socket control plane', async () => {
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

  it('normalizes absolute workspace paths before signing asset URLs', async () => {
    const assetAccess = new CodeWorkspaceAssetAccess({
      tokenSecret: 'workspace-asset-secret',
      nowMs: () => Date.parse('2026-06-30T12:00:00.000Z'),
      createId: () => 'asset-token-id',
    });
    const { socket, readWorkspaceFileCalls } = createHarness({
      codeWorkspaceAssetAccess: assetAccess,
      workspaceRoot: '/workspace',
    });

    const response = await socket.invoke<any>('create_code_workspace_asset_url', {
      roomId: 'room-1',
      path: '/workspace/output/report.html',
    });

    assert.equal(response.success, true);
    assert.match(response.asset.relativeUrl, /^\/api\/coco\/workspace-assets\/[^/]+\/report\.html$/);
    assert.deepEqual(readWorkspaceFileCalls, [{ sandboxId: 'sandbox-1', path: '/workspace/output/report.html', maxBytes: 1 }]);

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
