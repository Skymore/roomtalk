// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../utils/types';
import { MessageInput } from './MessageInput';

const socketMocks = vi.hoisted(() => ({
  requestAIResponse: vi.fn(),
  sendMessage: vi.fn(),
  sendMessageAndAskAI: vi.fn(),
  uploadMediaMessage: vi.fn(),
}));

vi.mock('../utils/socket', () => socketMocks);

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
  useDisclosure: () => ({
    isOpen: false,
    onOpen: vi.fn(),
    onClose: vi.fn(),
  }),
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
  MessageInputAIControls: ({ onAskAI, onSend }: any) => (
    <div>
      <button type="button" onClick={onAskAI}>ask-ai</button>
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
};

describe('MessageInput optimistic send flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMocks.requestAIResponse.mockResolvedValue(undefined);
    socketMocks.sendMessage.mockResolvedValue(message());
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: message(),
      aiMessageId: 'ai-message-1',
      aiStarted: true,
    });
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
  });

  afterEach(() => {
    cleanup();
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

  it('uploads arbitrary files from the file picker', async () => {
    renderMessageInput();
    const file = new File(['# notes'], 'notes.md', { type: 'text/markdown' });

    fireEvent.change(screen.getByTestId('file-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1);
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[0][0]).toMatchObject({
      file,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      filename: 'notes.md',
      username: 'Ada',
      avatar: { text: 'A', color: '#123456' },
      replyToMessageId: undefined,
    });
  });

  it('uploads multiple arbitrary picker files as file attachments', async () => {
    renderMessageInput();
    const textFile = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    const movFile = new File(['mov'], 'IMG_0135.mov', { type: 'video/quicktime' });

    fireEvent.change(screen.getByTestId('file-upload-input'), {
      target: { files: [textFile, movFile] },
    });

    await waitFor(() => {
      expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(2);
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[0][0]).toMatchObject({
      file: textFile,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'text/markdown',
      filename: 'notes.md',
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[1][0]).toMatchObject({
      file: movFile,
      roomId: 'room-1',
      kind: 'file',
      mimeType: 'video/quicktime',
      filename: 'IMG_0135.mov',
    });
    expect((screen.getByTestId('file-upload-input') as HTMLInputElement).multiple).toBe(true);
  });

  it('uploads extension-only MOV selections from the media picker as videos', async () => {
    renderMessageInput();
    const file = new File(['mov'], 'IMG_0135.mov');

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1);
    });
    expect(socketMocks.uploadMediaMessage.mock.calls[0][0]).toMatchObject({
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

  it('keeps image drafts visible when media upload fails', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:image-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    socketMocks.uploadMediaMessage.mockRejectedValue(new Error('upload failed'));

    const { editor } = renderMessageInput();
    const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });

    fireEvent.change(screen.getByTestId('image-upload-input'), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(editor.querySelectorAll('img')).toHaveLength(1);
    });

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => {
      expect(socketMocks.uploadMediaMessage).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/errorSendingMessage/)).toBeTruthy();
    });

    expect(editor.querySelectorAll('img')).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:image-preview');
  });
});
