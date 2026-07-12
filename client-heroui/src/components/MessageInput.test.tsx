// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { clearRegisteredMediaUploadsForTests } from '../utils/mediaUploadTasks';
import { MessageInput } from './MessageInput';

const socketMocks = vi.hoisted(() => ({
  interruptCodeAgentTurn: vi.fn(),
  queueCodeAgentInput: vi.fn(),
  requestAIResponse: vi.fn(),
  sendMessage: vi.fn(),
  sendMessageAndAskAI: vi.fn(),
  sendSticker: vi.fn(),
  prepareMediaUpload: vi.fn(),
  completeMediaUpload: vi.fn(),
  uploadMediaMessage: vi.fn(),
}));

const stickerMocks = vi.hoisted(() => ({
  suggestions: [] as Array<{ id: string; keywords: string[]; url: string }>,
}));
const disclosureMocks = vi.hoisted(() => ({
  isOpen: false,
  onOpen: vi.fn(),
  onClose: vi.fn(),
}));
const streamingTranscriptionMocks = vi.hoisted(() => ({
  startStreamingTranscription: vi.fn(),
}));

vi.mock('../utils/socket', () => socketMocks);

vi.mock('../utils/streamingTranscription', () => streamingTranscriptionMocks);

vi.mock('browser-image-compression', () => ({
  default: vi.fn(async (file: File) => file),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, onClick, isDisabled, type = 'button', ...props }: any) => (
    <button type={type} onClick={onClick || onPress} disabled={isDisabled} {...props}>
      {children}
    </button>
  ),
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <>{children}</>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
  Tooltip: ({ children, content }: any) => (
    <span data-tooltip-content={typeof content === 'string' ? content : undefined}>
      {children}
    </span>
  ),
  useDisclosure: () => disclosureMocks,
}));

vi.mock('../hooks/useStickers', () => ({
  useStickerCatalog: () => null,
  useStickerUrl: () => undefined,
  useStickerSearch: () => stickerMocks.suggestions,
  useRecentStickers: () => ({ recentIds: [], pushRecent: vi.fn() }),
}));

vi.mock('./StickerPicker', () => ({
  StickerPicker: ({ onSelect }: { onSelect: (stickerId: string) => void }) => (
    <button type="button" onClick={() => onSelect('sticker-1')}>picker-sticker</button>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
  }),
}));

vi.mock('../hooks/useAIRoles', () => ({
  useAIRoles: () => ({
    aiRoles: [{
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'You are helpful',
      icon: 'lucide:bot',
      color: 'primary',
    }],
    selectedRoleId: 'assistant',
    selectedRole: {
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'You are helpful',
      icon: 'lucide:bot',
      color: 'primary',
    },
    handleRoleChange: vi.fn(),
    handleAddRole: vi.fn(),
    handleUpdateRole: vi.fn(),
    handleDeleteRole: vi.fn(),
  }),
}));

vi.mock('../hooks/useAIModelSelection', () => ({
  useAIModelSelection: () => ({
    aiModels: [{
      id: 'model-a',
      apiModel: 'provider/model-a',
      provider: 'openrouter',
      label: 'Model A',
    }],
    defaultAIModel: 'model-a',
    selectedAIModel: 'model-a',
    handleModelChange: vi.fn(),
  }),
}));

vi.mock('./MessageInputAIControls', () => ({
  MessageInputAISettingsButton: ({ onOpen, isDisabled }: any) => (
    <button type="button" onClick={onOpen} disabled={isDisabled} aria-label="ai-settings">
      settings
    </button>
  ),
  MessageInputAIControls: ({ onAskAI, onSend, isAiProcessing, isAgentRunning, currentInputText, imageCount, isCodeAgentRoom, codeAgentBackend, codeAgentMode, codeAgentAvailableModes }: any) => (
    <div
      data-testid="message-input-ai-controls"
      data-ai-processing={String(Boolean(isAiProcessing))}
      data-code-agent-room={String(Boolean(isCodeAgentRoom))}
      data-code-agent-backend={codeAgentBackend || ''}
      data-code-agent-mode={codeAgentMode || ''}
      data-code-agent-available-modes={(codeAgentAvailableModes || []).join(',')}
    >
      <button
        type="button"
        onClick={() => onAskAI(isAgentRunning ? ((currentInputText?.trim() || imageCount) ? 'queue' : 'stop') : 'run')}
      >ask-ai</button>
      <button type="button" onClick={onSend}>send-message</button>
    </div>
  ),
}));

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'server-message-1',
  clientId: 'client-1',
  content: 'hello',
  roomId: 'room-1',
  timestamp: '2026-05-03T10:00:00.000Z',
  messageType: 'text',
  ...overrides,
});

const renderMessageInput = (props: Partial<ComponentProps<typeof MessageInput>> = {}) => {
  const defaults = {
    roomId: 'room-1',
    clientId: 'client-1',
    username: 'Ada',
    avatarText: 'A',
    avatarColor: '#123456',
    replyToMessage: null,
    onCancelReply: vi.fn(),
    onOptimisticMessage: vi.fn(),
    onOptimisticMessageSaved: vi.fn(),
    onOptimisticMessageFailed: vi.fn(),
  };

  const result = render(<MessageInput {...defaults} {...props} />);
  const editor = screen.getByTestId('message-editor');
  Object.defineProperty(editor, 'innerText', {
    configurable: true,
    get: () => editor.textContent || '',
  });

  return { ...result, props: { ...defaults, ...props }, editor };
};

const setEditorText = (editor: HTMLElement, text: string) => {
  editor.textContent = text;
  fireEvent.input(editor);
};

const setNavigatorPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
};

const expectAskAIShortcut = async (content: string) => {
  await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
  expect(socketMocks.sendMessageAndAskAI.mock.calls[0][0]).toMatchObject({
    roomId: 'room-1',
    content,
    systemPrompt: 'You are helpful',
    roleName: 'Assistant',
    model: 'model-a',
  });
  expect(socketMocks.sendMessage).not.toHaveBeenCalled();
  expect(socketMocks.requestAIResponse).not.toHaveBeenCalled();
};

const installVoiceRecordingMocks = () => {
  const trackStop = vi.fn();
  const stream = {
    getTracks: () => [{ stop: trackStop }],
  };

  class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => true);

    state = 'inactive';
    mimeType: string;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;

    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType || 'audio/webm';
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      const blob = new Blob([new Uint8Array(2048).fill(7)], { type: this.mimeType });
      this.ondataavailable?.({ data: blob } as BlobEvent);
      this.onstop?.(new Event('stop'));
    }
  }

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
    },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:voice-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });

  return { trackStop };
};

describe('MessageInput optimistic send flow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearRegisteredMediaUploadsForTests();
    stickerMocks.suggestions = [];
    disclosureMocks.isOpen = false;
    setNavigatorPlatform('Win32');
    localStorage.removeItem('roomtalk:ai-context-message-limit');
    socketMocks.requestAIResponse.mockResolvedValue(undefined);
    socketMocks.interruptCodeAgentTurn.mockResolvedValue(undefined);
    socketMocks.queueCodeAgentInput.mockResolvedValue(message({
      id: 'queued-message',
      codeAgentQueuedInput: {
        state: 'queued',
        queuedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    }));
    socketMocks.sendMessage.mockResolvedValue(message());
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: message(),
      aiMessageId: 'ai-message-1',
      aiStarted: true,
    });
    let preparedAssetSequence = 0;
    socketMocks.prepareMediaUpload.mockImplementation(async (params: any) => {
      preparedAssetSequence += 1;
      return {
        assetId: `asset-${preparedAssetSequence}`,
        objectKey: `rooms/${params.roomId}/media/${params.kind}/asset-${preparedAssetSequence}`,
        roomId: params.roomId,
        kind: params.kind,
        mimeType: params.mimeType || params.file.type,
        byteSize: params.file.size,
        filename: params.filename,
      };
    });
    socketMocks.completeMediaUpload.mockImplementation(async ({ upload, clientMessageId }: any) => message({
      id: `message-${upload.assetId}`,
      clientMessageId,
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: upload.assetId,
        kind: upload.kind,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        filename: upload.filename,
      },
    }));
  socketMocks.sendSticker.mockResolvedValue(message({
      id: 'sticker-message',
      content: 'sticker-1',
    messageType: 'sticker',
  }));
    socketMocks.uploadMediaMessage.mockResolvedValue(message({
      id: 'audio-message',
      content: '',
      messageType: 'media',
      mediaAsset: {
        id: 'asset-audio',
        kind: 'audio',
        mimeType: 'audio/webm',
        byteSize: 2048,
      },
    }));
    streamingTranscriptionMocks.startStreamingTranscription.mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
      getText: vi.fn(() => ''),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('clears text input immediately and sends text with a clientMessageId', async () => {
    let resolveSend!: (message: Message) => void;
    socketMocks.sendMessage.mockImplementation(() => new Promise<Message>((resolve) => {
      resolveSend = resolve;
    }));

    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'hello');

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(props.onOptimisticMessage).toHaveBeenCalledTimes(1));
    const optimisticMessage = (props.onOptimisticMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as Message;

    expect(editor.textContent).toBe('');
    expect(optimisticMessage).toMatchObject({
      content: 'hello',
      deliveryStatus: 'pending',
      deliveryAction: 'send',
      clientId: 'client-1',
      roomId: 'room-1',
      username: 'Ada',
      avatar: { text: 'A', color: '#123456' },
    });
    expect(socketMocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      'room-1',
      'text',
      'Ada',
      { text: 'A', color: '#123456' },
      undefined,
      optimisticMessage.clientMessageId
    );

    const savedMessage = message({
      id: 'server-message-2',
      content: 'hello',
      clientMessageId: optimisticMessage.clientMessageId,
    });
    await act(async () => {
      resolveSend(savedMessage);
    });

    await waitFor(() => {
      expect(props.onOptimisticMessageSaved).toHaveBeenCalledWith(
        optimisticMessage.clientMessageId,
        savedMessage
      );
    });
  });

  it('uses send_message_and_ask_ai when Ask AI has text input', async () => {
    const savedMessage = message({ id: 'server-message-3', content: 'ask this' });
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: savedMessage,
      aiMessageId: 'ai-message-1',
      aiStarted: true,
    });

    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'ask this');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    const optimisticMessage = (props.onOptimisticMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as Message;

    expect(editor.textContent).toBe('');
    expect(optimisticMessage.deliveryAction).toBe('ask-ai');
    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    expect(socketMocks.requestAIResponse).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledWith({
      roomId: 'room-1',
      content: 'ask this',
      username: 'Ada',
      avatar: { text: 'A', color: '#123456' },
      replyToMessageId: undefined,
      clientMessageId: optimisticMessage.clientMessageId,
      systemPrompt: 'You are helpful',
      roleName: 'Assistant',
      model: 'model-a',
      maxContextMessages: 100,
    });
    expect(optimisticMessage).toMatchObject({
      content: 'ask this',
      deliveryStatus: 'pending',
    });

    await waitFor(() => {
      expect(props.onOptimisticMessageSaved).toHaveBeenCalledWith(
        optimisticMessage.clientMessageId,
        savedMessage
      );
    });
  });

  it('keeps a failed text-send card visible without announcing the same optimistic failure twice', async () => {
    socketMocks.sendMessage.mockRejectedValueOnce(new Error('offline'));
    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'will fail');

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(props.onOptimisticMessageFailed).toHaveBeenCalledTimes(1));
    const errorText = screen.getByText('errorSendingMessage');
    expect(errorText).toBeTruthy();
    expect(errorText.closest('[aria-live]')?.getAttribute('aria-live')).toBe('off');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a failed Ask AI card visible without a second live alert', async () => {
    socketMocks.sendMessageAndAskAI.mockRejectedValueOnce(new Error('AI offline'));
    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'ask and fail');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(props.onOptimisticMessageFailed).toHaveBeenCalledTimes(1));
    const errorText = screen.getByText('errorSendingAiRequest');
    expect(errorText.closest('[aria-live]')?.getAttribute('aria-live')).toBe('off');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps composer errors live when no optimistic failure announcer is present', async () => {
    socketMocks.sendMessage.mockRejectedValueOnce(new Error('offline'));
    const { editor } = renderMessageInput({ onOptimisticMessageFailed: undefined });
    setEditorText(editor, 'will fail loudly');

    fireEvent.click(screen.getByText('send-message'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('errorSendingMessage');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
  });

  it('uses Ask AI for Ctrl+Enter on non-macOS platforms', async () => {
    setNavigatorPlatform('Win32');

    const { editor } = renderMessageInput();
    setEditorText(editor, 'ask with ctrl shortcut');

    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    await expectAskAIShortcut('ask with ctrl shortcut');
  });

  it.each([
    ['Command+Enter on non-macOS', 'Win32', { metaKey: true }],
    ['Alt+Enter', 'MacIntel', { altKey: true }],
  ])('ignores %s instead of falling back to normal send', (_label, platform, modifiers) => {
    setNavigatorPlatform(platform);

    const { editor } = renderMessageInput();
    setEditorText(editor, 'do not send');

    fireEvent.keyDown(editor, { key: 'Enter', ...modifiers });

    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
    expect(socketMocks.requestAIResponse).not.toHaveBeenCalled();
  });

  it('uses Ask AI for Command+Enter on macOS', async () => {
    setNavigatorPlatform('MacIntel');

    const { editor } = renderMessageInput();
    setEditorText(editor, 'ask with command shortcut');

    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });

    await expectAskAIShortcut('ask with command shortcut');
  });

  it('uses Ask AI for Command+Enter immediately after IME composition ends', async () => {
    setNavigatorPlatform('MacIntel');

    const { editor } = renderMessageInput();
    setEditorText(editor, '中文问题');

    fireEvent.compositionStart(editor);
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });

    await expectAskAIShortcut('中文问题');
  });

  it('uses code-agent mode without ordinary role prompts for Code Agent Ask AI', async () => {
    const savedMessage = message({ id: 'server-message-code-agent', content: 'write python' });
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: savedMessage,
      aiMessageId: 'code-agent-ai-message-1',
      aiStarted: true,
    });

    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      codeAgentMode: 'plan',
      codeAgentAvailableModes: ['plan', 'edit'],
    });
    setEditorText(editor, 'write python');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    const payload = socketMocks.sendMessageAndAskAI.mock.calls[0][0];

    expect(screen.getByTestId('message-input-ai-controls').dataset.codeAgentRoom).toBe('true');
    expect(screen.getByTestId('message-input-ai-controls').dataset.codeAgentBackend).toBe('code-agent');
    expect(screen.getByTestId('message-input-ai-controls').dataset.codeAgentMode).toBe('plan');
    expect(payload).toMatchObject({
      roomId: 'room-1',
      content: 'write python',
      model: 'model-a',
    });
    expect(payload).not.toHaveProperty('codeAgentMode');
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(payload).not.toHaveProperty('roleName');
  });

  it('sends Codex subscription model settings for Codex Ask AI', async () => {
    const savedMessage = message({ id: 'server-message-codex', content: 'who are you' });
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: savedMessage,
      aiMessageId: 'codex-ai-message-1',
      aiStarted: true,
    });

    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      codeAgentBackend: 'codex-app-server',
      codeAgentMode: 'plan',
      codeAgentAvailableModes: ['plan', 'edit', 'approveForMe', 'fullAccess'],
    });
    setEditorText(editor, 'who are you');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    const payload = socketMocks.sendMessageAndAskAI.mock.calls[0][0];

    expect(screen.getByTestId('message-input-ai-controls').dataset.codeAgentBackend).toBe('codex-app-server');
    expect(payload).toMatchObject({
      roomId: 'room-1',
      content: 'who are you',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
      codexPermissionMode: 'plan',
      codexServiceTier: 'default',
    });
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(payload).not.toHaveProperty('roleName');
  });

  it('uses the agent control action to stop a running turn when the input is empty', async () => {
    const rendered = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
    });

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledWith('room-1'));
    expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('true');
    expect(socketMocks.queueCodeAgentInput).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();

    rendered.rerender(<MessageInput {...rendered.props} isRoomAIProcessing={false} />);
    await waitFor(() => {
      expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('false');
    });
  });

  it('does not carry a pending stop lock into another running room', async () => {
    let rejectFirstStop!: (reason?: unknown) => void;
    socketMocks.interruptCodeAgentTurn.mockImplementation((targetRoomId: string) => {
      if (targetRoomId === 'room-1') {
        return new Promise<void>((_resolve, reject) => {
          rejectFirstStop = reject;
        });
      }
      return new Promise<void>(() => {});
    });
    const rendered = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
    });

    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledWith('room-1'));
    expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('true');

    rendered.rerender(
      <MessageInput {...rendered.props} roomId="room-2" isRoomAIProcessing={true} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('false');
    });

    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledWith('room-2'));
    expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('true');

    await act(async () => {
      rejectFirstStop(new Error('stale room stop failed'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('true');
  });

  it('clears a pending stop lock when the room session becomes unverified', async () => {
    socketMocks.interruptCodeAgentTurn.mockImplementation(() => new Promise<void>(() => {}));
    const rendered = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      isRoomSessionReady: true,
      codeAgentBackend: 'codex-app-server',
    });

    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('true');

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={false} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('message-input-ai-controls').dataset.aiProcessing).toBe('false');
    });
    fireEvent.click(screen.getByText('ask-ai'));
    expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={true} />
    );
    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledTimes(2));
  });

  it('still allows a verified posting-closed room to stop its running agent', async () => {
    renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      isRoomSessionReady: true,
      canPost: false,
      codeAgentBackend: 'codex-app-server',
    });

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.interruptCodeAgentTurn).toHaveBeenCalledWith('room-1'));
  });

  it('blocks stop and queue actions while the restored room session is unverified', async () => {
    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      isRoomSessionReady: false,
      canPost: false,
      codeAgentBackend: 'codex-app-server',
    });

    fireEvent.click(screen.getByText('ask-ai'));
    setEditorText(editor, 'stale room queue');
    fireEvent.click(screen.getByText('ask-ai'));

    expect(socketMocks.interruptCodeAgentTurn).not.toHaveBeenCalled();
    expect(socketMocks.queueCodeAgentInput).not.toHaveBeenCalled();
    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
  });

  it('closes AI settings when the room session becomes unverified', () => {
    disclosureMocks.isOpen = true;
    const rendered = renderMessageInput({ isRoomSessionReady: true });

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={false} />
    );

    expect(disclosureMocks.onClose).toHaveBeenCalledTimes(1);
  });

  it('queues a complete next turn when the agent is running with text', async () => {
    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
    });
    setEditorText(editor, 'use Bing instead');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.queueCodeAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      content: 'use Bing instead',
      codexModel: 'gpt-5.6-sol',
      codeAgentMode: 'plan',
    })));
    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
    expect(socketMocks.interruptCodeAgentTurn).not.toHaveBeenCalled();
  });

  it('uploads attached images and links them to a code-agent run', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:agent-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const { editor, props } = renderMessageInput({
      isCodeAgentRoom: true,
      codeAgentBackend: 'codex-app-server',
    });
    setEditorText(editor, 'inspect this screenshot');
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('image-upload-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('attachment-draft').querySelectorAll('img')).toHaveLength(1));

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(props.onOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'media',
      deliveryStatus: 'pending',
      localMediaPreviewUrl: 'blob:agent-image',
    })));
    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    expect(socketMocks.prepareMediaUpload).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'screen.png',
    }));
    expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledWith(expect.objectContaining({
      content: 'inspect this screenshot',
      imageMessageIds: ['message-asset-1'],
    }));
  });

  it('uses the same optimistic media pipeline for images sent with normal Ask AI', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:chat-ai-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'consider this image');
    const file = new File([new Uint8Array([1, 2, 3])], 'chat-ai.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('image-upload-input'), { target: { files: [file] } });

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(props.onOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'media',
      localMediaPreviewUrl: 'blob:chat-ai-image',
      deliveryStatus: 'pending',
    })));
    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledWith(expect.objectContaining({
      content: 'consider this image',
    })));
  });

  it('queues an image-only code-agent turn with a durable image link', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:queued-agent-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'queued.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('image-upload-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('attachment-draft').querySelectorAll('img')).toHaveLength(1));

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.queueCodeAgentInput).toHaveBeenCalledTimes(1));
    expect(socketMocks.queueCodeAgentInput).toHaveBeenCalledWith(expect.objectContaining({
      content: 'codeAgentInspectAttachedImages',
      imageMessageIds: ['message-asset-1'],
    }));
    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Send as a chat-only action while an agent turn is running', async () => {
    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
    });
    setEditorText(editor, 'just a room message');

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(socketMocks.queueCodeAgentInput).not.toHaveBeenCalled();
    expect(socketMocks.interruptCodeAgentTurn).not.toHaveBeenCalled();
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
  });

  it('appends code review comments to Code Agent Ask AI prompts and clears them after send', async () => {
    const onClearReviewComments = vi.fn();
    const onRemoveReviewComment = vi.fn();
    const savedMessage = message({ id: 'server-message-review', content: 'review this' });
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: savedMessage,
      aiMessageId: 'code-agent-ai-message-review',
      aiStarted: true,
    });

    const { editor } = renderMessageInput({
      isCodeAgentRoom: true,
      reviewComments: [{
        id: 'comment-1',
        sectionId: 'file:src/App.tsx',
        sectionTitle: 'File comment',
        filePath: 'src/App.tsx',
        startIndex: 1,
        endIndex: 2,
        rangeLabel: 'L2 to L3',
        text: 'Please keep this typed.',
        diff: 'const value = 1;\nconst next = 2;',
        fenceLanguage: 'tsx',
      }],
      onClearReviewComments,
      onRemoveReviewComment,
    });
    setEditorText(editor, 'review this');

    expect(screen.getByText('src/App.tsx L2 to L3')).toBeTruthy();
    expect(document.querySelector('[data-tooltip-content="Please keep this typed."]')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('codeAgentRemoveReviewComment'));
    expect(onRemoveReviewComment).toHaveBeenCalledWith('comment-1');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    const payload = socketMocks.sendMessageAndAskAI.mock.calls[0][0];

    expect(payload.content).toContain('review this');
    expect(payload.content).toContain('<review_comment');
    expect(payload.content).toContain('filePath="src/App.tsx"');
    expect(payload.content).toContain('```tsx\nconst value = 1;\nconst next = 2;\n```');
    expect(onClearReviewComments).toHaveBeenCalledTimes(1);
  });

  it('confirms the optimistic message when only the AI startup fails', async () => {
    const savedMessage = message({ id: 'server-message-4', content: 'ask this' });
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: savedMessage,
      aiStarted: false,
      aiError: 'Unable to start a durable AI response',
    });

    const { editor, props } = renderMessageInput();
    setEditorText(editor, 'ask this');

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    const optimisticMessage = (props.onOptimisticMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as Message;

    await waitFor(() => {
      expect(props.onOptimisticMessageSaved).toHaveBeenCalledWith(
        optimisticMessage.clientMessageId,
        savedMessage
      );
    });
    expect(props.onOptimisticMessageFailed).not.toHaveBeenCalled();
  });

  it('keeps empty Ask AI requests on the existing ask_ai event', async () => {
    const { props } = renderMessageInput();

    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.requestAIResponse).toHaveBeenCalledTimes(1));
    expect(socketMocks.requestAIResponse).toHaveBeenCalledWith({
      roomId: 'room-1',
      systemPrompt: 'You are helpful',
      roleName: 'Assistant',
      model: 'model-a',
      maxContextMessages: 100,
    });
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    expect(props.onOptimisticMessage).not.toHaveBeenCalled();
  });

  it('opens voice mode as click choices instead of hold-to-speak', () => {
    renderMessageInput();

    fireEvent.click(screen.getByLabelText('voiceInput'));

    expect(screen.getByText('recordVoice')).toBeTruthy();
    expect(screen.getByText('voiceToText')).toBeTruthy();
    expect(screen.queryByText('holdToSpeak')).toBeNull();
  });

  it('previews recorded voice and sends the audio draft', async () => {
    installVoiceRecordingMocks();
    renderMessageInput();

    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));

    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));

    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());
    expect(document.querySelector('audio.roomtalk-audio-player')).toBeTruthy();

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => {
      expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1);
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[0][0]).toMatchObject({
      roomId: 'room-1',
      kind: 'audio',
      mimeType: 'audio/webm;codecs=opus',
      username: 'Ada',
      avatar: { text: 'A', color: '#123456' },
      replyToMessageId: undefined,
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[0][0].file).toBeInstanceOf(Blob);
  });

  it('stages arbitrary files and uploads them only after Send', async () => {
    renderMessageInput();
    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });

    fireEvent.change(screen.getByTestId('file-upload-input'), {
      target: { files: [file] },
    });

    expect(await screen.findByText('notes.md')).toBeTruthy();
    expect(screen.getByText(/7 B/)).toBeTruthy();
    expect(socketMocks.prepareMediaUpload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(1));
    expect(socketMocks.prepareMediaUpload.mock.calls[0][0]).toMatchObject({
      file,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      filename: 'notes.md',
    });
    expect(socketMocks.completeMediaUpload.mock.calls[0][0]).toMatchObject({
      username: 'Ada',
      avatar: { text: 'A', color: '#123456' },
      replyToMessageId: undefined,
    });
  });

  it('places mixed text before media and keeps media completion behind the text acknowledgement', async () => {
    let resolveText!: (value: Message) => void;
    socketMocks.sendMessage.mockImplementation(() => new Promise(resolve => { resolveText = resolve; }));
    const { editor, props } = renderMessageInput();
    const file = new File(['image'], 'mixed.png', { type: 'image/png' });

    setEditorText(editor, 'caption');
    fireEvent.change(screen.getByTestId('image-upload-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(props.onOptimisticMessage).toHaveBeenCalledTimes(2));
    const [optimisticText, optimisticMedia] = (props.onOptimisticMessage as ReturnType<typeof vi.fn>)
      .mock.calls
      .map(call => call[0] as Message);
    expect(optimisticText.messageType).toBe('text');
    expect(optimisticMedia.messageType).toBe('media');
    expect(new Date(optimisticText.timestamp).getTime()).toBeLessThan(
      new Date(optimisticMedia.timestamp).getTime(),
    );
    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(1));
    expect(socketMocks.completeMediaUpload).not.toHaveBeenCalled();

    await act(async () => {
      resolveText(message({
        id: 'saved-mixed-text',
        content: 'caption',
        clientMessageId: optimisticText.clientMessageId,
        timestamp: '2026-05-03T10:00:00.500Z',
      }));
    });

    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(1));
  });

  it('stages and sends multiple arbitrary picker files as a batch', async () => {
    renderMessageInput();
    const textFile = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    const movFile = new File(['mov'], 'IMG_0135.mov', { type: 'video/quicktime' });

    fireEvent.change(screen.getByTestId('file-upload-input'), {
      target: { files: [textFile, movFile] },
    });

    expect(await screen.findAllByTestId('attachment-draft')).toHaveLength(2);
    expect(socketMocks.prepareMediaUpload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(2));
    expect(socketMocks.prepareMediaUpload.mock.calls[0][0]).toMatchObject({
      file: textFile,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      filename: 'notes.md',
    });
    expect(socketMocks.prepareMediaUpload.mock.calls[1][0]).toMatchObject({
      file: movFile,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'video/quicktime',
      filename: 'IMG_0135.mov',
    });
    expect((screen.getByTestId('file-upload-input') as HTMLInputElement).multiple).toBe(true);
  });

  it('stages extension-only MOV selections from the media picker as videos', async () => {
    renderMessageInput();
    const file = new File(['mov'], 'IMG_0135.mov');

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    expect(await screen.findByText('IMG_0135.mov')).toBeTruthy();
    expect(socketMocks.prepareMediaUpload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(1));
    expect(socketMocks.prepareMediaUpload.mock.calls[0][0]).toMatchObject({
      file,
      roomId: 'room-1',
      kind: 'video',
      mimeType: 'video/quicktime',
      filename: 'IMG_0135.mov',
    });
    expect(document.querySelector('[data-icon="lucide:image-plus"]')).toBeTruthy();
  });

  it('rejects arbitrary files larger than 50 MB before upload', async () => {
    renderMessageInput();
    const file = new File(['x'], 'archive.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: 50 * 1024 * 1024 + 1,
    });

    fireEvent.change(screen.getByTestId('file-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByText('fileTooLarge')).toBeTruthy();
    });
    expect(socketMocks.uploadMediaMessage).not.toHaveBeenCalled();
  });

  it('lets users dismiss validation errors and otherwise clears them after five seconds', async () => {
    vi.useFakeTimers();
    renderMessageInput();
    const file = new File(['x'], 'oversized.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: 50 * 1024 * 1024 + 1,
    });
    const fileInput = screen.getByTestId('file-upload-input');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    expect(screen.getByRole('alert').textContent).toContain('fileTooLarge');
    fireEvent.click(screen.getByLabelText('dismissError'));
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    expect(screen.getByRole('alert').textContent).toContain('fileTooLarge');
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('moves images into the message stream immediately and marks failed uploads there', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:image-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    socketMocks.prepareMediaUpload.mockRejectedValueOnce(new Error('upload failed'));

    const { editor, props } = renderMessageInput();
    const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    expect(await screen.findByText('image.png')).toBeTruthy();
    expect(screen.getByTestId('attachment-draft').getAttribute('data-attachment-status')).toBeNull();

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(props.onOptimisticMessageFailed).toHaveBeenCalledTimes(1));
    expect(editor.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByTestId('attachment-draft')).toBeNull();
    expect(props.onOptimisticMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'media',
      deliveryStatus: 'pending',
      localMediaPreviewUrl: 'blob:image-preview',
    }));
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:image-preview');
  });

  it('removes a staged attachment without uploading it', async () => {
    renderMessageInput();
    const file = new File(['draft'], 'remove-me.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [file] } });
    expect(await screen.findByText('remove-me.txt')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('removeAttachment:remove-me.txt'));

    expect(screen.queryByText('remove-me.txt')).toBeNull();
    expect(socketMocks.uploadMediaMessage).not.toHaveBeenCalled();
  });

  it('prepares media concurrently but completes messages in selection order', async () => {
    let resolveFirstPreparation!: (value: any) => void;
    let resolveSecondPreparation!: (value: any) => void;
    socketMocks.prepareMediaUpload
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstPreparation = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecondPreparation = resolve; }));
    const rendered = renderMessageInput();
    const first = new File(['first'], 'first.txt', { type: 'text/plain' });
    const second = new File(['second'], 'second.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [first, second] } });
    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(2));
    expect(rendered.props.onOptimisticMessage).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('attachment-draft')).toBeNull();

    await act(async () => {
      resolveSecondPreparation({
        assetId: 'asset-second', objectKey: 'second', roomId: 'room-1', kind: 'file',
        mimeType: 'text/plain', byteSize: second.size, filename: second.name,
      });
    });
    expect(socketMocks.completeMediaUpload).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstPreparation({
        assetId: 'asset-first', objectKey: 'first', roomId: 'room-1', kind: 'file',
        mimeType: 'text/plain', byteSize: first.size, filename: first.name,
      });
    });
    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(2));
    expect(socketMocks.completeMediaUpload.mock.calls.map(call => call[0].upload.assetId)).toEqual([
      'asset-first',
      'asset-second',
    ]);
  });

  it('detaches all attachments from the composer while their parallel work is active', async () => {
    let resolveFirst!: (value: any) => void;
    let resolveSecond!: (value: any) => void;
    socketMocks.prepareMediaUpload
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    const rendered = renderMessageInput();
    const first = new File(['first'], 'active.txt', { type: 'text/plain' });
    const second = new File(['second'], 'queued.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [first, second] } });
    fireEvent.click(screen.getByText('send-message'));
    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('attachment-draft')).toBeNull();
    expect(rendered.props.onOptimisticMessage).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveFirst({ assetId: 'asset-active', objectKey: 'active', roomId: 'room-1', kind: 'file', mimeType: 'text/plain', byteSize: first.size });
      resolveSecond({ assetId: 'asset-queued', objectKey: 'queued', roomId: 'room-1', kind: 'file', mimeType: 'text/plain', byteSize: second.size });
    });
    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(2));
  });

  it('clears attachment drafts and revokes previews when the room changes', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:room-one-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const rendered = renderMessageInput();
    const file = new File(['image'], 'room-one.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('image-upload-input'), { target: { files: [file] } });
    expect(await screen.findByText('room-one.png')).toBeTruthy();

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);

    await waitFor(() => expect(screen.queryByTestId('attachment-draft')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:room-one-image');
    expect(socketMocks.uploadMediaMessage).not.toHaveBeenCalled();
  });

  it('finishes already-sent media in its original room without updating the next room list', async () => {
    let resolveFirstComplete!: (value: Message) => void;
    socketMocks.completeMediaUpload
      .mockImplementationOnce(() => new Promise<Message>(resolve => { resolveFirstComplete = resolve; }));
    const rendered = renderMessageInput();
    const first = new File(['first'], 'first-room-one.txt', { type: 'text/plain' });
    const second = new File(['second'], 'second-room-one.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [first, second] } });
    fireEvent.click(screen.getByText('send-message'));
    await waitFor(() => expect(socketMocks.prepareMediaUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(1));
    expect(socketMocks.prepareMediaUpload.mock.calls.every(call => call[0].roomId === 'room-1')).toBe(true);

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await waitFor(() => expect(screen.queryByTestId('attachment-draft')).toBeNull());
    await act(async () => {
      resolveFirstComplete(message({ id: 'first-room-one-saved', roomId: 'room-1' }));
    });

    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(2));
    expect(rendered.props.onOptimisticMessageSaved).not.toHaveBeenCalled();
  });

  it('does not write a completed media task into an unverified room session', async () => {
    let resolveComplete!: (value: Message) => void;
    socketMocks.completeMediaUpload.mockImplementationOnce(() => new Promise<Message>(resolve => {
      resolveComplete = resolve;
    }));
    const rendered = renderMessageInput({ isRoomSessionReady: true });
    const file = new File(['session attachment'], 'session.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByTestId('file-upload-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByText('send-message'));
    await waitFor(() => expect(socketMocks.completeMediaUpload).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={false} />
    );

    await act(async () => resolveComplete(message({ id: 'late-session-attachment' })));
    expect(rendered.props.onOptimisticMessageSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-draft')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears room-one text before an immediate room-two Send action', async () => {
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'room-one-only text');

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    fireEvent.click(screen.getByText('send-message'));

    expect(socketMocks.sendMessage).not.toHaveBeenCalled();
    const nextEditor = screen.getByTestId('message-editor');
    expect(nextEditor.textContent).toBe('');

    setEditorText(nextEditor, 'room-two text');
    fireEvent.click(screen.getByText('send-message'));
    await waitFor(() => expect(socketMocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(socketMocks.sendMessage.mock.calls[0][1]).toBe('room-2');
  });

  it('does not reuse room-one text for an immediate room-two Ask AI action', async () => {
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'room-one-only question');

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    fireEvent.click(screen.getByText('ask-ai'));

    await waitFor(() => expect(socketMocks.requestAIResponse).toHaveBeenCalledTimes(1));
    expect(socketMocks.requestAIResponse.mock.calls[0][0].roomId).toBe('room-2');
    expect(socketMocks.sendMessageAndAskAI).not.toHaveBeenCalled();
  });

  it('ignores a text-send failure that arrives after switching rooms', async () => {
    let rejectSend!: (error: Error) => void;
    socketMocks.sendMessage.mockImplementationOnce(() => new Promise<Message>((_resolve, reject) => {
      rejectSend = reject;
    }));
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'old room text');
    fireEvent.click(screen.getByText('send-message'));
    await waitFor(() => expect(socketMocks.sendMessage).toHaveBeenCalledTimes(1));

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await act(async () => rejectSend(new Error('old room failed')));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(rendered.props.onOptimisticMessageFailed).not.toHaveBeenCalled();
  });

  it('unlocks the new room and ignores stale Ask AI failures after switching rooms', async () => {
    let rejectAskAI!: (error: Error) => void;
    socketMocks.sendMessageAndAskAI.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectAskAI = reject;
    }));
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'old room question');
    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.sendMessageAndAskAI).toHaveBeenCalledTimes(1));
    expect((screen.getByTestId('file-upload-input') as HTMLInputElement).disabled).toBe(true);

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await waitFor(() => {
      expect((screen.getByTestId('file-upload-input') as HTMLInputElement).disabled).toBe(false);
    });
    await act(async () => rejectAskAI(new Error('old AI request failed')));

    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByTestId('file-upload-input') as HTMLInputElement).disabled).toBe(false);
    expect(rendered.props.onOptimisticMessageFailed).not.toHaveBeenCalled();
  });

  it('ignores a queued agent success that arrives after switching rooms', async () => {
    let resolveQueue!: (value: Message) => void;
    socketMocks.queueCodeAgentInput.mockImplementationOnce(() => new Promise<Message>(resolve => {
      resolveQueue = resolve;
    }));
    const onClearReviewComments = vi.fn();
    const rendered = renderMessageInput({
      isCodeAgentRoom: true,
      isRoomAIProcessing: true,
      codeAgentBackend: 'codex-app-server',
      reviewComments: [{
        id: 'stale-comment',
        sectionId: 'file:src/App.tsx',
        sectionTitle: 'File comment',
        filePath: 'src/App.tsx',
        startIndex: 0,
        endIndex: 0,
        rangeLabel: 'L1',
        text: 'Keep this for the current room.',
        diff: 'const value = 1;',
        fenceLanguage: 'tsx',
      }],
      onClearReviewComments,
    });
    setEditorText(rendered.editor, 'old room queued task');
    fireEvent.click(screen.getByText('ask-ai'));
    await waitFor(() => expect(socketMocks.queueCodeAgentInput).toHaveBeenCalledTimes(1));
    expect(socketMocks.queueCodeAgentInput).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1' }));

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await act(async () => resolveQueue(message({
      id: 'room-one-queued-message',
      clientMessageId: 'room-one-queue-request',
      codeAgentQueuedInput: {
        state: 'queued',
        queuedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    })));

    expect(rendered.props.onOptimisticMessageSaved).not.toHaveBeenCalled();
    expect(onClearReviewComments).not.toHaveBeenCalled();
    expect(rendered.props.onCancelReply).not.toHaveBeenCalled();
  });

  it('stops an active recording and clears the voice editor snapshot when the room changes', async () => {
    const { trackStop } = installVoiceRecordingMocks();
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'private room-one draft');
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);

    const nextEditor = await screen.findByTestId('message-editor');
    await waitFor(() => expect(trackStop).toHaveBeenCalled());
    expect(nextEditor.textContent).toBe('');
    expect(screen.queryByText('stopRecording')).toBeNull();
    expect(screen.queryByText('private room-one draft')).toBeNull();
  });

  it('stops the microphone and streaming transcriber when the same room session becomes unverified', async () => {
    const { trackStop } = installVoiceRecordingMocks();
    const transcriberStop = vi.fn().mockResolvedValue(undefined);
    streamingTranscriptionMocks.startStreamingTranscription.mockResolvedValueOnce({
      stop: transcriberStop,
      getText: vi.fn(() => 'private transcript'),
    });
    const rendered = renderMessageInput({ isRoomSessionReady: true });

    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('voiceToText'));
    await waitFor(() => expect(streamingTranscriptionMocks.startStreamingTranscription).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('stopRecording')).toBeTruthy();

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={false} />
    );

    await waitFor(() => expect(trackStop).toHaveBeenCalled());
    await waitFor(() => expect(transcriberStop).toHaveBeenCalled());
    expect(screen.queryByText('stopRecording')).toBeNull();
  });

  it('revokes an unsent voice preview instead of carrying it into the next room', async () => {
    installVoiceRecordingMocks();
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'room-one voice snapshot');
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));
    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);

    const nextEditor = await screen.findByTestId('message-editor');
    expect(nextEditor.textContent).toBe('');
    expect(screen.queryByText('doNotSend')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-preview');
  });

  it('aborts a room-one voice upload and ignores a late success after switching rooms', async () => {
    installVoiceRecordingMocks();
    let resolveUpload!: (value: Message) => void;
    socketMocks.uploadMediaMessage.mockImplementationOnce(() => new Promise<Message>(resolve => {
      resolveUpload = resolve;
    }));
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'must stay in room one');
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));
    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1));
    const signal = socketMocks.uploadMediaMessage.mock.calls[0][0].signal as AbortSignal;

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolveUpload(message({ id: 'late-room-one-voice' })));

    expect((await screen.findByTestId('message-editor')).textContent).toBe('');
    expect(screen.queryByText('must stay in room one')).toBeNull();
    expect(rendered.props.onCancelReply).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('aborts an in-flight voice upload when the same room session becomes unverified', async () => {
    installVoiceRecordingMocks();
    let resolveUpload!: (value: Message) => void;
    socketMocks.uploadMediaMessage.mockImplementationOnce(() => new Promise<Message>(resolve => {
      resolveUpload = resolve;
    }));
    const rendered = renderMessageInput({ isRoomSessionReady: true });
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));
    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1));
    const signal = socketMocks.uploadMediaMessage.mock.calls[0][0].signal as AbortSignal;

    rendered.rerender(
      <MessageInput {...rendered.props} isRoomSessionReady={false} />
    );

    expect(signal.aborted).toBe(true);
    await act(async () => resolveUpload(message({ id: 'late-session-voice' })));
    expect(screen.getByText('doNotSend')).toBeTruthy();
    expect(rendered.props.onCancelReply).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels and generation-guards a pending editor restore frame across rooms', async () => {
    let nextFrameId = 1;
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.fn((frameId: number) => {
      frameCallbacks.delete(frameId);
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    installVoiceRecordingMocks();
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'room-one private snapshot');
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));
    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());
    fireEvent.click(screen.getByText('doNotSend'));
    await waitFor(() => expect(requestFrame).toHaveBeenCalledTimes(1));
    const staleFrame = requestFrame.mock.calls[0][0];

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    expect(cancelFrame).toHaveBeenCalledWith(1);
    act(() => staleFrame(0));

    const nextEditor = await screen.findByTestId('message-editor');
    expect(nextEditor.textContent).toBe('');
    expect(screen.queryByText('room-one private snapshot')).toBeNull();
  });

  it('ignores a late room-one voice upload failure after switching rooms', async () => {
    installVoiceRecordingMocks();
    let rejectUpload!: (error: Error) => void;
    socketMocks.uploadMediaMessage.mockImplementationOnce(() => new Promise<Message>((_resolve, reject) => {
      rejectUpload = reject;
    }));
    const rendered = renderMessageInput();
    setEditorText(rendered.editor, 'old room failure snapshot');
    fireEvent.click(screen.getByLabelText('voiceInput'));
    fireEvent.click(screen.getByText('recordVoice'));
    await waitFor(() => expect(screen.getByText('stopRecording')).toBeTruthy());
    fireEvent.click(screen.getByText('stopRecording'));
    await waitFor(() => expect(screen.getByText('doNotSend')).toBeTruthy());
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1));

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await act(async () => rejectUpload(new Error('late room-one upload failure')));

    expect((await screen.findByTestId('message-editor')).textContent).toBe('');
    expect(rendered.props.onCancelReply).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks picker and inline stickers while posting or AI input is locked', async () => {
    stickerMocks.suggestions = [{ id: 'sticker-wave', keywords: ['wave'], url: '/wave.webp' }];
    const rendered = renderMessageInput({ canPost: false });

    expect(screen.queryByLabelText('wave')).toBeNull();
    fireEvent.click(screen.getByText('picker-sticker'));
    expect(socketMocks.sendSticker).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('postingClosed');

    rendered.rerender(
      <MessageInput
        {...rendered.props}
        canPost={true}
        isRoomAIProcessing={true}
      />
    );
    fireEvent.click(screen.getByText('picker-sticker'));
    expect(socketMocks.sendSticker).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('wave')).toBeNull();
  });

  it('does not apply a late sticker success to the next room', async () => {
    let resolveSticker!: (value: Message) => void;
    socketMocks.sendSticker.mockImplementationOnce(() => new Promise<Message>(resolve => {
      resolveSticker = resolve;
    }));
    const rendered = renderMessageInput();
    fireEvent.click(screen.getByText('picker-sticker'));
    await waitFor(() => expect(socketMocks.sendSticker).toHaveBeenCalledTimes(1));
    expect(rendered.props.onOptimisticMessage).toHaveBeenCalledTimes(1);

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await act(async () => resolveSticker(message({ id: 'late-sticker', messageType: 'sticker' })));

    expect(rendered.props.onOptimisticMessageSaved).not.toHaveBeenCalled();
    expect(rendered.props.onCancelReply).not.toHaveBeenCalled();
  });

  it('does not apply a late sticker failure to the next room', async () => {
    let rejectSticker!: (error: Error) => void;
    socketMocks.sendSticker.mockImplementationOnce(() => new Promise<Message>((_resolve, reject) => {
      rejectSticker = reject;
    }));
    const rendered = renderMessageInput();
    fireEvent.click(screen.getByText('picker-sticker'));
    await waitFor(() => expect(socketMocks.sendSticker).toHaveBeenCalledTimes(1));

    rendered.rerender(<MessageInput {...rendered.props} roomId="room-2" />);
    await act(async () => rejectSticker(new Error('late sticker failure')));

    expect(rendered.props.onOptimisticMessageFailed).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
