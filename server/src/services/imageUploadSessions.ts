export interface ImageUploadSession {
  chunks: Buffer[];
  totalChunks: number;
  roomId: string;
  clientId: string;
  bytesReceived: number;
}

export type ImageUploadStartResult =
  | { ok: true }
  | { ok: false; error: 'invalid-upload' };

export type ImageUploadChunkResult =
  | { ok: true }
  | { ok: false; error: 'missing-session' | 'invalid-index' | 'invalid-chunk' | 'too-large' };

export type CompletedImageUpload =
  | { ok: true; session: ImageUploadSession; buffer: Buffer }
  | { ok: false; error: 'missing-session' | 'incomplete' };

export class ImageUploadSessions {
  private readonly sessions = new Map<string, ImageUploadSession>();

  constructor(
    private readonly maxUploadBytes = 10 * 1024 * 1024,
    private readonly maxChunks = 256
  ) {}

  start(input: {
    fileId: string;
    totalChunks: number;
    roomId: string;
    clientId: string;
  }): ImageUploadStartResult {
    if (!Number.isInteger(input.totalChunks) || input.totalChunks <= 0 || input.totalChunks > this.maxChunks) {
      return { ok: false, error: 'invalid-upload' };
    }

    this.sessions.set(input.fileId, {
      chunks: [],
      totalChunks: input.totalChunks,
      roomId: input.roomId,
      clientId: input.clientId,
      bytesReceived: 0,
    });
    return { ok: true };
  }

  addChunk(fileId: string, chunkIndex: number, chunkData: string): ImageUploadChunkResult {
    const session = this.sessions.get(fileId);
    if (!session) {
      return { ok: false, error: 'missing-session' };
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      return { ok: false, error: 'invalid-index' };
    }

    try {
      const decodedChunk = Buffer.from(chunkData, 'base64');
      const previousChunkBytes = session.chunks[chunkIndex]?.length || 0;
      const nextBytesReceived = session.bytesReceived - previousChunkBytes + decodedChunk.length;
      if (nextBytesReceived > this.maxUploadBytes) {
        return { ok: false, error: 'too-large' };
      }

      session.chunks[chunkIndex] = decodedChunk;
      session.bytesReceived = nextBytesReceived;
      return { ok: true };
    } catch {
      return { ok: false, error: 'invalid-chunk' };
    }
  }

  complete(fileId: string): CompletedImageUpload {
    const session = this.sessions.get(fileId);
    if (!session) {
      return { ok: false, error: 'missing-session' };
    }

    const hasAllChunks = Array.from(
      { length: session.totalChunks },
      (_, index) => session.chunks[index]
    ).every(chunk => Buffer.isBuffer(chunk));

    if (!hasAllChunks) {
      return { ok: false, error: 'incomplete' };
    }

    return {
      ok: true,
      session,
      buffer: Buffer.concat(session.chunks),
    };
  }

  clear(fileId: string) {
    this.sessions.delete(fileId);
  }

  has(fileId: string) {
    return this.sessions.has(fileId);
  }
}
