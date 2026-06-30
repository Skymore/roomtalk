import { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { CocoSandboxService, CocoWorkspaceAsset } from '../services/cocoSandboxService';
import {
  CODE_WORKSPACE_ASSET_ROUTE_PREFIX,
  CodeWorkspaceAssetAccess,
} from '../services/codeWorkspaceAssetAccess';
import { Room } from '../types';

export const DEFAULT_CODE_WORKSPACE_ASSET_MAX_BYTES = 25 * 1024 * 1024;

export interface CodeWorkspaceAssetRouteOptions {
  assetAccess: CodeWorkspaceAssetAccess;
  logger: Logger;
  getRoomById: (roomId: string) => Promise<Room | null>;
  cocoSandboxService?: CocoSandboxService;
  maxAssetBytes?: number;
}

const requestAssetPath = (req: Request) => {
  const wildcard = req.params[0];
  return typeof wildcard === 'string' ? wildcard : '';
};

const readWorkspaceAsset = async (
  service: CocoSandboxService,
  sandboxId: string,
  workspacePath: string,
  maxBytes: number
): Promise<CocoWorkspaceAsset> => {
  const handle = await service.connect(sandboxId);
  if (service.readWorkspaceAsset) {
    return service.readWorkspaceAsset(handle, workspacePath, { maxBytes });
  }
  if (!service.readWorkspaceFile) {
    throw new Error('Workspace asset reads are unavailable');
  }
  const file = await service.readWorkspaceFile(handle, workspacePath, { maxBytes });
  return {
    path: file.path,
    body: file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8'),
    byteSize: file.byteSize,
    truncated: file.truncated,
  };
};

export function registerCodeWorkspaceAssetRoutes(app: Express, options: CodeWorkspaceAssetRouteOptions) {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_CODE_WORKSPACE_ASSET_MAX_BYTES;

  app.get(`${CODE_WORKSPACE_ASSET_ROUTE_PREFIX}/:token/*`, async (req: Request, res: Response) => {
    const token = req.params.token;
    const resolved = typeof token === 'string'
      ? options.assetAccess.resolveAsset(token, requestAssetPath(req))
      : null;
    if (!resolved) {
      return res.status(404).send('Workspace asset not found');
    }

    const room = await options.getRoomById(resolved.roomId);
    if (
      !room ||
      room.type !== 'coco' ||
      room.sandboxStatus !== 'ready' ||
      room.sandboxId !== resolved.sandboxId
    ) {
      return res.status(404).send('Workspace asset not found');
    }

    if (!options.cocoSandboxService) {
      return res.status(503).send('Workspace sandbox service is unavailable');
    }

    try {
      const asset = await readWorkspaceAsset(options.cocoSandboxService, resolved.sandboxId, resolved.path, maxAssetBytes);
      if (asset.truncated) {
        return res.status(413).send('Workspace asset is too large to preview');
      }

      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader('Content-Length', asset.body.length);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', resolved.mimeType.startsWith('text/html')
        ? 'private, max-age=0, must-revalidate'
        : 'private, max-age=60');
      return res.send(asset.body);
    } catch (error) {
      options.logger.error('Failed to serve code workspace asset', {
        error,
        roomId: resolved.roomId,
        sandboxId: resolved.sandboxId,
        path: resolved.path,
      });
      return res.status(404).send('Workspace asset not found');
    }
  });
}
