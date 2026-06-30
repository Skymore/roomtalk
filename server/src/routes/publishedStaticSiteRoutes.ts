import express, { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import {
  COCO_STATIC_PUBLISH_API_PATH,
  COCO_STATIC_PUBLISH_ROUTE_PREFIX,
  PublishedStaticSiteError,
  PublishedStaticSitePublishInput,
  PublishedStaticSiteService,
  normalizePublishedSiteSlug,
} from '../services/publishedStaticSite';

export interface PublishedStaticSiteRouteOptions {
  service: PublishedStaticSiteService;
  logger: Logger;
  getRoomById?: (roomId: string) => Promise<unknown | null>;
  bodyLimit?: string;
}

const readBearerToken = (req: Request) => {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
};

const requestBaseUrl = (req: Request) => {
  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return host ? `${proto}://${host}` : undefined;
};

const sendPublishError = (res: Response, error: unknown, logger: Logger, context: Record<string, unknown>) => {
  if (error instanceof PublishedStaticSiteError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  logger.error('Published static site route failed', { error, ...context });
  return res.status(500).json({ error: 'Failed to publish static site' });
};

const publishedPathFromRequest = (req: Request) => {
  const wildcard = req.params[0];
  if (typeof wildcard === 'string' && wildcard.trim()) {
    return wildcard;
  }
  return '';
};

export function registerPublishedStaticSiteRoutes(app: Express, options: PublishedStaticSiteRouteOptions) {
  const { service, logger } = options;
  const jsonParser = express.json({ limit: options.bodyLimit || process.env.COCO_STATIC_PUBLISH_BODY_LIMIT || '7mb' });

  app.post(COCO_STATIC_PUBLISH_API_PATH, jsonParser, async (req: Request, res: Response) => {
    const token = readBearerToken(req);
    const claims = token ? service.verifyTurnToken(token) : null;
    if (!claims) {
      return res.status(401).json({ error: 'Invalid or expired publish token' });
    }

    try {
      const result = await service.publish(req.body as PublishedStaticSitePublishInput, claims, requestBaseUrl(req));
      return res.status(201).json(result);
    } catch (error) {
      return sendPublishError(res, error, logger, { endpoint: COCO_STATIC_PUBLISH_API_PATH, roomId: claims.roomId, turnId: claims.turnId });
    }
  });

  app.get([
    `${COCO_STATIC_PUBLISH_ROUTE_PREFIX}/:slug`,
    `${COCO_STATIC_PUBLISH_ROUTE_PREFIX}/:slug/*`,
  ], async (req: Request, res: Response) => {
    const slug = normalizePublishedSiteSlug(req.params.slug, '');
    if (!slug || slug !== req.params.slug) {
      return res.status(404).send('Published site not found');
    }

    try {
      const result = await service.readFile(slug, publishedPathFromRequest(req));
      if (!result) {
        return res.status(404).send('Published site not found');
      }
      if (options.getRoomById && !(await options.getRoomById(result.manifest.roomId))) {
        return res.status(404).send('Published site not found');
      }

      res.type(result.file.mimeType);
      res.setHeader('Content-Length', result.body.length);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', result.file.mimeType.startsWith('text/html')
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=60');
      return res.send(result.body);
    } catch (error) {
      logger.error('Failed to serve published static site', { error, slug, path: req.path });
      return res.status(500).send('Failed to serve published site');
    }
  });
}
