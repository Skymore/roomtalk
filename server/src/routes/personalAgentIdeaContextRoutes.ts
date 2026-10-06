import { Express } from 'express';
import { Logger } from '../logger';
import { PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { CodeAgentRoomContextError, CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PersonalAgentIdeaError, PersonalAgentIdeaService } from '../services/personalAgentIdeas';

export function registerPersonalAgentIdeaContextRoutes(app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; ideas: PersonalAgentIdeaService; logger: Logger;
}) {
  const run = async (req: import('express').Request, res: import('express').Response, write: boolean) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Invalid or expired room context token' });
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (!room || room.creatorId !== claims.clientId || room.personalAgentOwnerId !== claims.clientId) throw new CodeAgentRoomContextError('Suggestions belong to their personal agent owner', 403, 'personal_idea_access_denied');
      if (!await options.store.hasActiveCodeAgentRoomLease!(room.id, new Date().toISOString(), claims.turnId)) throw new CodeAgentRoomContextError('This agent turn ended', 403, 'personal_idea_turn_ended');
      if (!write) return res.json(await options.ideas.list(claims.clientId, req.query));
      if (!codeAgentModeAllowsWriteTools(claims.mode)) throw new CodeAgentRoomContextError('This mode cannot propose work', 403, 'personal_idea_read_only');
      return res.json(await options.ideas.propose(claims.clientId, req.body || {}, { roomId: room.id, turnId: claims.turnId }));
    } catch (error) {
      if (error instanceof PersonalAgentIdeaConflictError) return res.status(409).json({ error: error.message });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      if (error instanceof PersonalAgentIdeaError || error instanceof CodeAgentRoomContextError) return res.status(error.statusCode).json({ error: error.message });
      options.logger.error('Personal suggestion operation failed', { error, roomId: claims.roomId, turnId: claims.turnId });
      return res.status(500).json({ error: 'Suggestions are temporarily unavailable' });
    }
  };
  const path = '/api/code-agent/room-context/personal-ideas';
  app.get(path, (req, res) => run(req, res, false));
  app.patch(path, (req, res) => run(req, res, true));
}
