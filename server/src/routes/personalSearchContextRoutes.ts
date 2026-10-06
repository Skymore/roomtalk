import {Express} from 'express';
import {z} from 'openmuse-zod';
import {Logger} from '../logger';
import {RoomStore} from '../repositories/store';
import {CodeAgentRoomContextError,CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {SearchService,searchInputSchema} from '../services/personalSearch';

export function registerPersonalSearchContextRoutes(app:Express,options:{store:RoomStore;roomContext:CodeAgentRoomContextService;search?:SearchService;logger:Logger}) {
  app.patch('/api/code-agent/room-context/personal-search',async(req,res)=>{
    const token=req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const claims=token?options.roomContext.verifyTurnToken(token):null;
    if(!claims)return res.status(401).json({error:'Invalid or expired room context token'});
    try {
      await options.roomContext.assertAccess(claims);
      const room=await options.store.getRoomById(claims.roomId);
      if(room?.personalAgentOwnerId!==claims.clientId || room.creatorId!==claims.clientId)throw new CodeAgentRoomContextError('Search belongs to its owner',403,'personal_search_owner');
      if(!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId))throw new CodeAgentRoomContextError('This agent turn ended',403,'personal_search_turn_ended');
      if(room.personalAgentTaskControl)throw new CodeAgentRoomContextError('This task is paused or cancelled',409,'personal_task_paused');
      if(!options.search)return res.status(503).json({error:'Public web search is not configured'});
      const input=searchInputSchema.parse(req.body);
      const signal=new AbortController();
      res.on('close',()=>{if(!res.writableFinished)signal.abort();});
      try {return res.json(await options.search.search(claims.clientId,`${room.personalAgentTaskKind?'task':'chat'}:${claims.roomId}`,input,signal.signal));}
      catch(error){if(signal.signal.aborted)return;return res.json({error:error instanceof Error?error.message:'Could not search the web'});}
    }catch(error){
      if(error instanceof z.ZodError)return res.status(422).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if(error instanceof CodeAgentRoomContextError)return res.status(error.statusCode).json({error:error.message});
      options.logger.error('Personal search operation failed',{roomId:claims.roomId,error});
      return res.status(500).json({error:'Search is temporarily unavailable'});
    }
  });
}
