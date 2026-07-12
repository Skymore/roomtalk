import imageCompression from 'browser-image-compression';
import {
  completeMediaUpload,
  prepareMediaUpload,
  type PreparedMediaUpload,
} from './socket';
import type { MediaKind, Message } from './types';
import { cacheMediaBlob } from './mediaCache';

export const CHAT_IMAGE_TARGET_BYTES = 5 * 1024 * 1024;
export const MEDIA_PREPARATION_CONCURRENCY = 3;

export interface MediaUploadTaskInput {
  clientMessageId: string;
  roomId: string;
  file: File;
  kind: MediaKind;
  mimeType: string;
  filename: string;
  previewUrl?: string;
  username?: string;
  avatar?: { text: string; color: string };
  replyToMessageId?: string;
  caption?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

interface MediaUploadTask extends MediaUploadTaskInput {
  controller: AbortController;
  compressedFile?: Blob;
  preparedUpload?: PreparedMediaUpload;
  preparePromise?: Promise<PreparedMediaUpload>;
  cachedAssetId?: string;
  cachePromise?: Promise<void>;
}

export type MediaPreparationOutcome =
  | { ok: true; upload: PreparedMediaUpload }
  | { ok: false; error: unknown };

const tasks = new Map<string, MediaUploadTask>();

const shouldBypassImageCompression = (file: Blob, kind: MediaKind) => (
  kind !== 'image'
  || file.size <= CHAT_IMAGE_TARGET_BYTES
  || file.type.toLowerCase() === 'image/gif'
);

const compressTaskFile = async (task: MediaUploadTask): Promise<Blob> => {
  if (task.compressedFile) return task.compressedFile;
  if (shouldBypassImageCompression(task.file, task.kind)) {
    task.compressedFile = task.file;
    return task.file;
  }

  task.compressedFile = await imageCompression(task.file, {
    maxSizeMB: 5,
    maxWidthOrHeight: 2560,
    useWebWorker: true,
  });
  return task.compressedFile;
};

const startTaskMediaCache = (task: MediaUploadTask, upload: PreparedMediaUpload) => {
  if (task.cachedAssetId === upload.assetId || (task.kind !== 'image' && task.kind !== 'audio' && task.kind !== 'video')) return;
  task.cachedAssetId = upload.assetId;
  task.cachePromise = Promise.resolve(cacheMediaBlob({
    assetId: upload.assetId,
    roomId: task.roomId,
    kind: task.kind,
    blob: task.compressedFile || task.file,
    mimeType: upload.mimeType,
  })).catch(error => console.warn('Sent media could not be cached locally:', error));
};

export const registerMediaUploadTask = (input: MediaUploadTaskInput) => {
  tasks.set(input.clientMessageId, {
    ...input,
    controller: new AbortController(),
  });
};

export const prepareRegisteredMediaUpload = async (clientMessageId: string): Promise<PreparedMediaUpload> => {
  const task = tasks.get(clientMessageId);
  if (!task) throw new Error('Media upload task is unavailable');
  if (task.preparedUpload) return task.preparedUpload;
  if (task.preparePromise) return task.preparePromise;

  task.preparePromise = (async () => {
    const file = await compressTaskFile(task);
    const upload = await prepareMediaUpload({
      file,
      roomId: task.roomId,
      kind: task.kind,
      mimeType: file.type || task.mimeType,
      filename: task.filename,
      signal: task.controller.signal,
      onUploadAllocated: upload => startTaskMediaCache(task, upload),
    });
    task.preparedUpload = upload;
    return upload;
  })();

  try {
    return await task.preparePromise;
  } finally {
    task.preparePromise = undefined;
  }
};

export const completeRegisteredMediaUpload = async (clientMessageId: string): Promise<Message> => {
  const task = tasks.get(clientMessageId);
  if (!task) throw new Error('Media upload task is unavailable');
  const upload = task.preparedUpload || await prepareRegisteredMediaUpload(clientMessageId);
  const message = await completeMediaUpload({
    upload,
    username: task.username,
    avatar: task.avatar,
    replyToMessageId: task.replyToMessageId,
    clientMessageId: task.clientMessageId,
    caption: task.caption,
    width: task.width,
    height: task.height,
    durationMs: task.durationMs,
    signal: task.controller.signal,
  });
  tasks.delete(clientMessageId);
  if (task.previewUrl) {
    window.setTimeout(() => URL.revokeObjectURL(task.previewUrl!), 30_000);
  }
  return message;
};

export const retryRegisteredMediaUpload = async (clientMessageId: string): Promise<Message> => {
  const task = tasks.get(clientMessageId);
  if (!task) throw new Error('Media upload task is unavailable');
  if (task.controller.signal.aborted) {
    task.controller = new AbortController();
  }
  return completeRegisteredMediaUpload(clientMessageId);
};

export const cancelRegisteredMediaUpload = (clientMessageId: string) => {
  const task = tasks.get(clientMessageId);
  if (!task) return;
  task.controller.abort();
  tasks.delete(clientMessageId);
  if (task.previewUrl) URL.revokeObjectURL(task.previewUrl);
};

export const hasRegisteredMediaUpload = (clientMessageId: string) => tasks.has(clientMessageId);

export const clearRegisteredMediaUploadsForTests = () => {
  tasks.forEach(task => {
    task.controller.abort();
    if (task.previewUrl) URL.revokeObjectURL(task.previewUrl);
  });
  tasks.clear();
};

export const prepareMediaUploadBatch = (
  clientMessageIds: readonly string[],
  concurrency = MEDIA_PREPARATION_CONCURRENCY,
): Array<Promise<MediaPreparationOutcome>> => {
  const outcomes: Array<Promise<MediaPreparationOutcome>> = [];
  const resolveOutcome: Array<(outcome: MediaPreparationOutcome) => void> = [];
  clientMessageIds.forEach((_, index) => {
    outcomes[index] = new Promise(resolve => {
      resolveOutcome[index] = resolve;
    });
  });

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < clientMessageIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        const upload = await prepareRegisteredMediaUpload(clientMessageIds[index]);
        resolveOutcome[index]({ ok: true, upload });
      } catch (error) {
        resolveOutcome[index]({ ok: false, error });
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), clientMessageIds.length);
  for (let index = 0; index < workerCount; index += 1) {
    void worker();
  }
  return outcomes;
};
