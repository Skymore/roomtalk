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
}));

vi.mock('../utils/socket', () => socketMocks);

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

describe('MessageInput optimistic send flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMocks.requestAIResponse.mockResolvedValue(undefined);
    socketMocks.sendMessage.mockResolvedValue(message());
    socketMocks.sendMessageAndAskAI.mockResolvedValue({
      userMessage: message(),
      aiMessageId: 'ai-message-1',
    });
  });

  afterEach(() => {
    cleanup();
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
});
