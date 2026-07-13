import { MediaObjectStorage } from '../services/mediaObjectStorage';

export class MemoryMediaObjectStorage implements MediaObjectStorage {
  constructor(private readonly options: {
    assumeObjectsExist?: boolean;
    uploadBaseUrl?: string;
    downloadBaseUrl?: string;
    expiresAt?: string;
  } = {}) {}

  objects = new Map<string, { body: Buffer; mimeType: string; byteSize: number }>();
  uploaded = this.objects;
  deletedObjectKeys: string[] = [];
  deleted = this.deletedObjectKeys;
  readUrlRequests: Array<{ objectKey: string; expiresInSeconds?: number }> = [];
  failUpload = false;

  isConfigured() {
    return true;
  }

  async putMediaObject(input: { objectKey: string; body: Buffer; mimeType: string; byteSize: number }) {
    if (this.failUpload) {
      throw new Error('upload failed');
    }
    this.objects.set(input.objectKey, {
      body: input.body,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
    });
  }

  async createWriteUrl(input: { objectKey: string }) {
    return {
      url: `${this.options.uploadBaseUrl || 'https://upload.example'}/${encodeURIComponent(input.objectKey)}`,
      expiresAt: this.options.expiresAt || '2026-06-30T00:15:00.000Z',
    };
  }

  async createReadUrl(input: { objectKey: string; expiresInSeconds?: number }) {
    this.readUrlRequests.push(input);
    return {
      url: `${this.options.downloadBaseUrl || 'https://download.example'}/${encodeURIComponent(input.objectKey)}`,
      expiresAt: this.options.expiresAt || '2026-06-30T00:15:00.000Z',
    };
  }

  async headObject(input: { objectKey: string }) {
    const object = this.objects.get(input.objectKey);
    if (!object && this.options.assumeObjectsExist) {
      return { exists: true };
    }
    return object
      ? { exists: true, mimeType: object.mimeType, byteSize: object.byteSize }
      : { exists: false };
  }

  async getMediaObject(objectKey: string) {
    const object = this.objects.get(objectKey);
    if (!object) {
      const error = new Error(`missing object ${objectKey}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return object;
  }

  async deleteMediaObject(objectKey: string) {
    this.deletedObjectKeys.push(objectKey);
    this.objects.delete(objectKey);
  }
}
