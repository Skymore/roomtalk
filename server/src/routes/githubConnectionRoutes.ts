import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { GitHubConnectionError, GitHubConnectionService } from '../services/githubConnection';

export interface GitHubConnectionRouteOptions {
  enabled: boolean;
  service?: Pick<GitHubConnectionService, 'connect' | 'getConnectionStatus' | 'disconnect'>;
  routeLogger: Pick<Logger, 'warn' | 'error'>;
  getQueryClientId: (req: Request) => string | null;
  getBodyClientId: (req: Request) => string | null;
  authorizeClientRequest: (req: Request, res: Response, clientId: string, endpoint: string) => Promise<boolean>;
}

export const registerGitHubConnectionRoutes = (app: Express, options: GitHubConnectionRouteOptions) => {
  const requireReady = (res: Response) => {
    if (!options.enabled) {
      res.status(404).json({ error: 'GitHub connections are not enabled' });
      return false;
    }
    if (!options.service) {
      res.status(503).json({ error: 'GitHub connection service is not configured' });
      return false;
    }
    return true;
  };

  app.get('/api/github/connection', async (req: Request, res: Response) => {
    if (!requireReady(res)) return;
    const clientId = options.getQueryClientId(req);
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!(await options.authorizeClientRequest(req, res, clientId, 'GET /api/github/connection'))) return;
    try {
      return res.json(await options.service!.getConnectionStatus(clientId));
    } catch (error) {
      options.routeLogger.error('Failed to read GitHub connection status', { error, clientId });
      return res.status(500).json({ error: 'Failed to read GitHub connection status' });
    }
  });

  app.put('/api/github/connection', async (req: Request, res: Response) => {
    if (!requireReady(res)) return;
    const clientId = options.getBodyClientId(req);
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!clientId || !token) return res.status(400).json({ error: 'clientId and token are required' });
    if (!(await options.authorizeClientRequest(req, res, clientId, 'PUT /api/github/connection'))) return;
    try {
      return res.json(await options.service!.connect(clientId, token));
    } catch (error) {
      if (error instanceof GitHubConnectionError && error.code === 'invalid_token') {
        options.routeLogger.warn('GitHub connection rejected an invalid token', { clientId });
        return res.status(401).json({ error: 'GitHub personal access token was rejected' });
      }
      options.routeLogger.error('Failed to save GitHub connection', { error, clientId });
      return res.status(500).json({ error: 'Failed to save GitHub connection' });
    }
  });

  app.delete('/api/github/connection', async (req: Request, res: Response) => {
    if (!requireReady(res)) return;
    const clientId = options.getBodyClientId(req);
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!(await options.authorizeClientRequest(req, res, clientId, 'DELETE /api/github/connection'))) return;
    try {
      return res.json(await options.service!.disconnect(clientId));
    } catch (error) {
      options.routeLogger.error('Failed to disconnect GitHub connection', { error, clientId });
      return res.status(500).json({ error: 'Failed to disconnect GitHub connection' });
    }
  });
};
