import {Express,Request,Response} from 'express';
import {z} from 'openmuse-zod';
import {Logger} from '../logger';
import {RoomStore} from '../repositories/store';
import {codeAgentModeAllowsWriteTools} from '../services/codeAgentModes';
import {CodeAgentRoomContextError,CodeAgentRoomContextService} from '../services/codeAgentRoomContext';
import {PERSONAL_COMPUTER_API_PATH,PersonalAgentComputerService,PersonalComputerError} from '../services/personalAgentComputer';
import {PersonalAgentFileError} from '../services/personalAgentFiles';
import {PdfError} from '../services/personalAgentPdf';

export function registerPersonalAgentComputerContextRoutes(app:Express,options:{store:RoomStore;roomContext:CodeAgentRoomContextService;computer:PersonalAgentComputerService;logger:Logger}){
  const run=async(req:Request,res:Response,write:boolean)=>{
    const token=(req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim(),claims=token?options.roomContext.verifyTurnToken(token):null;
    if(!claims)return res.status(401).json({error:'Invalid or expired room context token'});
    const abort=new AbortController(),aborted=()=>abort.abort();req.on('aborted',aborted);
    try{
      await options.roomContext.assertAccess(claims);
      const room=await options.store.getRoomById(claims.roomId);
      if(!room || room.personalAgentOwnerId!==claims.clientId || room.creatorId!==claims.clientId || !await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId))
        throw new CodeAgentRoomContextError('Personal computer requires an active owner turn',403,'personal_computer_access_denied');
      if(write && room.personalAgentTaskControl)throw new CodeAgentRoomContextError('This task is paused or cancelled',409,'personal_task_paused');
      if(!write)return res.json(await options.computer.read(claims.clientId,req.query));
      if(!codeAgentModeAllowsWriteTools(claims.mode))throw new CodeAgentRoomContextError('This mode cannot control the personal computer',403,'personal_computer_read_only');
      return res.json(await options.computer.write(claims.clientId,req.body || {},{scope:claims.turnId,signal:abort.signal,claim:{roomId:claims.roomId,turnId:claims.turnId}}));
    }catch(error){
      if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if(error instanceof RangeError)return res.status(400).json({error:error.message});
      if(error instanceof PersonalComputerError || error instanceof PdfError)return res.status(error.status).json({error:error.message});
      if(error instanceof CodeAgentRoomContextError || error instanceof PersonalAgentFileError)return res.status(error.statusCode).json({error:error.message});
      options.logger.error('Personal computer operation failed',{error,roomId:claims.roomId,turnId:claims.turnId});return res.status(500).json({error:'Personal computer is temporarily unavailable'});
    }finally{req.removeListener('aborted',aborted);}
  };
  app.get(PERSONAL_COMPUTER_API_PATH,(req,res)=>run(req,res,false));app.patch(PERSONAL_COMPUTER_API_PATH,(req,res)=>run(req,res,true));
}
