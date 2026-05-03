export interface ImageUploadSession {
  chunks: Buffer[];
  totalChunks: number;
  roomId: string;
  clientId: string;
}

export type ImageUploadChunkResult =
  | { ok: true }
  | { ok: false; error: 'missing-session' | 'invalid-index' | 'invalid-chunk' };

export type CompletedImageUpload =
  | { ok: true; session: ImageUploadSession; buffer: Buffer }
  | { ok: false; error: 'missing-session' | 'incomplete' };

export class ImageUploadSessions {
  private readonly sessions = new Map<string, ImageUploadSession>();

  start(input: {
    fileId: string;
    totalChunks: number;
    roomId: string;
    clientId: string;
  }) {
    this.sessions.set(input.fileId, {
      chunks: [],
      totalChunks: input.totalChunks,
      roomId: input.roomId,
      clientId: input.clientId,
    });
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
      session.chunks[chunkIndex] = Buffer.from(chunkData, 'base64');
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
