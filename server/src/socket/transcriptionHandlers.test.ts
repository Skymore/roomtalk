import assert from 'assert/strict';
import { afterEach, describe, it } from 'node:test';
import { registerTranscriptionHandlers } from './transcriptionHandlers';

type TokenResponse = { success: boolean; token?: string; expiresInSeconds?: number; error?: string };

class FakeSocket {
  id = 'socket-1';
  handlers = new Map<string, (...args: any[]) => unknown>();
  emitted: Array<{ event: string; args: unknown[] }> = [];

  on(event: string, handler: (...args: any[]) => unknown) {
    this.handlers.set(event, handler);
  }

  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }

  async invoke(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    assert.ok(handler, `Expected handler for ${event}`);
    return handler(...args);
  }
}

const logger = { debug() {}, error() {}, warn() {}, info() {} };

const createHarness = (options: { clientId?: string | null; assemblyAIApiKey?: string } = {}) => {
  const socket = new FakeSocket();
  const store = {
    clientId: options.clientId === undefined ? 'client-1' : options.clientId,
    async getClientId() {
      return this.clientId;
    },
  };

  registerTranscriptionHandlers({
    socket: socket as any,
    store: store as any,
    socketLogger: logger as any,
    assemblyAIApiKey: options.assemblyAIApiKey,
  } as any);

  return { socket };
};

const invokeToken = async (socket: FakeSocket): Promise<TokenResponse> => {
  let response: TokenResponse | undefined;
  await socket.invoke('create_transcription_token', (r: TokenResponse) => {
    response = r;
  });
  assert.ok(response, 'Expected the handler to invoke the callback');
  return response;
};

const invokeTokenWithPayload = async (socket: FakeSocket): Promise<TokenResponse> => {
  let response: TokenResponse | undefined;
  await socket.invoke('create_transcription_token', {}, (r: TokenResponse) => {
    response = r;
  });
  assert.ok(response, 'Expected the handler to invoke the callback');
  return response;
};

const originalFetch = globalThis.fetch;

describe('transcription socket handlers', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fails when the AssemblyAI key is not configured', async () => {
    const { socket } = createHarness({ assemblyAIApiKey: undefined });
    const response = await invokeToken(socket);
    assert.deepEqual(response, { success: false, error: 'Transcription is not configured' });
  });

  it('requires a registered client', async () => {
    const { socket } = createHarness({ clientId: null, assemblyAIApiKey: 'secret-key' });
    const response = await invokeToken(socket);
    assert.deepEqual(response, { success: false, error: 'You are not registered' });
  });

  it('mints a token and passes the API key in the Authorization header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        async json() {
          return { token: 'temp-token-123', expires_in_seconds: 300 };
        },
      };
    }) as any;

    const { socket } = createHarness({ assemblyAIApiKey: 'secret-key' });
    const response = await invokeToken(socket);

    assert.deepEqual(response, { success: true, token: 'temp-token-123', expiresInSeconds: 300 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /streaming\.assemblyai\.com\/v3\/token/);
    assert.match(calls[0].url, /expires_in_seconds=300/);
    assert.equal(calls[0].headers.Authorization, 'secret-key');
  });

  it('accepts the generic client ack shape with a payload before the callback', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      async json() {
        return { token: 'temp-token-with-payload', expires_in_seconds: 300 };
      },
    })) as any;

    const { socket } = createHarness({ assemblyAIApiKey: 'secret-key' });
    const response = await invokeTokenWithPayload(socket);

    assert.deepEqual(response, { success: true, token: 'temp-token-with-payload', expiresInSeconds: 300 });
  });

  it('reports an error when AssemblyAI responds with a non-OK status', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      async text() {
        return 'unauthorized';
      },
    })) as any;

    const { socket } = createHarness({ assemblyAIApiKey: 'secret-key' });
    const response = await invokeToken(socket);
    assert.deepEqual(response, { success: false, error: 'Failed to create transcription token' });
  });

  it('reports an error when the response is missing a token', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      async json() {
        return {};
      },
    })) as any;

    const { socket } = createHarness({ assemblyAIApiKey: 'secret-key' });
    const response = await invokeToken(socket);
    assert.deepEqual(response, { success: false, error: 'Failed to create transcription token' });
  });

  it('reports an error when fetch throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as any;

    const { socket } = createHarness({ assemblyAIApiKey: 'secret-key' });
    const response = await invokeToken(socket);
    assert.deepEqual(response, { success: false, error: 'Failed to create transcription token' });
  });
});
