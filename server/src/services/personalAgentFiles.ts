import { randomUUID } from 'node:crypto';
import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { PersonalAgentFile } from '../types';
import { MediaObjectStorage } from './mediaObjectStorage';
import { inspectPdf, fillPdf } from './personalAgentPdf';

export const PERSONAL_FILES_API_PATH = '/api/code-agent/room-context/personal-files';
export const personalFileMetadata = ({ clientId: _owner, objectKey: _key, ...file }: PersonalAgentFile) => file;
export class PersonalAgentFileError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class PersonalAgentFileService {
  constructor(private readonly store: RoomStore, private readonly storage: MediaObjectStorage, private readonly logger: Logger) {}

  async list(clientId: string, query: Record<string, unknown> = {}) {
    const limit = Number(query.limit ?? 50), offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Invalid file page');
    if (query.id !== undefined && (typeof query.id !== 'string' || query.id.length > 100)) throw new RangeError('Invalid file id');
    const found = await this.store.readPersonalAgentFiles!(clientId, { id: query.id as string | undefined,limit,offset });
    return { files: found.files.map(personalFileMetadata),total: found.total };
  }

  async get(clientId: string, id: string) {
    const file = (await this.store.readPersonalAgentFiles!(clientId, { id,limit: 1 })).files[0];
    if (!file) throw new PersonalAgentFileError('File not found', 404);
    const object = await this.storage.getMediaObject!(file.objectKey);
    return { file: personalFileMetadata(file),body: object.body };
  }

  async import(clientId: string, name: string, bytes: Buffer, source = 'Imported by you', parentId?: string, claim?: { roomId: string; turnId: string }) {
    if (typeof name !== 'string' || !name.trim()) throw new RangeError('Provide a filename');
    const safeName = name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g,'').slice(0,180) || 'document.pdf';
    const metadata = await inspectPdf(bytes);
    const id = randomUUID();
    const file: PersonalAgentFile = { ...metadata,id,clientId,name: safeName,byteSize: bytes.length,
      objectKey: `personal-agent-files/${clientId}/${id}`,source,parentId,createdAt: new Date().toISOString() };
    await this.storage.putMediaObject({ objectKey: file.objectKey,body: bytes,mimeType: 'application/pdf',byteSize: bytes.length });
    try {
      const saved = await this.store.savePersonalAgentFile!(file,claim);
      if (!saved) throw new PersonalAgentFileError('This file source or agent turn is no longer available',409);
      return { file: personalFileMetadata(saved) };
    } catch (error) {
      try { await this.storage.deleteMediaObject!(file.objectKey); }
      catch (cleanupError) { this.logger.error('Failed to remove an unsaved personal file', { error: cleanupError,fileId: id }); }
      throw error;
    }
  }

  async fill(clientId: string, id: string, values: unknown, claim?: { roomId: string; turnId: string }) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RangeError('Provide PDF form fields');
    const { file,body } = await this.get(clientId,id);
    const output = await fillPdf(body, values as Record<string,string | boolean>);
    return this.import(clientId,`${file.name.replace(/\.pdf$/i,'')} — filled.pdf`,Buffer.from(output),`Filled from ${file.name}`,file.id,claim);
  }
}
