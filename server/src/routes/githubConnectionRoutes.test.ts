import assert from 'node:assert/strict';
import express, { Request, Response } from 'express';
import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  GitHubConnectionService,
  GitHubTokenCipher,
  InMemoryGitHubConnectionStore,
} from '../services/githubConnection';
import { registerGitHubConnectionRoutes } from './githubConnectionRoutes';

describe('GitHub connection routes', () => {
  let server: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    server = await createServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects, returns public account status, and disconnects without exposing the PAT', async () => {
    const token = 'github_pat_test_token_that_is_long_enough';
    const connectedResponse = await fetch(`${server.baseUrl}/api/github/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', token }),
    });
    assert.equal(connectedResponse.status, 200);
    const connected = await connectedResponse.json() as Record<string, unknown>;
    assert.equal(connected.status, 'connected');
    assert.equal(JSON.stringify(connected).includes(token), false);

    const statusResponse = await fetch(`${server.baseUrl}/api/github/connection?clientId=client-1`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual((await statusResponse.json() as any).account, { id: 42, login: 'ada' });

    const disconnectedResponse = await fetch(`${server.baseUrl}/api/github/connection`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
    assert.equal(disconnectedResponse.status, 200);
    assert.equal((await disconnectedResponse.json() as any).status, 'disconnected');
  });

  it('requires client authorization before validating or storing a PAT', async () => {
    server.setAuthorized(false);
    const response = await fetch(`${server.baseUrl}/api/github/connection`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'client-1', token: 'github_pat_test_token_that_is_long_enough' }),
    });
    assert.equal(response.status, 401);
    assert.equal(server.validationCalls(), 0);
  });
});

const createServer = async () => {
  const app = express();
  app.use(express.json());
  let authorized = true;
  let validations = 0;
  const service = new GitHubConnectionService(
    new InMemoryGitHubConnectionStore(),
    new GitHubTokenCipher('test-secret'),
    async () => {
      validations += 1;
      return { id: 42, login: 'ada' };
    }
  );
  registerGitHubConnectionRoutes(app, {
    enabled: true,
    service,
    routeLogger: { warn() {}, error() {} },
    getQueryClientId: req => typeof req.query.clientId === 'string' ? req.query.clientId : null,
    getBodyClientId: req => typeof req.body?.clientId === 'string' ? req.body.clientId : null,
    authorizeClientRequest: async (_req: Request, res: Response) => {
      if (authorized) return true;
      res.status(401).json({ error: 'login required' });
      return false;
    },
  });
  const listener = await new Promise<HttpServer>(resolve => {
    const httpServer = app.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setAuthorized(value: boolean) { authorized = value; },
    validationCalls: () => validations,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    }),
  };
};
