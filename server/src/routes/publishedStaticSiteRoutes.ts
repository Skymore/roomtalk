import express, { Express, Request, Response } from 'express';
import { Logger } from '../logger';
import { CodeAgentRoomContextService } from '../services/codeAgentRoomContext';
import {
  CODE_AGENT_STATIC_PUBLISH_API_PATH,
  CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX,
  PublishedStaticSiteError,
  PublishedStaticSiteFinalizeInput,
  PublishedStaticSitePrepareInput,
  PublishedStaticSitePublishInput,
  PublishedStaticSiteService,
  PublishedStaticSiteUnpublishInput,
  normalizePublishedSiteSlug,
} from '../services/publishedStaticSite';

export interface PublishedStaticSiteRouteOptions {
  service: PublishedStaticSiteService;
  logger: Logger;
  getRoomById?: (roomId: string) => Promise<unknown | null>;
  refreshAuthorization?: Pick<CodeAgentRoomContextService, 'verifyTurnToken' | 'assertAccess'>;
  isTurnActive?: (roomId: string, turnId: string) => Promise<boolean>;
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
  const jsonParser = express.json({ limit: options.bodyLimit || process.env.CODE_AGENT_STATIC_PUBLISH_BODY_LIMIT || '7mb' });

  const requireActiveTurn = async (roomId: string, turnId: string, res: Response) => {
    try {
      if (!options.isTurnActive || await options.isTurnActive(roomId, turnId)) {
        return true;
      }
      res.status(409).json({ error: 'The code-agent turn is no longer running', code: 'turn_not_running' });
      return false;
    } catch (error) {
      logger.error('Unable to verify static publish turn state', { error, roomId, turnId });
      res.status(503).json({ error: 'Unable to verify the code-agent turn', code: 'turn_state_unavailable' });
      return false;
    }
  };

  const authorizePublish = async (req: Request, res: Response) => {
    const token = readBearerToken(req);
    const claims = token ? service.verifyTurnToken(token) : null;
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired publish token' });
      return null;
    }
    return await requireActiveTurn(claims.roomId, claims.turnId, res) ? claims : null;
  };

  app.post(`${CODE_AGENT_STATIC_PUBLISH_API_PATH}/token`, jsonParser, async (req: Request, res: Response) => {
    const authorization = options.refreshAuthorization;
    const refreshToken = readBearerToken(req);
    const claims = authorization && refreshToken ? authorization.verifyTurnToken(refreshToken) : null;
    if (!claims) {
      return res.status(401).json({ error: 'Invalid or expired publish refresh token', code: 'invalid_refresh_token' });
    }
    try {
      await authorization!.assertAccess(claims);
      if (!await requireActiveTurn(claims.roomId, claims.turnId, res)) {
        return;
      }
      return res.json({
        token: service.issueTurnToken(claims),
        expiresInSeconds: service.turnTokenTtlSeconds,
      });
    } catch (error) {
      logger.warn('Static site publish token refresh denied', {
        error,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
      return res.status(403).json({ error: 'Static site publishing is not available for this turn', code: 'publish_refresh_denied' });
    }
  });

  app.post(CODE_AGENT_STATIC_PUBLISH_API_PATH, jsonParser, async (req: Request, res: Response) => {
    const claims = await authorizePublish(req, res);
    if (!claims) return;

    try {
      const result = await service.publish(req.body as PublishedStaticSitePublishInput, claims, requestBaseUrl(req));
      return res.status(201).json(result);
    } catch (error) {
      return sendPublishError(res, error, logger, { endpoint: CODE_AGENT_STATIC_PUBLISH_API_PATH, roomId: claims.roomId, turnId: claims.turnId });
    }
  });

  app.post(`${CODE_AGENT_STATIC_PUBLISH_API_PATH}/prepare`, jsonParser, async (req: Request, res: Response) => {
    const claims = await authorizePublish(req, res);
    if (!claims) return;
    try {
      return res.status(201).json(await service.prepareDirectUpload(req.body as PublishedStaticSitePrepareInput, claims));
    } catch (error) {
      return sendPublishError(res, error, logger, {
        endpoint: `${CODE_AGENT_STATIC_PUBLISH_API_PATH}/prepare`,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
    }
  });

  app.post(`${CODE_AGENT_STATIC_PUBLISH_API_PATH}/finalize`, jsonParser, async (req: Request, res: Response) => {
    const claims = await authorizePublish(req, res);
    if (!claims) return;
    try {
      return res.status(201).json(await service.finalizeDirectUpload(
        req.body as PublishedStaticSiteFinalizeInput,
        claims,
        requestBaseUrl(req)
      ));
    } catch (error) {
      return sendPublishError(res, error, logger, {
        endpoint: `${CODE_AGENT_STATIC_PUBLISH_API_PATH}/finalize`,
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
    }
  });

  app.delete(CODE_AGENT_STATIC_PUBLISH_API_PATH, jsonParser, async (req: Request, res: Response) => {
    const claims = await authorizePublish(req, res);
    if (!claims) return;

    try {
      const result = await service.unpublish(req.body as PublishedStaticSiteUnpublishInput, claims, requestBaseUrl(req));
      return res.status(200).json(result);
    } catch (error) {
      return sendPublishError(res, error, logger, {
        endpoint: CODE_AGENT_STATIC_PUBLISH_API_PATH,
        operation: 'unpublish',
        roomId: claims.roomId,
        turnId: claims.turnId,
      });
    }
  });

  const servePublishedFile = async (
    req: Request,
    res: Response,
    slug: string,
    requestPath: string,
    versionId?: string
  ) => {
    try {
      const result = versionId
        ? await service.readFile(slug, requestPath, versionId)
        : await service.readFile(slug, requestPath);
      if (!result) {
        return res.status(404).send('Published site not found');
      }
      if (options.getRoomById && !(await options.getRoomById(result.manifest.roomId))) {
        return res.status(404).send('Published site not found');
      }

      res.type(result.file.mimeType);
      res.setHeader('Content-Length', result.body.length);
      // Published sites run in a sandboxed iframe without allow-same-origin, so
      // module and fetch requests originate from the opaque `null` origin.
      // These files are public and must remain credentialless to load there.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader('Access-Control-Allow-Credentials');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', versionId
        ? 'public, max-age=31536000, immutable'
        : (result.file.mimeType.startsWith('text/html')
          ? 'public, max-age=0, must-revalidate'
          : 'public, max-age=60'));
      return res.send(result.body);
    } catch (error) {
      logger.error('Failed to serve published static site', { error, slug, versionId, path: req.path });
      return res.status(500).send('Failed to serve published site');
    }
  };

  app.get([
    `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/:slug/__versions/:versionId`,
    `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/:slug/__versions/:versionId/*`,
  ], async (req: Request, res: Response) => {
    const slug = normalizePublishedSiteSlug(req.params.slug, '');
    const versionId = req.params.versionId;
    if (!slug || slug !== req.params.slug || !versionId) {
      return res.status(404).send('Published site not found');
    }
    return servePublishedFile(req, res, slug, publishedPathFromRequest(req), versionId);
  });

  app.get([
    `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/:slug`,
    `${CODE_AGENT_STATIC_PUBLISH_ROUTE_PREFIX}/:slug/*`,
  ], async (req: Request, res: Response) => {
    const slug = normalizePublishedSiteSlug(req.params.slug, '');
    if (!slug || slug !== req.params.slug) {
      return res.status(404).send('Published site not found');
    }

    return servePublishedFile(req, res, slug, publishedPathFromRequest(req));
  });
}
