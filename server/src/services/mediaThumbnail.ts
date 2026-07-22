import sharp from 'sharp';
import { Logger } from '../logger';
import { MediaAsset } from '../types';
import { MediaObjectStorage } from './mediaObjectStorage';

const THUMBNAIL_VERSION = 1;
const THUMBNAIL_MAX_EDGE = 512;
const THUMBNAIL_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const THUMBNAIL_MAX_INPUT_PIXELS = 100 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_GENERATIONS = 2;
const DEFAULT_MAX_QUEUED_GENERATIONS = 48;

export const getMediaThumbnailObjectKey = (objectKey: string) => (
  `${objectKey}.thumbnail-v${THUMBNAIL_VERSION}.webp`
);

export class MediaThumbnailBusyError extends Error {
  constructor() {
    super('Media thumbnail generation is busy');
    this.name = 'MediaThumbnailBusyError';
  }
}

type MediaThumbnailServiceOptions = {
  maxConcurrentGenerations?: number;
  maxQueuedGenerations?: number;
};

export interface MediaThumbnailResolver {
  ensureThumbnail(asset: MediaAsset): Promise<string | null>;
}

export class MediaThumbnailService implements MediaThumbnailResolver {
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrentGenerations: number;
  private readonly maxQueuedGenerations: number;
  private activeGenerations = 0;

  constructor(
    private readonly storage: MediaObjectStorage,
    private readonly logger: Logger,
    options: MediaThumbnailServiceOptions = {},
  ) {
    this.maxConcurrentGenerations = Math.max(
      1,
      Math.floor(options.maxConcurrentGenerations ?? DEFAULT_MAX_CONCURRENT_GENERATIONS),
    );
    this.maxQueuedGenerations = Math.max(
      1,
      Math.floor(options.maxQueuedGenerations ?? DEFAULT_MAX_QUEUED_GENERATIONS),
    );
  }

  private async acquireGenerationSlot(): Promise<void> {
    if (this.activeGenerations < this.maxConcurrentGenerations) {
      this.activeGenerations += 1;
      return;
    }
    if (this.waiters.length >= this.maxQueuedGenerations) {
      throw new MediaThumbnailBusyError();
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  private releaseGenerationSlot() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeGenerations = Math.max(0, this.activeGenerations - 1);
  }

  private async generateThumbnail(asset: MediaAsset): Promise<string | null> {
    if (asset.kind !== 'image' || !this.storage.getMediaObject) {
      return null;
    }

    await this.acquireGenerationSlot();
    try {
      const thumbnailObjectKey = getMediaThumbnailObjectKey(asset.objectKey);
      const existing = await this.storage.headObject({ objectKey: thumbnailObjectKey });
      if (existing.exists) {
        return thumbnailObjectKey;
      }

      const source = await this.storage.getMediaObject(asset.objectKey);
      if (source.byteSize <= 0 || source.byteSize > THUMBNAIL_MAX_SOURCE_BYTES) {
        throw new Error(`Media thumbnail source size is unsupported: ${source.byteSize}`);
      }

      const { data, info } = await sharp(source.body, {
        animated: false,
        limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize({
          width: THUMBNAIL_MAX_EDGE,
          height: THUMBNAIL_MAX_EDGE,
          fit: 'cover',
          position: 'centre',
          withoutEnlargement: true,
        })
        .webp({ quality: 74, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      await this.storage.putMediaObject({
        objectKey: thumbnailObjectKey,
        body: data,
        mimeType: 'image/webp',
        byteSize: data.length,
      });
      this.logger.info('Generated media thumbnail', {
        assetId: asset.id,
        roomId: asset.roomId,
        objectKey: thumbnailObjectKey,
        sourceByteSize: source.byteSize,
        thumbnailByteSize: data.length,
        width: info.width,
        height: info.height,
      });
      return thumbnailObjectKey;
    } finally {
      this.releaseGenerationSlot();
    }
  }

  async ensureThumbnail(asset: MediaAsset): Promise<string | null> {
    if (asset.kind !== 'image') {
      return null;
    }

    const existingRequest = this.inFlight.get(asset.id);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.generateThumbnail(asset)
      .finally(() => this.inFlight.delete(asset.id));
    this.inFlight.set(asset.id, request);
    return request;
  }
}
