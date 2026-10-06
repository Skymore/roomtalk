import { PersonalAgentMemoryConflict, readPersonalMemories, savePersonalMemory, forgetPersonalMemory, mergePersonalMemories } from '../services/personalAgentMemory';
import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import {
  CODE_AGENT_ROOM_CONTEXT_API_PREFIX, CodeAgentRoomContextError,
  CodeAgentRoomContextService, CodeAgentRoomContextTokenClaims,
} from '../services/codeAgentRoomContext';
import { PERSONAL_AGENT_MAX_MEMORY_CHARS, PERSONAL_AGENT_MEMORY_API_SUFFIX } from '../services/personalAgentContext';

export const registerPersonalAgentContextRoutes = (app: Express, options: {
  store: RoomStore;
  roomContext: CodeAgentRoomContextService;
  logger: Logger;
}) => {
  const run = async (req: Request, res: Response, write: boolean, library = false) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims: CodeAgentRoomContextTokenClaims | null = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired room context token', code: 'invalid_token' });
      return;
    }
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (!room || room.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId) {
        throw new CodeAgentRoomContextError('Personal memory is only available to its owner', 403, 'personal_memory_access_denied');
      }
      if (!await options.store.hasActiveCodeAgentRoomLease?.(claims.roomId, new Date().toISOString(), claims.turnId)) {
        throw new CodeAgentRoomContextError('Personal memory requires an active agent turn', 403, 'personal_memory_turn_ended');
      }
      if (write && !codeAgentModeAllowsWriteTools(claims.mode)) {
        throw new CodeAgentRoomContextError('This agent mode cannot update personal memory', 403, 'personal_memory_read_only');
      }
      if (library) {
        if (!write) return res.json(await readPersonalMemories(options.store, claims.clientId, req.query));
        if (req.body?.action === 'merge') return res.json(await mergePersonalMemories(options.store, claims.clientId, req.body, {
          label: 'Remembered in conversation', roomId: claims.roomId, turnId: claims.turnId,
        }));
        if (req.body?.action === 'forget') return res.json(await forgetPersonalMemory(options.store, claims.clientId, req.body.id, req.body.expectedUpdatedAt));
        if (req.body?.action !== 'save') throw new RangeError('Invalid memory action');
        return res.json({ memory: await savePersonalMemory(options.store, claims.clientId, req.body, {
          label: 'Remembered in conversation', roomId: claims.roomId, turnId: claims.turnId,
        }) });
      }
      let profile;
      if (write) {
        const memory = req.body?.memory;
        const expectedUpdatedAt = req.body?.expectedUpdatedAt;
        if (typeof memory !== 'string' || memory.length > PERSONAL_AGENT_MAX_MEMORY_CHARS
          || typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
          throw new CodeAgentRoomContextError('memory and expectedUpdatedAt are required within the memory limit', 400, 'personal_memory_invalid');
        }
        profile = await options.store.updatePersonalAgentProfile?.(claims.clientId, { memory }, expectedUpdatedAt);
        if (!profile) throw new CodeAgentRoomContextError('Personal memory changed; read it again before saving', 409, 'personal_memory_conflict');
      } else {
        profile = await options.store.getPersonalAgentProfile?.(claims.clientId);
        if (!profile) throw new CodeAgentRoomContextError('Personal agent profile not found', 404, 'personal_profile_not_found');
      }
      res.json({ memory: profile.memory, updatedAt: profile.updatedAt });
    } catch (error) {
      if (error instanceof PersonalAgentMemoryConflict) return res.status(409).json({ error: error.message, code: error.existingMemory ? 'personal_memory_duplicate' : 'personal_memory_conflict', ...(error.existingMemory ? { existingMemory: error.existingMemory } : {}) });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message, code: 'personal_memory_invalid' });
      if (error instanceof CodeAgentRoomContextError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      options.logger.error('Personal agent memory operation failed', { error, roomId: claims.roomId, turnId: claims.turnId });
      res.status(500).json({ error: 'Personal memory is temporarily unavailable', code: 'personal_memory_failed' });
    }
  };
  const path = `${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}${PERSONAL_AGENT_MEMORY_API_SUFFIX}`;
  app.get(`${path}/records`, (req, res) => run(req, res, false, true));
  app.patch(`${path}/records`, (req, res) => run(req, res, true, true));
  app.get(path, (req, res) => run(req, res, false));
  app.patch(path, (req, res) => run(req, res, true));
};
