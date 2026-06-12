import { Message } from './types';

const extensionByMimeType: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
};

const sanitizeFilenamePart = (value: string) => (
  value
    .trim()
    .replace(/[\r\n]+/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || 'media'
);

const getExtension = (mimeType?: string) => (
  mimeType ? extensionByMimeType[mimeType.toLowerCase()] || mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') : undefined
);

export const buildMediaFilename = (message: Message) => {
  const asset = message.mediaAsset;
  if (asset?.filename) {
    return sanitizeFilenamePart(asset.filename);
  }
  const kind = asset?.kind || 'media';
  const timestamp = Number.isNaN(Date.parse(message.timestamp))
    ? 'download'
    : new Date(message.timestamp).toISOString().replace(/[:.]/g, '-');
  const extension = getExtension(asset?.mimeType || message.mimeType);
  return sanitizeFilenamePart(`roomtalk-${kind}-${timestamp}${extension ? `.${extension}` : ''}`);
};

const triggerDownload = (url: string, filename: string) => {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
};

export const saveUrlAsFile = async (url: string, filename: string) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch media');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, filename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.warn('Falling back to direct media download link:', error);
    triggerDownload(url, filename);
  }
};
