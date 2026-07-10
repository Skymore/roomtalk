// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { getSenderColorTheme } from '../utils/userProfile';
import { MessageItem } from './MessageItem';

const getMediaDownloadUrlMock = vi.hoisted(() => vi.fn());
const getRoomMediaHistoryMock = vi.hoisted(() => vi.fn());
const getAudioTranscriptionMock = vi.hoisted(() => vi.fn());
const requestAudioTranscriptionMock = vi.hoisted(() => vi.fn());
const saveUrlAsFileMock = vi.hoisted(() => vi.fn());
const sendA2UIActionMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/socket', () => ({
  clientId: 'viewer',
  getAudioTranscription: getAudioTranscriptionMock,
  getMediaDownloadUrl: getMediaDownloadUrlMock,
  getRoomMediaHistory: getRoomMediaHistoryMock,
  requestAudioTranscription: requestAudioTranscriptionMock,
  sendA2UIAction: sendA2UIActionMock,
}));

vi.mock('../utils/mediaDownload', () => ({
  buildMediaFilename: (message: Message) => message.mediaAsset?.filename || 'download.bin',
  saveUrlAsFile: saveUrlAsFileMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name?: string } }) => (
    <div data-testid="file-diff">{fileDiff.name}</div>
  ),
}));

vi.mock('./A2UIRenderer', () => ({
  A2UIRenderer: ({ onAction }: any) => (
    <button
      type="button"
      onClick={() => onAction?.({
        name: 'refresh',
        surfaceId: 'surface-1',
        sourceComponentId: 'refresh_btn',
        timestamp: '2026-05-03T10:00:00.000Z',
        context: { followUp: true },
      })}
    >
      a2ui-action
    </button>
  ),
}));

const message = {
  id: 'reply',
  clientId: 'sender',
  username: 'Grace',
  content: 'follow up',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  replyTo: {
    messageId: 'quoted',
    username: 'Ada',
    messageType: 'text',
    preview: 'original question',
  },
} as Message;

describe('MessageItem replies', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: {
        ...(window.CSS || {}),
        escape: window.CSS?.escape || ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')),
      },
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });
    getAudioTranscriptionMock.mockResolvedValue({
      assetId: 'audio-1',
      roomId: 'room-1',
      messageId: 'audio-message',
      status: 'not_requested',
    });
  });

  afterEach(() => {
    cleanup();
    document.getElementById('roomtalk-pierre-file-icon-sprite')?.remove();
    getMediaDownloadUrlMock.mockReset();
    getRoomMediaHistoryMock.mockReset();
    getAudioTranscriptionMock.mockReset();
    requestAudioTranscriptionMock.mockReset();
    saveUrlAsFileMock.mockReset();
    sendA2UIActionMock.mockReset();
  });

  it('shows reply context and exposes a touch-accessible reply action', () => {
    const onReply = vi.fn();
    render(
      <MessageItem
        message={message}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={onReply}
      />
    );

    expect(screen.getByText('replyingTo:Ada')).toBeTruthy();
    expect(screen.getByText('original question')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('replyToMessage'));
    expect(onReply).toHaveBeenCalledWith(message);
  });

  it('applies a stable sender outline to text message bubbles from clientId', () => {
    render(
      <MessageItem
        message={message}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    const bubble = screen.getByText('follow up').closest('.roomtalk-sender-outline') as HTMLElement | null;
    const theme = getSenderColorTheme('sender');

    expect(bubble).toBeTruthy();
    expect(bubble?.style.getPropertyValue('--roomtalk-sender-outline-light')).toBe(theme.outlineLight);
    expect(bubble?.style.getPropertyValue('--roomtalk-sender-outline-dark')).toBe(theme.outlineDark);
  });

  it('treats messageType ai as an assistant message even when clientId differs', () => {
    const onRefreshAI = vi.fn();
    render(
      <MessageItem
        message={{
          ...message,
          id: 'ai-message',
          clientId: 'provider-worker',
          username: 'Coco',
          content: 'assistant response',
          messageType: 'ai',
          status: 'complete',
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onRefreshAI={onRefreshAI}
        onReply={vi.fn()}
      />
    );

    const item = screen.getByTestId('message-item');
    expect(item.getAttribute('data-message-id')).toBe('ai-message');
    expect(screen.getByText('Coco')).toBeTruthy();
    expect(screen.getByText('assistant response')).toBeTruthy();
    expect(screen.getByLabelText('retry')).toBeTruthy();
  });

  it('renders the legacy CodexApp assistant name as Codex', () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'legacy-codex-app-message',
          clientId: 'ai_assistant',
          username: 'CodexApp',
          content: 'legacy assistant response',
          messageType: 'ai',
          status: 'complete',
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('CodexApp')).toBeNull();
  });

  it('renders T3 review comment contexts as structured cards instead of raw tags', async () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'review-comment-message',
          content: [
            'Please apply this.',
            '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="src/app.ts" startIndex="1" endIndex="2" rangeLabel="+2 to +3">',
            'Keep this configurable.',
            '```diff',
            '@@ -2,1 +2,2 @@',
            '-old',
            '+new',
            '+extra',
            '```',
            '</review_comment>',
          ].join('\n'),
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    const card = await screen.findByTestId('code-agent-review-comment-card');
    expect(within(card).getByText('workspace/src/app.ts')).toBeTruthy();
    const chip = within(card).getByTestId('code-agent-review-comment-file-chip');
    expect(within(chip).getByText('workspace/src/app.ts')).toBeTruthy();
    expect(chip.querySelector('[data-pierre-icon]')).toBeTruthy();
    expect(card.textContent).toContain('Turn 2 · +2 to +3');
    expect(within(card).getByText('Keep this configurable.')).toBeTruthy();
    expect(screen.getByTestId('file-diff').textContent).toBe('src/app.ts');
    expect(document.body.textContent).not.toContain('<review_comment');
    expect(document.body.textContent).not.toContain('</review_comment>');
  });

  it('renders file review comments as source code cards', async () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'file-review-comment-message',
          content: [
            '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
            'Clarify this.',
            '```md',
            '# Plan',
            '- Step one',
            '```',
            '</review_comment>',
          ].join('\n'),
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(await screen.findByTestId('code-agent-review-comment-card')).toBeTruthy();
    expect(screen.getByText('workspace/docs/plan.md')).toBeTruthy();
    expect(screen.getByText('File comment · L1 to L2')).toBeTruthy();
    expect(document.body.textContent).toContain('# Plan');
    expect(document.body.textContent).toContain('- Step one');
    expect(screen.queryByTestId('file-diff')).toBeNull();
    expect(document.body.textContent).not.toContain('<review_comment');
  });

  it('formats absolute sandbox paths in T3 review comment cards', async () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'absolute-review-comment-message',
          content: [
            '<review_comment sectionId="file:/workspace/package.json" sectionTitle="File comment" filePath="/workspace/package.json" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
            'Clarify this.',
            '```json',
            '{ "name": "roomtalk" }',
            '```',
            '</review_comment>',
          ].join('\n'),
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    const card = await screen.findByTestId('code-agent-review-comment-card');
    const chip = within(card).getByTestId('code-agent-review-comment-file-chip');
    expect(within(chip).getByText('workspace/package.json')).toBeTruthy();
    expect(chip.getAttribute('title')).toBe('/workspace/package.json');
    expect(chip.querySelector('[data-pierre-icon="t3-file-icon-package-json"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/workspace/package.json');
  });

  it('keeps code-agent tool events addressable as normal message items', () => {
    render(
      <MessageItem
        message={{
          ...message,
          id: 'tool-call-message',
          clientId: 'code_agent_runner',
          content: '',
          messageType: 'tool_call',
          toolName: 'Read',
          toolArgs: { file_path: 'README.md' },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    const item = screen.getByTestId('message-item');
    expect(item.getAttribute('data-message-id')).toBe('tool-call-message');
    expect(within(item).getByText('Read')).toBeTruthy();
    expect(within(item).getByText(/README\.md/)).toBeTruthy();
  });

  it('renders quoted image, video, and audio media references', async () => {
    getMediaDownloadUrlMock.mockImplementation(({ assetId }: { assetId: string }) => Promise.resolve({
      url: `https://signed.example/${assetId}`,
      expiresAt: '2026-05-03T10:15:00.000Z',
    }));

    const imageReply = {
      ...message,
      id: 'reply-to-image',
      replyTo: {
        messageId: 'quoted-image',
        username: 'Ada',
        messageType: 'media',
        mediaKind: 'image',
        preview: '[Image attachment]',
        mediaAsset: {
          id: 'asset-image',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          width: 12,
          height: 12,
        },
      },
    } as Message;
    const videoReply = {
      ...message,
      id: 'reply-to-video',
      replyTo: {
        messageId: 'quoted-video',
        username: 'Ada',
        messageType: 'media',
        mediaKind: 'video',
        preview: '[Video attachment]',
        mediaAsset: {
          id: 'asset-video',
          kind: 'video',
          mimeType: 'video/mp4',
          byteSize: 456,
          filename: 'clip.mp4',
        },
      },
    } as Message;
    const audioReply = {
      ...message,
      id: 'reply-to-audio',
      replyTo: {
        messageId: 'quoted-audio',
        username: 'Ada',
        messageType: 'media',
        mediaKind: 'audio',
        preview: '[Audio attachment]',
        mediaAsset: {
          id: 'asset-audio',
          kind: 'audio',
          mimeType: 'audio/webm',
          byteSize: 789,
          durationMs: 1200,
        },
      },
    } as Message;

    render(
      <>
        {[imageReply, videoReply, audioReply].map(item => (
          <MessageItem
            key={item.id}
            message={item}
            roomPermissions={null}
            onStartEdit={vi.fn()}
            onDeleteMessage={vi.fn()}
            onReply={vi.fn()}
          />
        ))}
      </>
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-image' });
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-video' });
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-audio' });
    });

    await waitFor(() => {
      expect(screen.getByAltText('sharedImage').getAttribute('src')).toBe('https://signed.example/asset-image');
      const video = document.querySelector('video[src="https://signed.example/asset-video"]') as HTMLVideoElement | null;
      const audio = document.querySelector('audio[src="https://signed.example/asset-audio"]') as HTMLAudioElement | null;
      expect(video?.controls).toBe(true);
      expect(audio?.controls).toBe(true);
    });
  });

  it('hides edit and delete actions unless the viewer owns the message or can manage all messages', () => {
    const { rerender } = render(
      <MessageItem
        message={message}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.queryByLabelText('editMessage')).toBeNull();
    expect(screen.queryByLabelText('deleteMessage')).toBeNull();

    rerender(
      <MessageItem
        message={message}
        roomPermissions={{
          roomId: 'room-1',
          clientId: 'viewer',
          role: 'owner',
          canPost: true,
          canEditAnyMessage: true,
          canDeleteAnyMessage: true,
          canClearHistory: true,
          canManageRoom: true,
          canManageAdmins: true,
          canManageMembers: true,
          canTransferOwnership: true,
          canUseCodeAgent: true,
        }}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByLabelText('editMessage')).toBeTruthy();
    expect(screen.getByLabelText('deleteMessage')).toBeTruthy();
  });

  it('shows queued state and routes queued message actions separately', async () => {
    const onEditQueuedMessage = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const onCancelQueuedMessage = vi.fn();

    render(
      <MessageItem
        message={{
          ...message,
          id: 'queued-1',
          clientId: 'viewer',
          codeAgentQueuedInput: {
            state: 'queued',
            queuedAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onEditQueuedMessage={onEditQueuedMessage}
        onSteerQueuedMessage={onSteerQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText('codeAgentQueued')).toBeTruthy();
    expect(screen.queryByLabelText('editMessage')).toBeNull();
    expect(screen.queryByLabelText('deleteMessage')).toBeNull();

    fireEvent.click(screen.getByLabelText('codeAgentQueuedActions'));
    fireEvent.click(await screen.findByText('editMessage'));
    expect(onEditQueuedMessage).toHaveBeenCalledWith('queued-1');

    fireEvent.click(await screen.findByText('codeAgentSteerInstead'));
    expect(onSteerQueuedMessage).toHaveBeenCalledWith('queued-1');

    fireEvent.click(await screen.findByText('codeAgentCancelQueued'));
    expect(onCancelQueuedMessage).toHaveBeenCalledWith('queued-1');
  });

  it('shows optimistic pending and failed delivery states', () => {
    const { rerender } = render(
      <MessageItem
        message={{ ...message, clientId: 'viewer', deliveryStatus: 'pending' }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText(/messageSending/)).toBeTruthy();

    rerender(
      <MessageItem
        message={{
          ...message,
          clientId: 'viewer',
          deliveryStatus: 'failed',
          deliveryError: 'network down',
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText(/network down/)).toBeTruthy();
  });

  it('sends current room AI settings with A2UI actions', async () => {
    localStorage.setItem('aiRoles', JSON.stringify([
      {
        id: 'default',
        name: 'Assistant',
        systemPrompt: 'You are helpful',
        color: 'secondary',
        icon: 'lucide:bot',
      },
      {
        id: 'a2ui-demo',
        name: 'A2UI Demo',
        systemPrompt: 'Use A2UI',
        color: 'warning',
        icon: 'lucide:layout-dashboard',
      },
    ]));
    localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'a2ui-demo',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));
    sendA2UIActionMock.mockResolvedValue(undefined);

    render(
      <MessageItem
        message={{
          ...message,
          id: 'ai-message',
          messageType: 'ai',
          uiPayload: {
            format: 'a2ui',
            version: 'v0.9',
            messages: [],
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('a2ui-action'));

    await waitFor(() => {
      expect(sendA2UIActionMock).toHaveBeenCalledWith({
        roomId: 'room-1',
        messageId: 'ai-message',
        action: {
          name: 'refresh',
          surfaceId: 'surface-1',
          sourceComponentId: 'refresh_btn',
          timestamp: '2026-05-03T10:00:00.000Z',
          context: { followUp: true },
        },
        systemPrompt: 'Use A2UI',
        roleName: 'A2UI Demo',
        model: 'deepseek-v4-pro',
        maxContextMessages: 1,
      });
    });
  });

  it('omits chat role settings from code-agent A2UI actions', async () => {
    localStorage.setItem('aiRoles', JSON.stringify([
      {
        id: 'default',
        name: 'Assistant',
        systemPrompt: 'You are helpful',
        color: 'secondary',
        icon: 'lucide:bot',
      },
      {
        id: 'a2ui-demo',
        name: 'A2UI Demo',
        systemPrompt: 'Use A2UI',
        color: 'warning',
        icon: 'lucide:layout-dashboard',
      },
    ]));
    localStorage.setItem('roomtalk:ai-settings:room-1', JSON.stringify({
      selectedRoleId: 'a2ui-demo',
      selectedModel: 'deepseek-v4-pro',
      maxContextMessages: 1,
    }));
    sendA2UIActionMock.mockResolvedValue(undefined);

    render(
      <MessageItem
        message={{
          ...message,
          id: 'ai-message',
          messageType: 'ai',
          uiPayload: {
            format: 'a2ui',
            version: 'v0.9',
            messages: [],
          },
        }}
        aiRequestRoomKind="codeAgent"
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('a2ui-action'));

    await waitFor(() => {
      expect(sendA2UIActionMock).toHaveBeenCalledTimes(1);
    });
    const payload = sendA2UIActionMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      roomId: 'room-1',
      messageId: 'ai-message',
      action: {
        name: 'refresh',
        surfaceId: 'surface-1',
        sourceComponentId: 'refresh_btn',
        timestamp: '2026-05-03T10:00:00.000Z',
        context: { followUp: true },
      },
      model: 'deepseek-v4-pro',
      maxContextMessages: 1,
    });
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(payload).not.toHaveProperty('roleName');
  });

  it('loads signed URLs for asset-backed images without using legacy base64 content', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
            width: 10,
            height: 20,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'asset-1' });
    });
    await waitFor(() => {
      const primaryImage = screen.getAllByAltText('sharedImage')
        .find(element => element.getAttribute('aria-hidden') !== 'true');
      expect(primaryImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
    });
  });

  it('renders file attachments as a download card', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/file-1?token=abc',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'file-message',
          content: '',
          messageType: 'media',
          mimeType: 'text/markdown',
          mediaAsset: {
            id: 'file-1',
            kind: 'file',
            mimeType: 'text/markdown',
            byteSize: 2048,
            filename: 'notes.md',
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    const fileCard = screen.getByText('notes.md').closest('.roomtalk-sender-outline') as HTMLElement | null;
    expect(fileCard?.style.getPropertyValue('--roomtalk-sender-outline-light')).toBe(getSenderColorTheme('sender').outlineLight);
    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'file-1' });
    });

    fireEvent.click(screen.getByLabelText('downloadFile'));
    await waitFor(() => {
      expect(saveUrlAsFileMock).toHaveBeenCalledWith('https://signed.example/rooms/room-1/file-1?token=abc', 'notes.md');
    });
    expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
  });

  it('opens asset-backed images in the full-screen media viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-viewer-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
            width: 10,
            height: 20,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText('downloadMedia')).toBeNull();
    expect(screen.queryByLabelText('shareMedia')).toBeNull();

    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);

    expect(screen.getByRole('dialog', { name: 'mediaViewer' })).toBeTruthy();
    expect(screen.getAllByLabelText('downloadMedia').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('openMediaHistory').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('shareMedia').length).toBeGreaterThan(0);

    const stage = screen.getByTestId('media-viewer-stage');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 500 });
    const activeViewerImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
    expect(activeViewerImage).toBeTruthy();
    fireEvent.doubleClick(stage, { clientX: 200, clientY: 220 });
    await waitFor(() => {
      expect((activeViewerImage as HTMLElement).style.transform).toContain('scale(2)');
    });
    fireEvent.mouseDown(stage, { button: 0, clientX: 200, clientY: 220 });
    fireEvent.mouseUp(stage, { button: 0, clientX: 200, clientY: 220 });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });
  });

  it('shrinks the media and fades viewer chrome while dragging down to dismiss', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-drag-dismiss-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
            width: 10,
            height: 20,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);

    const dialog = screen.getByRole('dialog', { name: 'mediaViewer' });
    const stage = screen.getByTestId('media-viewer-stage');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 500 });

    fireEvent.mouseDown(stage, { button: 0, clientX: 200, clientY: 220 });
    fireEvent.mouseMove(stage, { buttons: 1, clientX: 202, clientY: 340 });

    await waitFor(() => {
      expect(stage.style.transform).toContain('translate3d(0, 120px, 0) scale(');
      expect(stage.style.transform).not.toBe('translate3d(0, 0, 0) scale(1)');
      expect(dialog.style.backgroundColor).toContain('rgba(8, 8, 7');
      expect(dialog.style.getPropertyValue('--media-viewer-chrome-opacity')).not.toBe('1');
    });

    fireEvent.mouseUp(stage, { button: 0, clientX: 202, clientY: 340 });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });
  });

  it('opens recent room media history and returns from preview to the grid', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [{
        assetId: 'asset-2',
        messageId: 'media-message-2',
        kind: 'image',
        mimeType: 'image/webp',
        byteSize: 456,
        createdAt: '2026-06-01T10:00:00.000Z',
        url: 'https://signed.example/rooms/room-1/asset-2.webp',
      }],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });
    expect(screen.getByText(/mediaHistoryRecentMonths/)).toBeTruthy();
    expect(screen.getByLabelText('openMediaItem')).toBeTruthy();
    expect(screen.getByLabelText('closeMediaHistory')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('openMediaItem'));
    const historySection = screen.getByRole('region', { name: 'mediaHistory' });
    await waitFor(() => {
      expect(within(historySection).getAllByLabelText('backToMediaHistory').length).toBeGreaterThan(0);
    });
    expect(within(historySection).getAllByLabelText('downloadMedia').length).toBeGreaterThan(0);
    expect(within(historySection).getAllByLabelText('shareMedia').length).toBeGreaterThan(0);
    const viewerImages = screen.getAllByAltText('sharedImage');
    expect(viewerImages.some(element => element.getAttribute('src') === 'https://signed.example/rooms/room-1/asset-2.webp')).toBe(true);

    const historyStage = screen.getByTestId('history-media-stage');
    Object.defineProperty(historyStage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(historyStage, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.pointerDown(historyStage, { pointerId: 1, pointerType: 'touch', clientX: 160, clientY: 160 });
    fireEvent.pointerMove(historyStage, { pointerId: 1, pointerType: 'touch', clientX: 164, clientY: 250 });
    expect(within(historySection).getAllByLabelText('backToMediaHistory').length).toBeGreaterThan(0);
    fireEvent.pointerUp(historyStage, { pointerId: 1, pointerType: 'touch', clientX: 164, clientY: 250 });
    await waitFor(() => {
      expect(within(historySection).queryAllByLabelText('backToMediaHistory')).toHaveLength(0);
    });
    expect(screen.getByText(/mediaHistoryRecentMonths/)).toBeTruthy();

    expect(screen.queryByLabelText('closeMediaHistory')).toBeNull();
    fireEvent.click(within(historySection).getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });
  });

  it('orders media history from oldest to newest so latest appears last', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-current.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [
        {
          assetId: 'asset-new',
          messageId: 'media-message-new',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-new.webp',
        },
        {
          assetId: 'asset-middle',
          messageId: 'media-message-middle',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-03T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-middle.webp',
        },
        {
          assetId: 'asset-old',
          messageId: 'media-message-old',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-old.webp',
        },
      ],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-order-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-current',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      const images = Array.from(document.body.querySelectorAll('[aria-label="openMediaItem"] img'));
      expect(images.map(image => image.getAttribute('src'))).toEqual([
        'https://signed.example/rooms/room-1/asset-old.webp',
        'https://signed.example/rooms/room-1/asset-middle.webp',
        'https://signed.example/rooms/room-1/asset-new.webp',
      ]);
    });
  });

  it('filters media history by video in the viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-current.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock
      .mockResolvedValueOnce({
        roomId: 'room-1',
        items: [{
          assetId: 'asset-image',
          messageId: 'media-message-image',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-image.webp',
        }],
        hasMore: false,
        nextCursor: null,
        windowMonths: 6,
      })
      .mockResolvedValueOnce({
        roomId: 'room-1',
        items: [{
          assetId: 'asset-video',
          messageId: 'media-message-video',
          kind: 'video',
          mimeType: 'video/mp4',
          byteSize: 789,
          createdAt: '2026-06-02T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-video.mp4?token=abc',
        }],
        hasMore: false,
        nextCursor: null,
        windowMonths: 6,
      });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-history-filter-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-current',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    fireEvent.click(screen.getByLabelText('openMediaHistory'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });

    fireEvent.click(screen.getByLabelText('mediaHistory mediaHistoryFilterAll'));
    fireEvent.click(await screen.findByText('mediaHistoryFilterVideos'));

    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36, kind: 'video' });
    });
    const historyVideo = document.body.querySelector('[aria-label="openMediaItem"] video');
    expect(historyVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-video.mp4?token=abc#t=0.001');
  });

  it('swipes between room media from a single expanded image', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [
        {
          assetId: 'asset-3',
          messageId: 'media-message-3',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-3.webp',
        },
        {
          assetId: 'asset-1',
          messageId: 'media-message-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          createdAt: '2026-05-03T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-1.webp',
        },
        {
          assetId: 'asset-2',
          messageId: 'media-message-2',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-05-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-2.webp',
        },
      ],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-swipe-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    await waitFor(() => {
      expect(getRoomMediaHistoryMock).toHaveBeenCalledWith({ roomId: 'room-1', before: null, limit: 36 });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('nextMedia')).toBeTruthy();
    });

    const stage = screen.getByTestId('media-viewer-stage');
    const track = screen.getByTestId('media-carousel-track');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });

    fireEvent.mouseDown(stage, { clientX: 320, clientY: 220 });
    fireEvent.mouseMove(stage, { clientX: 20, clientY: 224 });
    await waitFor(() => {
      expect(track.getAttribute('style')).toContain('translate3d(-600px, 0, 0)');
    });
    fireEvent.mouseUp(stage, { clientX: 20, clientY: 224 });
    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-3.webp');
    });

    fireEvent.mouseDown(stage, { clientX: 120, clientY: 220 });
    fireEvent.mouseUp(stage, { clientX: 320, clientY: 224 });
    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
    });
  });

  it('reopens a media viewer on the clicked image after swiping away', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/asset-1.webp',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [
        {
          assetId: 'asset-3',
          messageId: 'media-message-3',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 456,
          createdAt: '2026-06-01T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-3.webp',
        },
        {
          assetId: 'asset-1',
          messageId: 'media-message-1',
          kind: 'image',
          mimeType: 'image/webp',
          byteSize: 123,
          createdAt: '2026-05-03T10:00:00.000Z',
          url: 'https://signed.example/rooms/room-1/asset-1.webp',
        },
      ],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'image-reopen-message',
          content: '',
          messageType: 'media',
          mimeType: 'image/webp',
          mediaAsset: {
            id: 'asset-1',
            kind: 'image',
            mimeType: 'image/webp',
            byteSize: 123,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    await waitFor(() => {
      expect(screen.getByLabelText('nextMedia')).toBeTruthy();
    });

    const stage = screen.getByTestId('media-viewer-stage');
    const track = screen.getByTestId('media-carousel-track');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });

    fireEvent.mouseDown(stage, { clientX: 280, clientY: 220 });
    fireEvent.mouseMove(stage, { clientX: 20, clientY: 224 });
    fireEvent.mouseUp(stage, { clientX: 20, clientY: 224 });

    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-3.webp');
    });

    fireEvent.click(screen.getByLabelText('close'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'mediaViewer' })).toBeNull();
    });

    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    await waitFor(() => {
      const activeImage = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] img');
      expect(activeImage?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/asset-1.webp');
    });
  });

  it('swipes between room media while a full-screen video is active', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getRoomMediaHistoryMock.mockResolvedValue({
      roomId: 'room-1',
      items: [{
        assetId: 'video-2',
        messageId: 'media-message-video-2',
        kind: 'video',
        mimeType: 'video/mp4',
        byteSize: 456,
        createdAt: '2026-06-01T10:00:00.000Z',
        url: 'https://signed.example/rooms/room-1/video-2.mp4',
      }],
      hasMore: false,
      nextCursor: null,
      windowMonths: 6,
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'video-swipe-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'video-1',
            kind: 'video',
            mimeType: 'video/mp4',
            byteSize: 789,
            durationMs: 2400,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);
    await waitFor(() => {
      expect(screen.getByLabelText('nextMedia')).toBeTruthy();
    });

    const stage = screen.getByTestId('media-viewer-stage');
    const track = screen.getByTestId('media-carousel-track');
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(track, 'clientWidth', { configurable: true, value: 300 });

    const activeVideo = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] video');
    expect(activeVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123');

    fireEvent.mouseDown(stage, { clientX: 280, clientY: 220 });
    fireEvent.mouseMove(stage, { clientX: 20, clientY: 222 });
    fireEvent.mouseUp(stage, { clientX: 20, clientY: 222 });

    await waitFor(() => {
      const nextVideo = document.body.querySelector('[data-testid="media-viewer-stage"] [data-active-media="true"] video');
      expect(nextVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-2.mp4');
    });
  });

  it('renders audio media messages through signed URLs', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/audio-1.webm',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    const { container } = render(
      <MessageItem
        message={{
          ...message,
          id: 'audio-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'audio-1',
            kind: 'audio',
            mimeType: 'audio/webm',
            byteSize: 456,
            durationMs: 1200,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'audio-1' });
    });
    const audio = container.querySelector('audio.roomtalk-audio-player');
    expect(audio).toBeTruthy();
    await waitFor(() => {
      expect(audio?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/audio-1.webm');
    });
    expect(audio?.parentElement?.className).toContain('w-fit max-w-full');
    await waitFor(() => {
      expect(getAudioTranscriptionMock).toHaveBeenCalledWith({ roomId: 'room-1', messageId: 'audio-message' });
    });
    expect(screen.getByText('transcribeAudio')).toBeTruthy();
  });

  it('requests and displays persisted audio transcriptions with hide and show controls', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/audio-1.webm',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });
    getAudioTranscriptionMock.mockResolvedValue({
      assetId: 'audio-1',
      roomId: 'room-1',
      messageId: 'audio-message',
      status: 'not_requested',
    });
    requestAudioTranscriptionMock.mockResolvedValue({
      assetId: 'audio-1',
      roomId: 'room-1',
      messageId: 'audio-message',
      status: 'completed',
      transcript: '你好 hello',
      languageCode: 'zh',
      updatedAt: '2026-05-03T10:16:00.000Z',
      completedAt: '2026-05-03T10:16:00.000Z',
    });

    render(
      <MessageItem
        message={{
          ...message,
          id: 'audio-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'audio-1',
            kind: 'audio',
            mimeType: 'audio/webm',
            byteSize: 456,
            durationMs: 1200,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByText('transcribeAudio'));
    await waitFor(() => {
      expect(requestAudioTranscriptionMock).toHaveBeenCalledWith({ roomId: 'room-1', messageId: 'audio-message' });
    });
    expect(await screen.findByText('你好 hello')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('hideAudioTranscript'));
    await waitFor(() => {
      expect(screen.queryByText('你好 hello')).toBeNull();
    });

    fireEvent.click(screen.getByText('showAudioTranscript'));
    expect(await screen.findByText('你好 hello')).toBeTruthy();
  });

  it('renders videos as tap-to-open previews and plays them inside the media viewer', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    const { container } = render(
      <MessageItem
        message={{
          ...message,
          id: 'video-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'video-1',
            kind: 'video',
            mimeType: 'video/mp4',
            byteSize: 789,
            durationMs: 2400,
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledWith({ roomId: 'room-1', assetId: 'video-1' });
    });

    const inlineVideo = container.querySelector('video');
    expect(inlineVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123#t=0.001');
    expect(inlineVideo?.hasAttribute('controls')).toBe(false);

    fireEvent.click(screen.getAllByLabelText('openMediaViewer')[0]);

    const viewerVideo = await waitFor(() => {
      const video = document.body.querySelector('[role="dialog"] video');
      expect(video).toBeTruthy();
      return video;
    });
    expect(viewerVideo?.getAttribute('src')).toBe('https://signed.example/rooms/room-1/video-1.mp4?X-Amz-Signature=abc123');
    expect(viewerVideo?.hasAttribute('controls')).toBe(true);
    expect(viewerVideo?.hasAttribute('autoplay')).toBe(false);
    expect(viewerVideo?.hasAttribute('muted')).toBe(false);

    fireEvent.error(viewerVideo as HTMLVideoElement);
    expect(await screen.findByText('videoPreviewUnsupported')).toBeTruthy();
  });

  it('shows a download fallback when the browser cannot preview a video', async () => {
    getMediaDownloadUrlMock.mockResolvedValue({
      url: 'https://signed.example/rooms/room-1/video-1.mov?X-Amz-Signature=abc123',
      expiresAt: '2026-05-03T10:15:00.000Z',
    });

    const { container } = render(
      <MessageItem
        message={{
          ...message,
          id: 'mov-message',
          content: '',
          messageType: 'media',
          mediaAsset: {
            id: 'video-1',
            kind: 'video',
            mimeType: 'video/quicktime',
            byteSize: 789,
            filename: 'clip.mov',
          },
        }}
        roomPermissions={null}
        onStartEdit={vi.fn()}
        onDeleteMessage={vi.fn()}
        onReply={vi.fn()}
      />
    );

    const firstVideo = await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).toBeTruthy();
      return video as HTMLVideoElement;
    });
    fireEvent.error(firstVideo);

    await waitFor(() => {
      expect(getMediaDownloadUrlMock).toHaveBeenCalledTimes(2);
    });
    const retriedVideo = await waitFor(() => {
      const video = container.querySelector('video');
      expect(video).toBeTruthy();
      return video as HTMLVideoElement;
    });
    fireEvent.error(retriedVideo);

    expect(await screen.findByText(/videoPreviewUnsupported/)).toBeTruthy();
    expect(screen.getByLabelText('downloadMedia')).toBeTruthy();
    expect(screen.getAllByLabelText('openMediaViewer').length).toBeGreaterThan(0);
  });
});
