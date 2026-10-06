import express, { Express } from 'express';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { CodeAgentRoomContextError, CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PERSONAL_FILES_API_PATH, PersonalAgentFileError, PersonalAgentFileService } from '../services/personalAgentFiles';
import { PdfError } from '../services/personalAgentPdf';

export function registerPersonalAgentFileContextRoutes(app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; files: PersonalAgentFileService; logger: Logger;
}) {
  const run = async (req: express.Request,res: express.Response,write: boolean) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Invalid or expired room context token',code: 'invalid_token' });
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (!room || room.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId
        || !await options.store.hasActiveCodeAgentRoomLease!(claims.roomId,new Date().toISOString(),claims.turnId)) {
        throw new CodeAgentRoomContextError('Personal files require an active owner turn',403,'personal_file_access_denied');
      }
      if (write) {
        if(room.personalAgentTaskControl)throw new PersonalAgentFileError('This task is paused or cancelled',409);
        if (!codeAgentModeAllowsWriteTools(claims.mode)) throw new CodeAgentRoomContextError('This agent mode cannot change personal files',403,'personal_file_read_only');
        const input = req.body || {},claim = { roomId: claims.roomId,turnId: claims.turnId };
        if (input.action === 'fill' && typeof input.id === 'string') return res.json(await options.files.fill(claims.clientId,input.id,input.fields,claim));
        if (input.action !== 'import' || typeof input.content !== 'string' || input.content.length > Math.ceil(10*1024*1024/3)*4
          || input.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new RangeError('Provide a base64 PDF to import');
        return res.json(await options.files.import(claims.clientId,input.name,Buffer.from(input.content,'base64'),'Saved in conversation',undefined,claim));
      }
      if (req.query.content === 'true' && typeof req.query.id === 'string') {
        const found = await options.files.get(claims.clientId,req.query.id);
        return res.json({ file: found.file,content: found.body.toString('base64') });
      }
      return res.json(await options.files.list(claims.clientId,req.query));
    } catch (error) {
      if (error instanceof PdfError) return res.status(error.status).json({ error: error.message });
      if (error instanceof PersonalAgentFileError) return res.status(error.statusCode).json({ error: error.message });
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      if (error instanceof CodeAgentRoomContextError) return res.status(error.statusCode).json({ error: error.message,code: error.code });
      options.logger.error('Personal file operation failed', { error,roomId: claims.roomId,turnId: claims.turnId });
      return res.status(500).json({ error: 'Personal files are temporarily unavailable' });
    }
  };
  app.get(PERSONAL_FILES_API_PATH,(req,res) => run(req,res,false));
  app.patch(PERSONAL_FILES_API_PATH,express.json({ limit: '14mb' }),(req,res) => run(req,res,true));
}
