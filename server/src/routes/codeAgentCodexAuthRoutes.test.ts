import assert from 'node:assert/strict';
import express from 'express';
import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { registerCodeAgentCodexAuthRoutes } from './codeAgentCodexAuthRoutes';

describe('code-agent Codex auth routes', () => {
  let server: HttpServer;
  let baseUrl: string;
  let authorizationService: CodeAgentRoomContextService;
  const refreshCalls: Array<{ clientId: string; authVersion: number }> = [];

  beforeEach(async () => {
    refreshCalls.length = 0;
    const store = {
      async getRoomById(roomId: string) {
        return roomId === 'room-1'
          ? { id: roomId, name: 'Workspace', description: '', createdAt: '', creatorId: 'client-1', type: 'codeAgent' as const }
          : null;
      },
    } as unknown as RoomStore;
    authorizationService = new CodeAgentRoomContextService(store, {
      tokenSecret: 'route-secret',
      createId: () => 'token-1',
    });
    const app = express();
    app.use(express.json());
    registerCodeAgentCodexAuthRoutes(app, {
      authorizationService,
      connectionService: {
        async refreshChatgptAuth(clientId, authVersion) {
          refreshCalls.push({ clientId, authVersion });
          return {
            authJson: '{"tokens":{"access_token":"fresh"}}',
            authVersion: authVersion + 1,
            accessToken: 'fresh',
            chatgptAccountId: 'account-1',
            chatgptPlanType: 'pro',
          };
        },
      },
      logger: new Logger('CodexAuthRoutesTest'),
    });
    server = await new Promise<HttpServer>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('requires a scoped turn token and a valid auth version', async () => {
    const unauthorized = await fetch(`${baseUrl}/api/code-agent/codex-auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authVersion: 1 }),
    });
    assert.equal(unauthorized.status, 401);

    const token = authorizationService.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'approveForMe',
    });
    const invalidVersion = await fetch(`${baseUrl}/api/code-agent/codex-auth/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ authVersion: -1 }),
    });
    assert.equal(invalidVersion.status, 400);
  });

  it('refreshes the authenticated clients Codex credentials', async () => {
    const token = authorizationService.issueTurnToken({
      roomId: 'room-1',
      clientId: 'client-1',
      turnId: 'turn-1',
      mode: 'approveForMe',
    });
    const response = await fetch(`${baseUrl}/api/code-agent/codex-auth/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ authVersion: 4 }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(refreshCalls, [{ clientId: 'client-1', authVersion: 4 }]);
    assert.equal(((await response.json()) as { authVersion: number }).authVersion, 5);
  });
});
