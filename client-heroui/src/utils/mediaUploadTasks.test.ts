// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import imageCompression from 'browser-image-compression';
import {
  CHAT_IMAGE_TARGET_BYTES,
  clearRegisteredMediaUploadsForTests,
  completeRegisteredMediaUpload,
  prepareRegisteredMediaUpload,
  registerMediaUploadTask,
} from './mediaUploadTasks';
import { completeMediaUpload, prepareMediaUpload } from './socket';
import { cacheMediaBlob } from './mediaCache';

vi.mock('browser-image-compression', () => ({
  default: vi.fn(),
}));

vi.mock('./socket', () => ({
  prepareMediaUpload: vi.fn(),
  completeMediaUpload: vi.fn(),
}));

vi.mock('./mediaCache', () => ({
  cacheMediaBlob: vi.fn().mockResolvedValue(undefined),
}));

const compressionMock = vi.mocked(imageCompression);
const prepareMock = vi.mocked(prepareMediaUpload);
const completeMock = vi.mocked(completeMediaUpload);
const cacheMediaBlobMock = vi.mocked(cacheMediaBlob);

describe('media upload tasks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearRegisteredMediaUploadsForTests();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('skips re-encoding images already at or below the 5 MB target', async () => {
    const file = new File(['small'], 'small.jpg', { type: 'image/jpeg' });
    prepareMock.mockResolvedValue({
      assetId: 'asset-small',
      objectKey: 'small',
      roomId: 'room-1',
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      byteSize: file.size,
      filename: file.name,
    });
    registerMediaUploadTask({
      clientMessageId: 'small-client',
      roomId: 'room-1',
      file,
      kind: 'image',
      mimeType: file.type,
      filename: file.name,
    });

    await prepareRegisteredMediaUpload('small-client');

    expect(compressionMock).not.toHaveBeenCalled();
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ file }));
  });

  it('compresses large static images to the 5 MB target once and reuses the result', async () => {
    const file = new File(['large'], 'large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { configurable: true, value: CHAT_IMAGE_TARGET_BYTES + 1 });
    const compressed = new Blob(['compressed'], { type: 'image/jpeg' });
    compressionMock.mockResolvedValue(compressed as File);
    prepareMock.mockResolvedValue({
      assetId: 'asset-large',
      objectKey: 'large',
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/jpeg',
      byteSize: compressed.size,
      filename: file.name,
    });
    completeMock.mockRejectedValueOnce(new Error('completion failed'));
    registerMediaUploadTask({
      clientMessageId: 'large-client',
      roomId: 'room-1',
      file,
      kind: 'image',
      mimeType: file.type,
      filename: file.name,
    });

    await prepareRegisteredMediaUpload('large-client');
    await expect(completeRegisteredMediaUpload('large-client')).rejects.toThrow('completion failed');
    await prepareRegisteredMediaUpload('large-client');

    expect(compressionMock).toHaveBeenCalledTimes(1);
    expect(compressionMock).toHaveBeenCalledWith(file, {
      maxSizeMB: 5,
      maxWidthOrHeight: 2560,
      useWebWorker: true,
    });
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ file: compressed }));
  });

  it('starts persistent caching while the media object is still uploading', async () => {
    const file = new File(['image'], 'cached.jpg', { type: 'image/jpeg' });
    const upload = {
      assetId: 'asset-cached',
      objectKey: 'cached',
      roomId: 'agent-room',
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      byteSize: file.size,
      filename: file.name,
    };
    let releaseObjectUpload!: () => void;
    let markUploadAllocated!: () => void;
    const objectUpload = new Promise<void>(resolve => { releaseObjectUpload = resolve; });
    const uploadAllocated = new Promise<void>(resolve => { markUploadAllocated = resolve; });
    prepareMock.mockImplementation(async params => {
      params.onUploadAllocated?.(upload);
      markUploadAllocated();
      await objectUpload;
      return upload;
    });
    completeMock.mockResolvedValue({
      id: 'message-cached',
      clientId: 'client-1',
      roomId: 'agent-room',
      content: '',
      timestamp: '2026-07-12T00:00:00.000Z',
      messageType: 'media',
      mediaAsset: { id: 'asset-cached', kind: 'image', mimeType: 'image/jpeg', byteSize: file.size },
    });
    registerMediaUploadTask({
      clientMessageId: 'cached-client',
      clientBatchId: 'mixed-batch',
      clientBatchIndex: 0,
      roomId: 'agent-room',
      file,
      kind: 'image',
      mimeType: file.type,
      filename: file.name,
    });

    const preparation = prepareRegisteredMediaUpload('cached-client');
    await uploadAllocated;

    expect(cacheMediaBlobMock).toHaveBeenCalledWith({
      assetId: 'asset-cached',
      roomId: 'agent-room',
      kind: 'image',
      blob: file,
      mimeType: 'image/jpeg',
    });
    expect(completeMock).not.toHaveBeenCalled();

    releaseObjectUpload();
    await preparation;
    await completeRegisteredMediaUpload('cached-client');

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: 'cached-client',
      clientBatchId: 'mixed-batch',
      clientBatchIndex: 0,
    }));
  });
});
