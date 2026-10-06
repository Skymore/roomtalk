import type {JevService} from '../services/personalChoices/service';
import { Express,Request,Response } from 'express';
import { z } from 'openmuse-zod';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { CodeAgentRoomContextError,CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { PERSONAL_GOOGLE_API_PATH,PersonalAgentGoogleService } from '../services/personalAgentGoogle';
import { PersonalGoogleError } from '../services/personalAgentGoogleAuth';
import { GoogleApiError,RecurringEventError } from '../services/personalAgentGoogleClient';
import { PdfError } from '../services/personalAgentPdf';
import { PersonalAgentFileError } from '../services/personalAgentFiles';

export function registerPersonalAgentGoogleContextRoutes(app: Express,options: {
  choices?:JevService;store:RoomStore;roomContext:CodeAgentRoomContextService;google:PersonalAgentGoogleService;logger:Logger;
}) {
  const run = async (req:Request,res:Response,write:boolean) => {
    const token = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1], claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({error:'Invalid or expired room context token'});
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (room?.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId) throw new CodeAgentRoomContextError('Personal Google connections belong to their owner',403,'personal_google_owner');
      if (!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId)) throw new CodeAgentRoomContextError('This agent turn ended',403,'personal_google_turn_ended');
      if (write && room.personalAgentTaskControl)throw new PersonalGoogleError('This task is paused or cancelled',409);
      if (write && !codeAgentModeAllowsWriteTools(claims.mode)) throw new CodeAgentRoomContextError('This mode cannot prepare Google actions',403,'personal_google_read_only');
      const input = write ? req.body || {} : req.query, clientId = claims.clientId, google = options.google;
      let output: unknown;
      switch (input.operation) {
        case 'status': output = await google.auth.status(clientId); break;
        case 'mail': {
          const {mail}=await google.mail(clientId,typeof input.query === 'string' ? input.query : undefined);
          output={matches:mail.slice(0,20).map(({id,threadId,sender,from,subject,date,body})=>({id,threadId,sender,from,subject,date,snippet:body.slice(0,240)})),truncated:mail.length>20};
          break;
        }
        case 'message': output = await google.message(clientId,z.string().parse(input.id)); break;
        case 'thread': {
          const id=z.string().parse(input.id);
          const {mail}=await google.thread(clientId,id);
          if (mail.length) await options.choices?.noteEvidence(clientId,claims.roomId,claims.turnId,'mail',id);
          output={messages:mail.slice(-20).map(message=>({...message,body:message.body.slice(0,12000)})),truncated:mail.length>20 || mail.some(message=>message.body.length>12000)};
          break;
        }
        case 'calendars': output = await google.calendars(clientId); break;
        case 'events': output = await google.events(clientId,{calendarId:input.calendarId,timeMin:input.timeMin,timeMax:input.timeMax}); break;
        case 'drafts': output = await google.drafts(clientId); break;
        case 'actions': output = await google.actions(clientId); break;
        case 'save-draft': if (!write) throw new RangeError('Use a write operation'); output = await google.saveDraft(clientId,input.data); break;
        case 'propose': if (!write) throw new RangeError('Use a write operation'); output = await google.propose(clientId,input.data,{roomId:claims.roomId,turnId:claims.turnId}); break;
        case 'import-attachment': if (!write) throw new RangeError('Use a write operation'); output = await google.importAttachment(clientId,z.string().parse(input.reference),{roomId:claims.roomId,turnId:claims.turnId}); break;
        default: throw new RangeError('Unknown Google operation');
      }
      return res.json(output);
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(422).json({error:error.issues.map(issue=>issue.message).join('; ')});
      if (error instanceof PersonalGoogleError || error instanceof GoogleApiError || error instanceof RecurringEventError || error instanceof PdfError) return res.status(error.status).json({error:error.message});
      if (error instanceof PersonalAgentFileError || error instanceof CodeAgentRoomContextError) return res.status(error.statusCode).json({error:error.message});
      if (error instanceof RangeError) return res.status(400).json({error:error.message});
      options.logger.error('Personal Google operation failed',{roomId:claims.roomId,error});
      return res.status(500).json({error:'Google is temporarily unavailable'});
    }
  };
  app.get(PERSONAL_GOOGLE_API_PATH,(req,res)=>run(req,res,false));
  app.patch(PERSONAL_GOOGLE_API_PATH,(req,res)=>run(req,res,true));
}
