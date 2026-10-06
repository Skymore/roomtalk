import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RoomStore } from '../repositories/store';
import { PersonalAgentResult } from '../types';
import { MediaObjectStorage } from './mediaObjectStorage';
import { Logger } from '../logger';

export const PERSONAL_RESULT_MAX_BYTES = 4 * 1024 * 1024;
export const PERSONAL_RESULT_API_PATH = '/api/code-agent/room-context/personal-results';
export const personalResultMetadata = ({ objectKey: _key, clientId: _owner, ...result }: PersonalAgentResult) => result;
const text = (value: unknown, field: string, limit: number, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit) throw new RangeError(`Invalid ${field}`);
  return value.trim();
};
const mimeTypes: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export class PersonalAgentResultService {
  constructor(private readonly store: RoomStore, private readonly storage: MediaObjectStorage, private readonly logger: Logger) {}

  async list(clientId: string, query: Record<string, unknown>) {
    const limit = Number(query.limit ?? 50), offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Invalid result page');
    const options: { id?: string; roomId?: string; turnId?: string; limit: number; offset: number } = { limit, offset };
    for (const key of ['id', 'roomId', 'turnId'] as const) if (query[key] !== undefined) options[key] = text(query[key], key, 100);
    const found = await this.store.readPersonalAgentResults!(clientId, options);
    return { results: found.results.map(personalResultMetadata), total: found.total };
  }

  async get(clientId: string, id: string) {
    const result = (await this.store.readPersonalAgentResults!(clientId, { id: text(id, 'id', 100), limit: 1 })).results[0];
    if (!result) return null;
    const object = await this.storage.getMediaObject!(result.objectKey);
    return { result: personalResultMetadata(result), body: object.body };
  }

  async save(source: { clientId: string; roomId: string; turnId: string }, input: Record<string, unknown>) {
    const kind = input.kind;
    if (kind !== 'plan' && kind !== 'document' && kind !== 'web') throw new RangeError('Invalid result kind');
    const filename = text(input.filename, 'filename', 200);
    if (/[\\/\x00-\x1f]/.test(filename) || filename === '.' || filename === '..') throw new RangeError('Provide a filename without directory components');
    const extension = path.extname(filename).toLowerCase();
    if (kind === 'plan' && extension !== '.md') throw new RangeError('Plans must be Markdown files');
    if (kind === 'web' && extension !== '.html' && extension !== '.htm') throw new RangeError('Web results must be self-contained HTML files');
    if (typeof input.content !== 'string' || input.content.length > Math.ceil(PERSONAL_RESULT_MAX_BYTES / 3) * 4
      || input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new RangeError('Invalid result file encoding');
    const body = Buffer.from(input.content, 'base64');
    if (!body.length || body.length > PERSONAL_RESULT_MAX_BYTES) throw new RangeError('Results are limited to 4 MiB');
    const mimeType = mimeTypes[extension] || 'application/octet-stream';
    if (mimeType.startsWith('text/')) {
      if (body.length > 512 * 1024) throw new RangeError('Text results are limited to 512 KiB');
      try { new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new RangeError('Text results must use UTF-8'); }
    }
    const id = randomUUID();
    const result: PersonalAgentResult = { ...source, id, kind, filename, mimeType, byteSize: body.length,
      title: text(input.title, 'title', 200), summary: text(input.summary ?? '', 'summary', 1000, true),
      objectKey: `personal-agent-results/${source.roomId}/${id}`, createdAt: new Date().toISOString() };
    await this.storage.putMediaObject({ objectKey: result.objectKey, body, mimeType, byteSize: body.length });
    try {
      const saved = await this.store.savePersonalAgentResult!(result);
      if (!saved) throw new RangeError('This personal agent turn ended before the result was saved');
      return { result: personalResultMetadata(saved) };
    } catch (error) {
      try { await this.storage.deleteMediaObject!(result.objectKey); }
      catch (cleanupError) { this.logger.error('Failed to remove an unsaved personal result object', { error: cleanupError, roomId: source.roomId, resultId: id }); }
      throw error;
    }
  }
}
