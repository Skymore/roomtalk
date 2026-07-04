import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { CodexConnectionError, CodexConnectionService } from '../services/codexConnection';
import { CodexDeviceAuthSessionManager } from '../services/codexDeviceAuthSession';

export interface CodexConnectionRouteOptions {
  enabled: boolean;
  service?: Pick<CodexConnectionService, 'getConnectionStatus' | 'disconnect'>;
  deviceAuthSessions?: Pick<CodexDeviceAuthSessionManager, 'startDeviceAuth' | 'cancelDeviceAuth'>;
  routeLogger: Pick<Logger, 'warn' | 'error'>;
  getQueryClientId: (req: Request) => string | null;
  getBodyClientId: (req: Request) => string | null;
  authorizeClientRequest: (req: Request, res: Response, clientId: string, endpoint: string) => Promise<boolean>;
}

export const registerCodexConnectionRoutes = (app: Express, options: CodexConnectionRouteOptions) => {
  const requireEnabled = (res: Response) => {
    if (options.enabled) {
      return true;
    }
    res.status(404).json({ error: 'Codex connections are not enabled' });
    return false;
  };

  const requireService = (res: Response) => {
    if (options.service && options.deviceAuthSessions) {
      return true;
    }
    res.status(503).json({ error: 'Codex connection service is not configured' });
    return false;
  };

  app.get('/api/codex/connection', async (req: Request, res: Response) => {
    if (!requireEnabled(res) || !requireService(res)) {
      return;
    }
    const clientId = options.getQueryClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await options.authorizeClientRequest(req, res, clientId, 'GET /api/codex/connection'))) {
      return;
    }

    try {
      return res.json(await options.service!.getConnectionStatus(clientId));
    } catch (error) {
      options.routeLogger.error('Failed to read Codex connection status', { error, clientId, endpoint: 'GET /api/codex/connection', ip: req.ip });
      return res.status(500).json({ error: 'Failed to read Codex connection status' });
    }
  });

  app.post('/api/codex/connection/device-auth', async (req: Request, res: Response) => {
    if (!requireEnabled(res) || !requireService(res)) {
      return;
    }
    const clientId = options.getBodyClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await options.authorizeClientRequest(req, res, clientId, 'POST /api/codex/connection/device-auth'))) {
      return;
    }

    try {
      const started = await options.deviceAuthSessions!.startDeviceAuth(clientId);
      return res.status(202).json(started);
    } catch (error) {
      return handleCodexRouteError(error, res, options.routeLogger, {
        clientId,
        endpoint: 'POST /api/codex/connection/device-auth',
        ip: req.ip,
      });
    }
  });

  app.delete('/api/codex/connection/device-auth', async (req: Request, res: Response) => {
    if (!requireEnabled(res) || !requireService(res)) {
      return;
    }
    const clientId = options.getBodyClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await options.authorizeClientRequest(req, res, clientId, 'DELETE /api/codex/connection/device-auth'))) {
      return;
    }

    try {
      const cancelled = await options.deviceAuthSessions!.cancelDeviceAuth(clientId);
      const status = await options.service!.getConnectionStatus(clientId);
      return res.json({ ...cancelled, status });
    } catch (error) {
      options.routeLogger.error('Failed to cancel Codex device auth', { error, clientId, endpoint: 'DELETE /api/codex/connection/device-auth', ip: req.ip });
      return res.status(500).json({ error: 'Failed to cancel Codex device auth' });
    }
  });

  app.delete('/api/codex/connection', async (req: Request, res: Response) => {
    if (!requireEnabled(res) || !requireService(res)) {
      return;
    }
    const clientId = options.getBodyClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!(await options.authorizeClientRequest(req, res, clientId, 'DELETE /api/codex/connection'))) {
      return;
    }

    try {
      await options.deviceAuthSessions!.cancelDeviceAuth(clientId);
      return res.json(await options.service!.disconnect(clientId));
    } catch (error) {
      options.routeLogger.error('Failed to disconnect Codex connection', { error, clientId, endpoint: 'DELETE /api/codex/connection', ip: req.ip });
      return res.status(500).json({ error: 'Failed to disconnect Codex connection' });
    }
  });
};

const handleCodexRouteError = (
  error: unknown,
  res: Response,
  logger: Pick<Logger, 'warn' | 'error'>,
  context: Record<string, unknown>
) => {
  if (error instanceof CodexConnectionError) {
    if (error.code === 'device_auth_in_progress') {
      logger.warn('Codex device auth already in progress', context);
      return res.status(409).json({ error: 'Codex device auth is already in progress' });
    }
    if (error.code === 'device_auth_code_unavailable') {
      logger.warn('Codex device auth did not produce a code', context);
      return res.status(504).json({ error: 'Codex device auth did not produce a code' });
    }
    if (error.code === 'device_auth_failed') {
      logger.warn('Codex device auth failed', context);
      return res.status(502).json({ error: 'Codex device auth failed' });
    }
  }

  logger.error('Failed to start Codex device auth', { ...context, error });
  return res.status(500).json({ error: 'Failed to start Codex device auth' });
};
