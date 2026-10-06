import {Express,Request,Response} from 'express';
import {z} from 'openmuse-zod';
import {Logger} from '../logger';
import {RoomStore} from '../repositories/store';
import {codeAgentModeAllowsWriteTools} from '../services/codeAgentModes';
import {CodeAgentRoomContextError,CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {PersonalAgentTrackingError} from '../services/personalAgentTracking';
import {PersonalGoogleError} from '../services/personalAgentGoogleAuth';
import {GoogleApiError} from '../services/personalAgentGoogleClient';
import {PERSONAL_TASK_API_PATH,PersonalAgentTaskError,PersonalAgentTaskService} from '../services/personalAgentTasks';

export function registerPersonalAgentTaskContextRoutes(app:Express,options:{store:RoomStore;roomContext:CodeAgentRoomContextService;tasks:PersonalAgentTaskService;logger:Logger}){
  const run=async(req:Request,res:Response,write:boolean)=>{
    const token=(req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim(),claims=token ? options.roomContext.verifyTurnToken(token) : null;
    if(!claims)return res.status(401).json({error:'Invalid or expired room context token'});
    try{
      await options.roomContext.assertAccess(claims);
      const room=await options.store.getRoomById(claims.roomId);
      if(room?.personalAgentOwnerId!==claims.clientId || room.creatorId!==claims.clientId)throw new CodeAgentRoomContextError('Personal tasks belong to their owner',403,'personal_task_owner');
      if(!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId))throw new CodeAgentRoomContextError('This agent turn ended',403,'personal_task_turn_ended');
      const input=write?req.body || {}:req.query;
      if(write){
        if(room.personalAgentTaskControl)throw new PersonalAgentTaskError('This task is paused or cancelled',409);
        if(!codeAgentModeAllowsWriteTools(claims.mode))throw new CodeAgentRoomContextError('This mode cannot change tasks',403,'personal_task_read_only');
      }
      const roomId=input.id===undefined?claims.roomId:z.string().min(1).max(100).parse(input.id);
      if(!write){
        if(input.operation==='list')return res.json(await options.tasks.list(claims.clientId));
        if(input.operation!==undefined && input.operation!=='get')throw new RangeError('Unknown task operation');
        return res.json(await options.tasks.detail(claims.clientId,roomId));
      }
      switch(input.operation){
        case 'delegate': return res.status(201).json(await options.tasks.delegate(claims.clientId,input.data));
        case 'control': return res.json(await options.tasks.control(claims.clientId,roomId,input));
        case undefined:
        case 'request-input': return res.json(await options.tasks.request({clientId:claims.clientId,roomId:claims.roomId,turnId:claims.turnId},input));
        default: throw new RangeError('Unknown task operation');
      }
    }catch(error){
      if(error instanceof z.ZodError)return res.status(422).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if(error instanceof RangeError)return res.status(400).json({error:error.message});
      if(error instanceof PersonalGoogleError || error instanceof GoogleApiError)return res.status(error.status).json({error:error.message});
      if(error instanceof CodeAgentRoomContextError || error instanceof PersonalAgentTaskError || error instanceof PersonalAgentTrackingError)return res.status(error.statusCode).json({error:error.message});
      options.logger.error('Personal task operation failed',{error,roomId:claims.roomId});return res.status(500).json({error:'Personal tasks are temporarily unavailable'});
    }
  };
  app.get(PERSONAL_TASK_API_PATH,(req,res)=>run(req,res,false));
  app.patch(PERSONAL_TASK_API_PATH,(req,res)=>run(req,res,true));
}
