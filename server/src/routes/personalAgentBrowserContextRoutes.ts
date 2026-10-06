import { PdfError } from '../services/personalAgentPdf';
import { PersonalAgentFileError } from '../services/personalAgentFiles';
import { Express } from 'express';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { codeAgentModeAllowsWriteTools } from '../services/codeAgentModes';
import { CodeAgentRoomContextError, CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import { PERSONAL_BROWSER_API_PATH, PersonalAgentBrowserError, PersonalAgentBrowserService } from '../services/personalAgentBrowser';

export const registerPersonalAgentBrowserContextRoutes = (app: Express, options: {
  store: RoomStore; roomContext: CodeAgentRoomContextService; browser: PersonalAgentBrowserService; logger: Logger;
}) => {
  const run = async (req: import('express').Request, res: import('express').Response, write: boolean) => {
    const token = (req.header('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const claims = token ? options.roomContext.verifyTurnToken(token) : null;
    if (!claims) return res.status(401).json({ error: 'Invalid or expired room context token' });
    try {
      await options.roomContext.assertAccess(claims);
      const room = await options.store.getRoomById(claims.roomId);
      if (!room || room.personalAgentOwnerId !== claims.clientId || room.creatorId !== claims.clientId) throw new CodeAgentRoomContextError('Personal browser is only available to its owner', 403, 'personal_browser_access_denied');
      if (!await options.store.hasActiveCodeAgentRoomLease!(claims.roomId, new Date().toISOString(), claims.turnId)) throw new CodeAgentRoomContextError('Personal browser requires an active turn', 403, 'personal_browser_turn_ended');
      if (!write) return res.json(req.query.operation==='sessions'?await options.browser.sessions(claims.clientId):await options.browser.list(claims.clientId,req.query));
      if(room.personalAgentTaskControl)throw new PersonalAgentBrowserError('This task is paused or cancelled',409);
      if (!codeAgentModeAllowsWriteTools(claims.mode)) throw new CodeAgentRoomContextError('This agent mode cannot operate a browser', 403, 'personal_browser_read_only');
      return res.json(await options.browser.agent({ clientId: claims.clientId, roomId: claims.roomId, turnId: claims.turnId }, req.body || {}));
    } catch (error) {
      if (error instanceof PdfError) return res.status(error.status).json({error:error.message});
      if (error instanceof PersonalAgentFileError) return res.status(error.statusCode).json({error:error.message});
      if (error instanceof RangeError || error instanceof TypeError) return res.status(400).json({ error: error.message });
      if (error instanceof CodeAgentRoomContextError || error instanceof PersonalAgentBrowserError) return res.status(error.statusCode).json({ error: error.message });
      options.logger.error('Personal browser operation failed', { error, roomId: claims.roomId, turnId: claims.turnId });
      return res.status(500).json({ error: 'Personal browser is temporarily unavailable' });
    }
  };
  app.get(PERSONAL_BROWSER_API_PATH, (req, res) => run(req, res, false));
  app.patch(PERSONAL_BROWSER_API_PATH, (req, res) => run(req, res, true));
};
