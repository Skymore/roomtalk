// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageInputAIControls } from './MessageInputAIControls';
import type { AIRole } from '../utils/aiRoles';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, onClick, isDisabled, ...props }: any) => (
    <button type="button" onClick={onClick || onPress} disabled={isDisabled} {...props}>
      {children}
    </button>
  ),
  Input: ({ value, onChange, ...props }: any) => (
    <input value={value} onChange={onChange} {...props} />
  ),
  Modal: ({ children, isOpen }: any) => (isOpen ? <div>{children}</div> : null),
  ModalBody: ({ children }: any) => <div>{children}</div>,
  ModalContent: ({ children }: any) => <div>{children}</div>,
  ModalFooter: ({ children }: any) => <div>{children}</div>,
  ModalHeader: ({ children }: any) => <div>{children}</div>,
  Select: ({ children, 'aria-label': ariaLabel, onSelectionChange, isDisabled, ...props }: any) => (
    <div
      aria-label={ariaLabel}
      data-testid={props['data-testid'] || ariaLabel}
      data-disabled={String(Boolean(isDisabled))}
    >
      {children}
      <button
        type="button"
        data-testid={`change-${ariaLabel}`}
        disabled={isDisabled}
        onClick={() => onSelectionChange?.(new Set(['acceptEdits']))}
      >
        change
      </button>
    </div>
  ),
  SelectItem: ({ children }: any) => <div>{children}</div>,
  Tab: ({ children, title }: any) => <div><span>{title}</span>{children}</div>,
  Tabs: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('./AIRoleManager', () => ({
  AIRoleManager: () => <div data-testid="ai-role-manager">roles</div>,
}));

vi.mock('./HoverTooltip', () => ({
  HoverTooltip: ({ children }: any) => <>{children}</>,
}));

const role: AIRole = {
  id: 'assistant',
  name: 'Assistant',
  systemPrompt: 'You are helpful',
  icon: 'lucide:bot',
  color: 'primary',
};

const model = {
  id: 'model-a',
  apiModel: 'provider/model-a',
  provider: 'openrouter' as const,
  label: 'Model A',
};

const baseProps = {
  roles: [role],
  selectedRoleId: role.id,
  selectedRole: role,
  aiModels: [model],
  selectedAIModel: model.id,
  defaultAIModel: model.id,
  isSending: false,
  isAiProcessing: false,
  canPost: true,
  isMacOS: true,
  currentInputText: '',
  imageCount: 0,
  aiContextMessageLimit: 100,
  isSettingsOpen: false,
  onSettingsClose: vi.fn(),
  onRoleChange: vi.fn(),
  onModelChange: vi.fn(),
  onAIContextMessageLimitChange: vi.fn(),
  onAddRole: vi.fn(),
  onUpdateRole: vi.fn(),
  onDeleteRole: vi.fn(),
  onAskAI: vi.fn(),
  onSend: vi.fn(),
};

describe('MessageInputAIControls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('replaces the ordinary role picker with a Coco run-mode picker', () => {
    const onCodeAgentModeChange = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isCodeAgentRoom
        codeAgentMode="plan"
        codeAgentMaxMode="acceptEdits"
        onCodeAgentModeChange={onCodeAgentModeChange}
      />
    );

    expect(screen.getByTestId('code-agent-mode-select')).toBeTruthy();
    expect(screen.queryByLabelText('selectAIRole')).toBeNull();
    expect(screen.queryByText('Assistant')).toBeNull();

    fireEvent.click(screen.getByTestId('change-selectCodeAgentMode'));
    expect(onCodeAgentModeChange).toHaveBeenCalledWith('acceptEdits');
  });

  it('keeps the ordinary role picker for chat rooms', () => {
    render(<MessageInputAIControls {...baseProps} />);

    expect(screen.getByLabelText('selectAIRole')).toBeTruthy();
    expect(screen.queryByTestId('code-agent-mode-select')).toBeNull();
  });
});
