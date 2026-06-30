import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { createCocoAccessControl } from '../services/cocoAccessControl';
import { CocoWorkspaceEntry } from '../services/cocoSandboxService';
import { Message, Room, RoomMember } from '../types';
import { registerCodeAgentWorkspaceHandlers } from './codeAgentWorkspaceHandlers';

class FakeSocket {
  id = 'socket-1';
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
  workspaceFileContent?: string;
  cocoAccess?: ReturnType<typeof createCocoAccessControl>;
} = {}) => {
  const socket = new FakeSocket();
  const currentRoom = options.currentRoom || room();
  const members = options.members || [member(currentRoom.id, options.clientId ?? 'client-1')];
  const messages = options.messages || [];
  const listWorkspaceEntriesCalls: Array<{ sandboxId: string; maxDepth?: number; maxEntries?: number }> = [];
  const readWorkspaceFileCalls: Array<{ sandboxId: string; path: string; maxBytes?: number }> = [];
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
      listWorkspaceEntries: async (handle, listOptions) => {
        listWorkspaceEntriesCalls.push({
          sandboxId: handle.id,
          maxDepth: listOptions?.maxDepth,
          maxEntries: listOptions?.maxEntries,
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
      destroy: async () => {},
    },
  });

  return { socket, listWorkspaceEntriesCalls, readWorkspaceFileCalls };
};

describe('code-agent workspace socket handlers', () => {
  it('returns Coco workspace snapshots through the registered socket session', async () => {
    const { socket, listWorkspaceEntriesCalls } = createHarness({
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
    assert.deepEqual(response.snapshot.commands, [{ id: 'tool-1', name: 'Read', status: 'succeeded', exitCode: undefined, preview: 'ok' }]);
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
    assert.deepEqual(readWorkspaceFileCalls, [{ sandboxId: 'sandbox-1', path: 'src/App.tsx', maxBytes: 1048576 }]);
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
