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
  Select: ({ children, 'aria-label': ariaLabel, onSelectionChange, isDisabled, ...props }: any) => {
    const nextKeyByLabel: Record<string, string> = {
      codeAgentModeControl: 'edit',
      selectCodexPermission: 'fullAccess',
      selectCodexModel: 'gpt-5.6-sol',
      selectCodexReasoning: 'xhigh',
      selectCodexSpeed: 'priority',
    };
    return (
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
          onClick={() => onSelectionChange?.(new Set([nextKeyByLabel[ariaLabel] || 'edit']))}
        >
          change
        </button>
      </div>
    );
  },
  SelectItem: ({ children }: any) => <div>{children}</div>,
  Tab: ({ children, title }: any) => <div><span>{title}</span>{children}</div>,
  Tabs: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('./AIRoleManager', () => ({
  AIRoleManager: ({ onSelectRole }: { onSelectRole: (roleId: string) => void }) => (
    <div data-testid="ai-role-manager">
      <button type="button" onClick={() => onSelectRole('critic')}>select critic</button>
    </div>
  ),
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

const criticRole: AIRole = {
  id: 'critic',
  name: 'Critic',
  systemPrompt: 'Review carefully',
  icon: 'lucide:brain',
  color: 'secondary',
};

const model = {
  id: 'model-a',
  apiModel: 'provider/model-a',
  provider: 'openrouter' as const,
  label: 'Model A',
};

const baseProps = {
  roles: [role, criticRole],
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

  it('applies code agent mode changes from the settings modal', () => {
    const onCodeAgentModeChange = vi.fn();
    const onSettingsClose = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isSettingsOpen
        onSettingsClose={onSettingsClose}
        isCodeAgentRoom
        codeAgentMode="plan"
        codeAgentAvailableModes={['plan', 'edit']}
        onCodeAgentModeChange={onCodeAgentModeChange}
      />
    );

    expect(screen.getByTestId('code-agent-mode-select')).toBeTruthy();
    expect(screen.queryByLabelText('selectAIRole')).toBeNull();

    fireEvent.click(screen.getByTestId('change-codeAgentModeControl'));
    expect(onCodeAgentModeChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(onCodeAgentModeChange).toHaveBeenCalledWith('edit');
    expect(onSettingsClose).toHaveBeenCalled();
  });

  it('locks code agent mode selection when the current user cannot switch modes', () => {
    const onCodeAgentModeChange = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isSettingsOpen
        isCodeAgentRoom
        codeAgentMode="plan"
        codeAgentAvailableModes={['plan', 'edit']}
        canSwitchCodeAgentMode={false}
        onCodeAgentModeChange={onCodeAgentModeChange}
      />
    );

    expect(screen.getByTestId('code-agent-mode-select').dataset.disabled).toBe('true');

    fireEvent.click(screen.getByTestId('change-codeAgentModeControl'));
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));

    expect(onCodeAgentModeChange).not.toHaveBeenCalled();
  });

  it('applies Codex model and reasoning settings without showing the priced AI model picker', () => {
    const onCodexRunSettingsChange = vi.fn();
    const onSettingsClose = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isSettingsOpen
        onSettingsClose={onSettingsClose}
        isCodeAgentRoom
        codeAgentBackend="codex-app-server"
        codeAgentMode="approveForMe"
        codeAgentAvailableModes={['plan', 'edit', 'approveForMe', 'fullAccess']}
        codexRunSettings={{ model: 'gpt-5.5', reasoningEffort: 'medium', permissionMode: 'approveForMe', serviceTier: 'default' }}
        onCodexRunSettingsChange={onCodexRunSettingsChange}
      />
    );

    expect(screen.getByTestId('codex-model-select')).toBeTruthy();
    expect(screen.getByTestId('codex-reasoning-select')).toBeTruthy();
    expect(screen.getByTestId('codex-speed-select')).toBeTruthy();
    expect(screen.queryByTestId('ai-model-select')).toBeNull();

    fireEvent.click(screen.getByTestId('change-selectCodexModel'));
    fireEvent.click(screen.getByTestId('change-selectCodexReasoning'));
    fireEvent.click(screen.getByTestId('change-selectCodexSpeed'));
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));

    expect(onCodexRunSettingsChange).toHaveBeenCalledWith({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      permissionMode: 'approveForMe',
      serviceTier: 'priority',
    });
    expect(onSettingsClose).toHaveBeenCalled();
  });

  it('applies Codex permission changes through the code mode control', () => {
    const onCodexRunSettingsChange = vi.fn();
    const onCodeAgentModeChange = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isSettingsOpen
        isCodeAgentRoom
        codeAgentBackend="codex-app-server"
        codeAgentMode="approveForMe"
        codeAgentAvailableModes={['plan', 'edit', 'approveForMe', 'fullAccess']}
        codexRunSettings={{ model: 'gpt-5.5', reasoningEffort: 'xhigh', permissionMode: 'approveForMe', serviceTier: 'default' }}
        onCodexRunSettingsChange={onCodexRunSettingsChange}
        onCodeAgentModeChange={onCodeAgentModeChange}
      />
    );

    fireEvent.click(screen.getByTestId('change-selectCodexPermission'));
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));

    expect(onCodexRunSettingsChange).toHaveBeenCalledWith({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
      permissionMode: 'fullAccess',
      serviceTier: 'default',
    });
    expect(onCodeAgentModeChange).toHaveBeenCalledWith('fullAccess');
  });

  it('keeps Send as chat while the agent control switches between Stop and Queue', () => {
    const onAskAI = vi.fn();
    const onSend = vi.fn();
    const { rerender } = render(
      <MessageInputAIControls
        {...baseProps}
        isCodeAgentRoom
        isAgentRunning
        onAskAI={onAskAI}
        onSend={onSend}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'codeAgentStop' }));
    expect(onAskAI).toHaveBeenNthCalledWith(1, 'stop');
    expect((screen.getByRole('button', { name: 'send' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <MessageInputAIControls
        {...baseProps}
        isCodeAgentRoom
        isAgentRunning
        currentInputText="use Bing instead"
        onAskAI={onAskAI}
        onSend={onSend}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'codeAgentQueue' }));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(onAskAI).toHaveBeenNthCalledWith(2, 'queue');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not expose Stop while unsupported image content is waiting in the composer', () => {
    render(
      <MessageInputAIControls
        {...baseProps}
        isCodeAgentRoom
        isAgentRunning
        imageCount={1}
      />
    );

    expect(screen.getByRole('button', { name: 'codeAgentQueue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'codeAgentStop' })).toBeNull();
  });

  it('disables Apply until settings change', () => {
    render(<MessageInputAIControls {...baseProps} isSettingsOpen />);

    expect((screen.getByRole('button', { name: 'apply' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies role manager selection from the settings modal', () => {
    const onRoleChange = vi.fn();
    const onSettingsClose = vi.fn();
    render(
      <MessageInputAIControls
        {...baseProps}
        isSettingsOpen
        onRoleChange={onRoleChange}
        onSettingsClose={onSettingsClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'select critic' }));

    expect(onRoleChange).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'apply' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    expect(onRoleChange).toHaveBeenCalledWith('critic');
    expect(onSettingsClose).toHaveBeenCalled();
  });

  it('shows role picker in settings modal for chat rooms', () => {
    render(<MessageInputAIControls {...baseProps} isSettingsOpen />);

    expect(screen.getByLabelText('selectAIRole')).toBeTruthy();
    expect(screen.queryByTestId('code-agent-mode-select')).toBeNull();
  });
});
