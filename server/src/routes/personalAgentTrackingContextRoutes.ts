import { Express } from 'express';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { CodeAgentRoomContextService, CodeAgentRoomContextError } from '../services/codeAgentRoomContext';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { PersonalAgentTrackingService, PersonalAgentTrackingError } from '../services/personalAgentTracking';
import { PersonalAgentNotificationService } from '../services/personalAgentNotifications';

export function registerPersonalAgentTrackingContextRoutes(app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; tracking: PersonalAgentTrackingService;
  notifications: PersonalAgentNotificationService; logger: Logger;
}) {
  const run=async(req:import('express').Request,res:import('express').Response,write:boolean,updates=false)=>{
    const token=(req.header('authorization')||'').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims=token ? options.roomContext.verifyTurnToken(token) : null;
    if(!claims)return res.status(401).json({error:'Invalid or expired room context token'});
    try {
      await options.roomContext.assertAccess(claims);
      const room=await options.store.getRoomById(claims.roomId);
      if(!room||room.creatorId!==claims.clientId||room.personalAgentOwnerId!==claims.clientId)throw new CodeAgentRoomContextError('Tracking belongs to its personal agent owner',403,'personal_watch_access_denied');
      if(!await options.store.hasActiveCodeAgentRoomLease!(room.id,new Date().toISOString(),claims.turnId))throw new CodeAgentRoomContextError('This agent turn ended',403,'personal_watch_turn_ended');
      if(!write)return res.json(updates ? await options.notifications.list(claims.clientId,req.query) : await options.tracking.list(claims.clientId,req.query));
      if(!codeAgentModeAllowsWriteTools(claims.mode))throw new CodeAgentRoomContextError('This mode cannot change tracking',403,'personal_watch_read_only');
      const body=req.body || {};
      if(updates)return res.json(await options.notifications.read(claims.clientId,body.id));
      if(body.action==='create')return res.json(await options.tracking.create(claims.clientId,body,{roomId:room.id,turnId:claims.turnId}));
      if(body.action==='remove')return res.json(await options.tracking.remove(claims.clientId,body.id));
      return res.json(await options.tracking.control(claims.clientId,body.id,body));
    }catch(error){
      if(error instanceof RangeError || error instanceof TypeError)return res.status(400).json({error:error.message});
      if(error instanceof PersonalAgentTrackingError || error instanceof CodeAgentRoomContextError)return res.status(error.statusCode).json({error:error.message});
      options.logger.error('Personal tracking operation failed',{error,roomId:claims.roomId});
      return res.status(500).json({error:'Tracking is temporarily unavailable'});
    }
  };
  app.get('/api/code-agent/room-context/personal-watches',(req,res)=>run(req,res,false));
  app.patch('/api/code-agent/room-context/personal-watches',(req,res)=>run(req,res,true));
  app.get('/api/code-agent/room-context/personal-notifications',(req,res)=>run(req,res,false,true));
  app.patch('/api/code-agent/room-context/personal-notifications',(req,res)=>run(req,res,true,true));
}
