import { Express, Request } from 'express';
import { Logger } from '../logger';
import {
  CODE_AGENT_CODEX_AUTH_API_PREFIX,
  CodexConnectionError,
  CodexConnectionService,
} from '../services/codexConnection';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';

const bearerToken = (req: Request) => {
  const match = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
};

export function registerCodeAgentCodexAuthRoutes(app: Express, options: {
  authorizationService: Pick<CodeAgentRoomContextService, 'verifyTurnToken' | 'assertAccess'>;
  connectionService: Pick<CodexConnectionService, 'refreshChatgptAuth'>;
  logger: Logger;
}) {
  app.post(`${CODE_AGENT_CODEX_AUTH_API_PREFIX}/refresh`, async (req, res) => {
    const token = bearerToken(req);
    const claims = token ? options.authorizationService.verifyTurnToken(token) : null;
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired code-agent turn token', code: 'invalid_token' });
      return;
    }

    const observedAuthVersion = req.body?.authVersion;
    if (!Number.isInteger(observedAuthVersion) || observedAuthVersion < 0) {
      res.status(400).json({ error: 'authVersion must be a non-negative integer', code: 'invalid_auth_version' });
      return;
    }

    try {
      await options.authorizationService.assertAccess(claims);
      res.json(await options.connectionService.refreshChatgptAuth(claims.clientId, observedAuthVersion));
    } catch (error) {
      if (error instanceof CodexConnectionError) {
        const status = error.code === 'auth_refresh_failed'
          ? 502
          : error.code === 'auth_refresh_timeout'
            ? 503
            : 409;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      options.logger.error('Code-agent Codex auth refresh failed', {
        error,
        clientId: claims.clientId,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
      res.status(500).json({ error: 'Failed to refresh Codex auth', code: 'codex_auth_refresh_failed' });
    }
  });
}
