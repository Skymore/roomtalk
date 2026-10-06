import { Express, Request, Response } from 'express';
import {PersonalAgentGoal} from '../types';
import { Logger } from '../logger';
import { PersonalAgentGoalConflictError, RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { CODE_AGENT_ROOM_CONTEXT_API_PREFIX, CodeAgentRoomContextError, CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import {PersonalAgentTaskService,PersonalAgentTaskError} from '../services/personalAgentTasks';
import { cancelPersonalAgentGoal, PersonalAgentGoalExecution, savePersonalAgentGoal } from '../services/personalAgentGoals';

export const registerPersonalAgentGoalContextRoutes = (app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; logger: Logger; execution: PersonalAgentGoalExecution;tasks?:PersonalAgentTaskService;
}) => {
  const run = async (req: Request, res: Response, write: boolean) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Invalid or expired room context token', code: 'invalid_token' });
    const { store, execution } = options;
    try {
      await options.roomContext.assertAccess(claims);
      const room = await store.getRoomById(claims.roomId);
      if (!room || room.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId) {
        throw new CodeAgentRoomContextError('Personal goals are only available to their owner', 403, 'personal_goal_access_denied');
      }
      if (!await store.hasActiveCodeAgentRoomLease!(claims.roomId, new Date().toISOString(), claims.turnId)) {
        throw new CodeAgentRoomContextError('Personal goals require an active agent turn', 403, 'personal_goal_turn_ended');
      }
      if(write && room.personalAgentTaskControl)throw new CodeAgentRoomContextError('This task is paused or cancelled',409,'personal_goal_paused');
      if (write && !codeAgentModeAllowsWriteTools(claims.mode)) {
        throw new CodeAgentRoomContextError('This agent mode cannot update personal goals', 403, 'personal_goal_read_only');
      }
      const goals = await store.readPersonalAgentGoals!(claims.clientId);
      if (!write) {
        const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 20);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Invalid goal page');
        const selected = req.query.id ? goals.filter(goal => goal.id === req.query.id) : goals;
        return res.json({ goals: selected.slice(offset, offset + limit), total: selected.length });
      }
      const save=async(body:Record<string,unknown>,existing:PersonalAgentGoal)=>{
        const goal=await savePersonalAgentGoal(store,claims.clientId,body,existing);
        await options.tasks?.pauseGoal(goal);
        return {goal};
      };
      const body = req.body || {};
      if (body.action === 'create') return res.json({ goal: await savePersonalAgentGoal(store, claims.clientId, body) });
      if (typeof body.id !== 'string') throw new RangeError('Provide a goal id');
      const goal = goals.find(item => item.id === body.id);
      if (!goal) throw new CodeAgentRoomContextError('Goal not found', 404, 'personal_goal_not_found');
      if (body.action === 'run') {
        if (room.personalAgentGoalId === goal.id) throw new RangeError('This conversation is already executing this goal. Finish the current occurrence directly.');
        return res.json(await execution.startGoal(goal));
      }
      if (typeof body.expectedUpdatedAt !== 'string') throw new RangeError('Read the goal and provide expectedUpdatedAt before changing it');
      if (body.action === 'update') return res.json(await save(body,goal));
      if (body.action === 'pause' || body.action === 'resume') {
        return res.json(await save({
          expectedUpdatedAt: body.expectedUpdatedAt, enabled: body.action === 'resume',
          ...(body.action === 'resume' ? { completed: false } : {}),
        }, goal));
      }
      if (body.action === 'cancel' || body.action === 'delete') {
        if (room.personalAgentGoalId === goal.id) throw new RangeError('Use the conversation Stop button to cancel this running task.');
        const paused = await cancelPersonalAgentGoal(store, goal, execution, body.expectedUpdatedAt);
        if (body.action === 'cancel') return res.json({ goal: paused, cancellationRequested: true });
        if (!await store.deletePersonalAgentGoal!(claims.clientId, goal.id, paused.updatedAt)) throw new PersonalAgentGoalConflictError('Goal changed before deletion; read it again');
        return res.json({ success: true });
      }
      throw new RangeError('Invalid goal action');
    } catch (error) {
      if (error instanceof PersonalAgentGoalConflictError) return res.status(409).json({ error: error.message, code: 'personal_goal_conflict' });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message, code: 'personal_goal_invalid' });
      if (error instanceof PersonalAgentTaskError)return res.status(error.statusCode).json({error:error.message});
      if (error instanceof CodeAgentRoomContextError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      options.logger.error('Personal goal operation failed', { error, roomId: claims.roomId, turnId: claims.turnId });
      return res.status(500).json({ error: 'Personal goals are temporarily unavailable', code: 'personal_goal_failed' });
    }
  };
  const path = `${CODE_AGENT_ROOM_CONTEXT_API_PREFIX}/personal-goals`;
  app.get(path, (req, res) => run(req, res, false));
  app.patch(path, (req, res) => run(req, res, true));
};
