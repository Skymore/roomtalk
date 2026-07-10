import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import {
  CODE_AGENT_ROOM_CONTEXT_API_PREFIX,
  CodeAgentRoomContextError,
  CodeAgentRoomContextService,
  CodeAgentRoomContextTokenClaims,
} from '../services/codeAgentRoomContext';

const bearerToken = (req: Request) => {
  const match = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
};

const positiveInteger = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function registerCodeAgentRoomContextRoutes(app: Express, options: {
  service: CodeAgentRoomContextService;
  logger: Logger;
}) {
  const authorize = (req: Request, res: Response): CodeAgentRoomContextTokenClaims | null => {
    const token = bearerToken(req);
    const claims = token ? options.service.verifyTurnToken(token) : null;
    if (!claims) res.status(401).json({ error: 'Invalid or expired room context token', code: 'invalid_token' });
    return claims;
  };

  const run = async (req: Request, res: Response, operation: (claims: CodeAgentRoomContextTokenClaims) => Promise<unknown>) => {
    const claims = authorize(req, res);
    if (!claims) return;
    try {
      res.json(await operation(claims));
    } catch (error) {
      if (error instanceof CodeAgentRoomContextError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      options.logger.error('Code-agent room context route failed', {
        error,
        roomId: claims.roomId,
        turnId: claims.turnId,
        path: req.path,
      });
      res.status(500).json({ error: 'Failed to read room context', code: 'room_context_failed' });
    }
  };

  app.get(`${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}/history`, (req, res) => run(req, res, claims => options.service.history(claims, {
    limit: positiveInteger(req.query.limit),
    beforeMessageId: typeof req.query.beforeMessageId === 'string' ? req.query.beforeMessageId : undefined,
  })));

  app.get(`${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}/delta`, (req, res) => run(req, res, claims => {
    const sinceMessageId = typeof req.query.sinceMessageId === 'string' ? req.query.sinceMessageId.trim() : '';
    if (!sinceMessageId) throw new CodeAgentRoomContextError('sinceMessageId is required', 400, 'since_message_required');
    return options.service.delta(claims, { sinceMessageId, limit: positiveInteger(req.query.limit) });
  }));

  app.get(`${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}/search`, (req, res) => run(req, res, claims => options.service.search(claims, {
    query: typeof req.query.query === 'string' ? req.query.query : '',
    limit: positiveInteger(req.query.limit),
  })));

  app.get(`${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}/messages/:messageId`, (req, res) => run(
    req,
    res,
    claims => options.service.message(claims, req.params.messageId),
  ));
}
