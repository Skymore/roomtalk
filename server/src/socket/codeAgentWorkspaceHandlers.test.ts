import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { createCocoAccessControl } from '../services/cocoAccessControl';
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
  workspaceFiles?: string[];
  cocoAccess?: ReturnType<typeof createCocoAccessControl>;
} = {}) => {
  const socket = new FakeSocket();
  const currentRoom = options.currentRoom || room();
  const members = options.members || [member(currentRoom.id, options.clientId ?? 'client-1')];
  const messages = options.messages || [];
  const listWorkspaceFilesCalls: Array<{ sandboxId: string; maxDepth?: number; maxFiles?: number }> = [];
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
      listWorkspaceFiles: async (handle, listOptions) => {
        listWorkspaceFilesCalls.push({
          sandboxId: handle.id,
          maxDepth: listOptions?.maxDepth,
          maxFiles: listOptions?.maxFiles,
        });
        return options.workspaceFiles || [];
      },
      destroy: async () => {},
    },
  });

  return { socket, listWorkspaceFilesCalls };
};

describe('code-agent workspace socket handlers', () => {
  it('returns Coco workspace snapshots through the registered socket session', async () => {
    const { socket, listWorkspaceFilesCalls } = createHarness({
      workspaceFiles: ['plot_output.png', 'output/report.html'],
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
    assert.deepEqual(response.snapshot.summary.touchedFiles, ['output/report.html', 'plot_output.png']);
    assert.deepEqual(response.snapshot.commands, [{ id: 'tool-1', name: 'Read', status: 'succeeded', exitCode: undefined, preview: 'ok' }]);
    assert.deepEqual(listWorkspaceFilesCalls, [{ sandboxId: 'sandbox-1', maxDepth: 6, maxFiles: 200 }]);
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
