import { Message, Room } from './types';
import { buildMediaFilename } from './mediaDownload';

export type ExportMediaResolver = (message: Message) => Promise<string | null>;
type TranscriptRoom = Pick<Room, 'id' | 'name'>;

type HtmlMediaReference = {
  kind: string;
  src?: string;
  filename?: string;
  mimeType?: string;
  byteSize?: number;
  error?: string;
};

type ZipFile = {
  name: string;
  data: Uint8Array | string;
};

const textEncoder = new TextEncoder();

const sanitizeFilenamePart = (value: string) => (
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'room'
);

const formatTimestamp = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
};

const getSenderName = (message: Message) => {
  if (message.clientId === 'ai_assistant') {
    return message.username || 'AI Assistant';
  }
  return message.username || message.clientId || 'Participant';
};

const describeMedia = (message: Message) => {
  const asset = message.mediaAsset;
  if (!asset) {
    return '[Media]';
  }
  const details = [
    asset.kind,
    asset.mimeType,
    `${asset.byteSize} bytes`,
    asset.width && asset.height ? `${asset.width}x${asset.height}` : null,
    asset.durationMs ? `${Math.round(asset.durationMs / 1000)}s` : null,
    `asset:${asset.id}`,
  ].filter(Boolean);
  return `[Media: ${details.join(', ')}]`;
};

export const buildTranscriptFilename = (room: TranscriptRoom, extension: 'html' | 'zip') => {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${sanitizeFilenamePart(room.name)}-${timestamp}.${extension}`;
};

const triggerDownload = (blob: Blob, filename: string) => {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

const escapeHtml = (value: string) => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
);

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('Failed to read media blob'));
  reader.readAsDataURL(blob);
});

const fetchMediaBlob = async (url: string) => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  return response.blob();
};

const resolveMessageMedia = async (message: Message, resolveMediaUrl: ExportMediaResolver) => {
  if (message.messageType !== 'media' || !message.mediaAsset?.id) {
    return null;
  }
  const url = await resolveMediaUrl(message);
  if (!url) {
    return null;
  }
  return {
    url,
    asset: message.mediaAsset,
  };
};

const collectEmbeddedImages = async (
  messages: Message[],
  resolveMediaUrl: ExportMediaResolver,
) => {
  const mediaByMessageId = new Map<string, HtmlMediaReference>();

  for (const message of messages) {
    if (message.mediaAsset?.kind !== 'image') {
      continue;
    }

    try {
      const resolved = await resolveMessageMedia(message, resolveMediaUrl);
      if (!resolved) {
        continue;
      }
      const blob = await fetchMediaBlob(resolved.url);
      mediaByMessageId.set(message.id, {
        kind: 'image',
        src: await blobToDataUrl(blob),
        filename: buildMediaFilename(message),
        mimeType: resolved.asset.mimeType,
        byteSize: resolved.asset.byteSize,
      });
    } catch (error) {
      console.warn('Failed to embed image in transcript export:', error);
      mediaByMessageId.set(message.id, {
        kind: 'image',
        error: 'Image could not be embedded.',
      });
    }
  }

  return mediaByMessageId;
};

const renderMediaHtml = (message: Message, media?: HtmlMediaReference) => {
  const caption = message.content.trim()
    ? `<div class="caption">${escapeHtml(message.content.trim()).replace(/\n/g, '<br>')}</div>`
    : '';

  if (media?.src && media.kind === 'image') {
    return `
      <figure class="media">
        <img class="media-image" src="${escapeHtml(media.src)}" alt="Shared image" />
        ${caption}
      </figure>
    `;
  }

  if (media?.src && media.kind === 'video') {
    return `
      <figure class="media">
        <video class="media-video" controls src="${escapeHtml(media.src)}"></video>
        <a class="attachment-link" href="${escapeHtml(media.src)}">${escapeHtml(media.filename || 'Video attachment')}</a>
        ${caption}
      </figure>
    `;
  }

  if (media?.src && media.kind === 'audio') {
    return `
      <figure class="media">
        <audio controls src="${escapeHtml(media.src)}"></audio>
        <a class="attachment-link" href="${escapeHtml(media.src)}">${escapeHtml(media.filename || 'Audio attachment')}</a>
        ${caption}
      </figure>
    `;
  }

  return `
    <div class="media-fallback">
      ${escapeHtml(describeMedia(message))}
      ${media?.error ? `<br>${escapeHtml(media.error)}` : ''}
      ${caption}
    </div>
  `;
};

const messageToHtml = (message: Message, mediaByMessageId: Map<string, HtmlMediaReference>) => {
  const body = message.messageType === 'media'
    ? renderMediaHtml(message, mediaByMessageId.get(message.id))
    : escapeHtml(message.content || '').replace(/\n/g, '<br>');

  const aiMeta = [
    message.aiModel?.label,
    message.cost ? `$${message.cost.totalUsd.toFixed(6)}` : null,
  ].filter(Boolean).join(' | ');

  return `
    <article class="message ${message.clientId === 'ai_assistant' ? 'message-ai' : ''}">
      <div class="meta">${escapeHtml(formatTimestamp(message.timestamp))} &middot; ${escapeHtml(getSenderName(message))}${aiMeta ? ` &middot; ${escapeHtml(aiMeta)}` : ''}</div>
      ${message.replyTo ? `<div class="reply">Replying to ${escapeHtml(message.replyTo.username || 'Participant')}: ${escapeHtml(message.replyTo.preview)}</div>` : ''}
      <div class="body">${body}</div>
    </article>
  `;
};

export const buildTranscriptHtml = (
  room: TranscriptRoom,
  messages: Message[],
  mediaByMessageId: Map<string, HtmlMediaReference> = new Map(),
) => `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(buildTranscriptFilename(room, 'html'))}</title>
    <style>
      :root { color-scheme: light; }
      body { background: #f5f4ed; color: #141413; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
      main { margin: 0 auto; max-width: 920px; padding: 32px 20px 48px; }
      h1 { font-family: Georgia, serif; font-size: 30px; font-weight: 500; line-height: 1.15; margin: 0 0 8px; }
      .summary { color: #5e5d59; font-size: 13px; margin-bottom: 24px; }
      .message { border-top: 1px solid #dedbd0; break-inside: avoid; padding: 14px 0; }
      .message-ai .body { background: #faf9f5; border-color: #dedbd0; }
      .meta { color: #5e5d59; font-size: 12px; margin-bottom: 7px; }
      .reply { border-left: 2px solid #c96442; color: #5e5d59; font-size: 12px; margin-bottom: 8px; padding-left: 8px; }
      .body { background: #fffdf8; border: 1px solid #e8e6dc; border-radius: 8px; display: inline-block; font-size: 14px; line-height: 1.55; max-width: 100%; padding: 10px 12px; white-space: normal; }
      .media { margin: 0; }
      .media-image { border-radius: 8px; display: block; max-height: 520px; max-width: 100%; object-fit: contain; }
      .media-video { background: #000; border-radius: 8px; display: block; max-height: 520px; max-width: 100%; }
      .caption { color: #3d3d3a; margin-top: 8px; }
      .media-fallback { color: #5e5d59; }
      .attachment-link { color: #9f4d32; display: inline-block; margin-top: 8px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(room.name)}</h1>
      <div class="summary">Room ID: ${escapeHtml(room.id)} &middot; Exported: ${escapeHtml(new Date().toLocaleString())} &middot; Messages: ${messages.length}</div>
      ${messages.map(message => messageToHtml(message, mediaByMessageId)).join('')}
    </main>
  </body>
</html>
`;

export const downloadTranscriptHtml = async (
  room: TranscriptRoom,
  messages: Message[],
  resolveMediaUrl: ExportMediaResolver,
) => {
  const embeddedImages = await collectEmbeddedImages(messages, resolveMediaUrl);
  triggerDownload(
    new Blob([buildTranscriptHtml(room, messages, embeddedImages)], { type: 'text/html;charset=utf-8' }),
    buildTranscriptFilename(room, 'html'),
  );
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = (date = new Date()) => {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

const writeU16 = (view: DataView, offset: number, value: number) => view.setUint16(offset, value, true);
const writeU32 = (view: DataView, offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

const makeZipBlob = (files: ZipFile[]) => {
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;
  const stamp = dosDateTime();

  for (const file of files) {
    const filenameBytes = textEncoder.encode(file.name);
    const data = typeof file.data === 'string' ? textEncoder.encode(file.data) : file.data;
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, stamp.time);
    writeU16(localView, 12, stamp.date);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, data.byteLength);
    writeU32(localView, 22, data.byteLength);
    writeU16(localView, 26, filenameBytes.length);
    writeU16(localView, 28, 0);
    localHeader.set(filenameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, stamp.time);
    writeU16(centralView, 14, stamp.date);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, data.byteLength);
    writeU32(centralView, 24, data.byteLength);
    writeU16(centralView, 28, filenameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    centralHeader.set(filenameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.byteLength + data.byteLength;
    centralSize += centralHeader.byteLength;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);
  writeU16(endView, 20, 0);

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
};

const blobToBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

export const downloadTranscriptZip = async (
  room: TranscriptRoom,
  messages: Message[],
  resolveMediaUrl: ExportMediaResolver,
) => {
  const files: ZipFile[] = [];
  const mediaByMessageId = new Map<string, HtmlMediaReference>();
  const mediaManifest: Array<{
    messageId: string;
    kind?: string;
    filename?: string;
    path?: string;
    mimeType?: string;
    byteSize?: number;
    error?: string;
  }> = [];

  let mediaIndex = 1;
  for (const message of messages) {
    if (message.messageType !== 'media' || !message.mediaAsset?.id) {
      continue;
    }

    try {
      const resolved = await resolveMessageMedia(message, resolveMediaUrl);
      if (!resolved) {
        continue;
      }
      const blob = await fetchMediaBlob(resolved.url);
      const filename = `${String(mediaIndex).padStart(3, '0')}-${buildMediaFilename(message)}`;
      const mediaPath = `media/${filename}`;
      mediaIndex += 1;

      files.push({ name: mediaPath, data: await blobToBytes(blob) });
      mediaByMessageId.set(message.id, {
        kind: resolved.asset.kind,
        src: mediaPath,
        filename,
        mimeType: resolved.asset.mimeType,
        byteSize: resolved.asset.byteSize,
      });
      mediaManifest.push({
        messageId: message.id,
        kind: resolved.asset.kind,
        filename,
        path: mediaPath,
        mimeType: resolved.asset.mimeType,
        byteSize: resolved.asset.byteSize,
      });
    } catch (error) {
      console.warn('Failed to include media in ZIP transcript export:', error);
      mediaManifest.push({
        messageId: message.id,
        kind: message.mediaAsset?.kind,
        mimeType: message.mediaAsset?.mimeType,
        byteSize: message.mediaAsset?.byteSize,
        error: error instanceof Error ? error.message : 'Failed to include media',
      });
    }
  }

  files.unshift(
    { name: 'transcript.html', data: buildTranscriptHtml(room, messages, mediaByMessageId) },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        exportedAt: new Date().toISOString(),
        room,
        messages,
        media: mediaManifest,
      }, null, 2),
    },
  );

  triggerDownload(makeZipBlob(files), buildTranscriptFilename(room, 'zip'));
};
