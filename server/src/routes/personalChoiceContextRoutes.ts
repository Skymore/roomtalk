import {Express} from 'express';
import {z} from 'openmuse-zod';
import {Logger} from '../logger';
import {RoomStore} from '../repositories/store';
import {CodeAgentRoomContextError,CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {codeAgentModeAllowsWriteTools} from '../services/codeAgentModes';
import {JevService} from '../services/personalChoices/service';
import {presentChoicesParameters,presentChoicesTool} from '../services/personalChoices/tools';

export function registerPersonalChoiceContextRoutes(app:Express,options:{store:RoomStore;roomContext:CodeAgentRoomContextService;choices?:JevService;logger:Logger}) {
  const path='/api/code-agent/room-context/personal-choices';
  const run=async(req:import('express').Request,res:import('express').Response,write:boolean)=>{
    const token=req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const claims=token?options.roomContext.verifyTurnToken(token):null;
    if(!claims)return res.status(401).json({error:'Invalid or expired room context token'});
    try {
      await options.roomContext.assertAccess(claims);
      const room=await options.store.getRoomById(claims.roomId);
      if(room?.personalAgentOwnerId!==claims.clientId || room.creatorId!==claims.clientId)throw new CodeAgentRoomContextError('Choices belong to their owner',403,'personal_choices_owner');
      if(!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId))throw new CodeAgentRoomContextError('This agent turn ended',403,'personal_choices_turn_ended');
      if(!options.choices)return res.status(503).json({error:'Interactive choices are not configured'});
      if(!write)return res.json({panel:await options.choices.currentPanel(claims.clientId,claims.roomId)});
      if(room.personalAgentTaskControl)throw new CodeAgentRoomContextError('This task is paused or cancelled',409,'personal_task_paused');
      if(!codeAgentModeAllowsWriteTools(claims.mode))throw new CodeAgentRoomContextError('This mode cannot prepare choices',403,'personal_choices_read_only');
      const signal=new AbortController();
      res.on('close',()=>{if(!res.writableFinished)signal.abort();});
      const tool=presentChoicesTool(options.choices,claims.clientId,claims.roomId,claims.turnId,signal.signal,options.choices.mode,await options.choices.userMessage(claims.clientId,claims.roomId,claims.turnId));
      return res.json(await tool.execute(presentChoicesParameters.parse(req.body)));
    }catch(error){
      if(error instanceof z.ZodError)return res.status(422).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if(error instanceof CodeAgentRoomContextError)return res.status(error.statusCode).json({error:error.message});
      options.logger.error('Personal choices operation failed',{roomId:claims.roomId,error});
      return res.status(500).json({error:'Choices are temporarily unavailable'});
    }
  };
  app.get(path,(req,res)=>run(req,res,false));
  app.patch(path,(req,res)=>run(req,res,true));
}
