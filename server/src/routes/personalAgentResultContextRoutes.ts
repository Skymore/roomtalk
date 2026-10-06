import express, { Express } from 'express';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { CodeAgentRoomContextError, CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PERSONAL_RESULT_API_PATH, PersonalAgentResultService } from '../services/personalAgentResults';

export const registerPersonalAgentResultContextRoutes = (app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; results: PersonalAgentResultService; logger: Logger;
}) => {
  const run = async (req: express.Request, res: express.Response, write: boolean) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Invalid or expired room context token', code: 'invalid_token' });
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (!room || room.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId) {
        throw new CodeAgentRoomContextError('Personal results are only available to their owner', 403, 'personal_result_access_denied');
      }
      if (!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId, new Date().toISOString(), claims.turnId)) {
        throw new CodeAgentRoomContextError('Personal results require an active agent turn', 403, 'personal_result_turn_ended');
      }
      if (write) {
        if (!codeAgentModeAllowsWriteTools(claims.mode)) throw new CodeAgentRoomContextError('This agent mode cannot save personal results', 403, 'personal_result_read_only');
        return res.json(await options.results.save({ clientId: claims.clientId, roomId: claims.roomId, turnId: claims.turnId }, req.body || {}));
      }
      if (req.query.content === 'true') {
        if (typeof req.query.id !== 'string') throw new RangeError('Provide a result id');
        const found = await options.results.get(claims.clientId, req.query.id);
        return found ? res.json({ result: found.result, content: found.body.toString('base64') }) : res.status(404).json({ error: 'Result not found', code: 'personal_result_not_found' });
      }
      return res.json(await options.results.list(claims.clientId, req.query));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message, code: 'personal_result_invalid' });
      if (error instanceof CodeAgentRoomContextError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      options.logger.error('Personal result operation failed', { error, roomId: claims.roomId, turnId: claims.turnId });
      return res.status(500).json({ error: 'Personal results are temporarily unavailable', code: 'personal_result_failed' });
    }
  };
  app.get(PERSONAL_RESULT_API_PATH, (req, res) => run(req, res, false));
  app.patch(PERSONAL_RESULT_API_PATH, express.json({ limit: '6mb' }), (req, res) => run(req, res, true));
};
