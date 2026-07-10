// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './SettingsView';

const codexApiMock = vi.hoisted(() => ({
  getCodexConnectionStatus: vi.fn(),
  startCodexDeviceAuth: vi.fn(),
  cancelCodexDeviceAuth: vi.fn(),
  disconnectCodexConnection: vi.fn(),
}));
const githubApiMock = vi.hoisted(() => ({
  getGitHubConnectionStatus: vi.fn(),
  connectGitHub: vi.fn(),
  disconnectGitHub: vi.fn(),
}));
const i18nMock = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: i18nMock.t,
  }),
}));

vi.mock('../utils/socket', () => ({
  getClientAuthStatus: vi.fn(async (clientId: string) => ({ clientId, hasPassword: false })),
  getClientAccountStatus: vi.fn(async (clientId: string) => ({
    clientId,
    hasPassword: false,
    googleConfigured: false,
    account: null,
  })),
  loginWithClientPassword: vi.fn(),
  loginWithGoogleCredential: vi.fn(),
  setClientPassword: vi.fn(),
}));

vi.mock('../utils/pushNotifications', () => ({
  getPushNotificationStatus: vi.fn(async () => 'server-disabled'),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn(),
}));

vi.mock('../utils/codexConnection', () => codexApiMock);
vi.mock('../utils/githubConnection', () => githubApiMock);

const baseProps = {
  clientId: 'client-1',
  username: 'Ada',
  setUsername: vi.fn(),
  showEditUsername: false,
  setShowEditUsername: vi.fn(),
  handleSaveUsername: vi.fn(),
  handleCopyToClipboard: vi.fn(),
  isDark: false,
  setTheme: vi.fn(),
  i18n: { language: 'en' },
  changeLanguage: vi.fn(),
};

describe('SettingsView Codex connection controls', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('open', vi.fn());
    codexApiMock.getCodexConnectionStatus.mockResolvedValue({
      clientId: 'client-1',
      provider: 'codex',
      status: 'disconnected',
      authVersion: 0,
      createdAt: '',
      updatedAt: '',
      locked: false,
    });
    codexApiMock.startCodexDeviceAuth.mockResolvedValue({
      clientId: 'client-1',
      provider: 'codex',
      status: 'pending',
      deviceAuth: {
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-EFGH',
        expiresAt: '2026-07-04T00:15:00.000Z',
      },
    });
    codexApiMock.cancelCodexDeviceAuth.mockResolvedValue({
      clientId: 'client-1',
      provider: 'codex',
      cancelled: true,
      status: {
        clientId: 'client-1',
        provider: 'codex',
        status: 'disconnected',
        authVersion: 0,
        createdAt: '',
        updatedAt: '',
        locked: false,
      },
    });
    githubApiMock.getGitHubConnectionStatus.mockResolvedValue({
      clientId: 'client-1',
      provider: 'github',
      status: 'disconnected',
      authVersion: 0,
      createdAt: '',
      updatedAt: '',
    });
    githubApiMock.connectGitHub.mockResolvedValue({
      clientId: 'client-1',
      provider: 'github',
      status: 'connected',
      authVersion: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      account: { id: 42, login: 'ada' },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hides Codex controls when the feature is disabled', () => {
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled={false} />);

    expect(screen.queryByText('codexConnection')).toBeNull();
  });

  it('connects GitHub with a PAT and clears the token field', async () => {
    render(<SettingsView {...baseProps} isGitHubConnectionsEnabled />);

    const tokenInput = await screen.findByLabelText('githubToken');
    fireEvent.change(tokenInput, { target: { value: 'github_pat_test_secret_value' } });
    fireEvent.click(screen.getByRole('button', { name: 'connectGitHub' }));

    await waitFor(() => expect(githubApiMock.connectGitHub).toHaveBeenCalledWith(
      'client-1',
      'github_pat_test_secret_value'
    ));
    expect(await screen.findByText('@ada')).toBeTruthy();
    expect(screen.queryByLabelText('githubToken')).toBeNull();
  });

  it('starts device auth and renders the login code', async () => {
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'connectCodex' }));

    await waitFor(() => expect(codexApiMock.startCodexDeviceAuth).toHaveBeenCalledWith('client-1'));
    expect((await screen.findAllByText('ABCD-EFGH')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('codexDeviceCodeInstruction')).length).toBeGreaterThan(0);
    expect(screen.getByText('codexLoginTitle')).toBeTruthy();
    expect(window.open).toHaveBeenCalledWith('https://auth.openai.com/codex/device', '_blank', 'noopener,noreferrer');
  });

  it('announces successful settings results once without an explicit live override', async () => {
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'connectCodex' }));
    await screen.findByText('codexLoginTitle');
    fireEvent.click(screen.getAllByRole('button', { name: 'cancelCodexLogin' })[0]);

    const result = await screen.findByRole('status');
    expect(result.textContent).toBe('codexConnectionCancelled');
    expect(result.getAttribute('aria-atomic')).toBe('true');
    expect(result.hasAttribute('aria-live')).toBe(false);
  });

  it('announces settings errors once without an explicit live override', async () => {
    codexApiMock.startCodexDeviceAuth.mockRejectedValueOnce(new Error('codex failed'));
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'connectCodex' }));

    const result = await screen.findByRole('alert');
    expect(result.textContent).toBe('codex failed');
    expect(result.getAttribute('aria-atomic')).toBe('true');
    expect(result.hasAttribute('aria-live')).toBe(false);
  });

  it('shows the connected Codex account summary', async () => {
    codexApiMock.getCodexConnectionStatus.mockResolvedValueOnce({
      clientId: 'client-1',
      provider: 'codex',
      status: 'connected',
      authVersion: 1,
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
      locked: false,
      account: {
        email: 'ada@example.com',
        planType: 'pro',
      },
    });

    render(<SettingsView {...baseProps} isCodexConnectionsEnabled />);

    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(document.body.textContent).toContain('Pro');
    expect(screen.getByText('codexSignedInAs')).toBeTruthy();
  });

  it('cancels a pending Codex device auth session', async () => {
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled />);

    fireEvent.click(await screen.findByRole('button', { name: 'connectCodex' }));
    await screen.findByText('codexLoginTitle');
    fireEvent.click(screen.getAllByRole('button', { name: 'cancelCodexLogin' })[0]);

    await waitFor(() => expect(codexApiMock.cancelCodexDeviceAuth).toHaveBeenCalledWith('client-1'));
    expect(await screen.findByText('codexConnectionCancelled')).toBeTruthy();
  });

  it('labels the username editor from the visible settings label', () => {
    render(<SettingsView {...baseProps} showEditUsername />);

    expect(screen.getByRole('textbox', { name: 'username' })).toBeTruthy();
  });

  it('uses compact, collapsed account guidance', () => {
    render(<SettingsView {...baseProps} />);

    const googleHelp = screen.getByText('googleAccountIntroTitle').closest('details') as HTMLDetailsElement;
    const userIdHelp = screen.getByText('userIdLoginIntroTitle').closest('details') as HTMLDetailsElement;

    expect(googleHelp.open).toBe(false);
    expect(userIdHelp.open).toBe(false);
  });

  it('places high-frequency preferences before account login forms', () => {
    render(<SettingsView {...baseProps} />);

    const language = screen.getByText('language');
    const appearance = screen.getByText('appearance');
    const googleAccount = screen.getByText('googleAccount');
    const userIdLogin = screen.getByText('userIdLogin');
    const appearsBefore = (first: Element, second: Element) => Boolean(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    );

    expect(appearsBefore(language, googleAccount)).toBe(true);
    expect(appearsBefore(appearance, googleAccount)).toBe(true);
    expect(appearsBefore(language, userIdLogin)).toBe(true);
    expect(appearsBefore(appearance, userIdLogin)).toBe(true);
  });

  it('enables identity actions only when their basic local requirements are met', async () => {
    render(<SettingsView {...baseProps} />);

    const passwordButton = await screen.findByRole('button', { name: 'setUserIdPassword' }) as HTMLButtonElement;
    const passwordInput = document.querySelector<HTMLInputElement>('input[autocomplete="new-password"]');
    const existingIdInput = screen.getByRole('textbox', { name: 'existingUserId' });
    const loginPasswordInput = document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]');
    const loginButton = screen.getByRole('button', { name: 'useExistingUserId' }) as HTMLButtonElement;

    expect(passwordInput).toBeTruthy();
    expect(loginPasswordInput).toBeTruthy();
    passwordInput!.type = 'text';
    loginPasswordInput!.type = 'text';
    expect(screen.getAllByRole('textbox', { name: 'userIdPassword' })).toEqual(
      expect.arrayContaining([passwordInput, loginPasswordInput]),
    );
    expect(passwordButton.disabled).toBe(true);
    expect(loginButton.disabled).toBe(true);

    fireEvent.change(passwordInput!, { target: { value: 'short' } });
    expect(passwordButton.disabled).toBe(true);
    fireEvent.change(passwordInput!, { target: { value: '12345678' } });
    expect(passwordButton.disabled).toBe(false);

    fireEvent.change(existingIdInput, { target: { value: 'client-2' } });
    expect(loginButton.disabled).toBe(true);
    fireEvent.change(loginPasswordInput!, { target: { value: 'password' } });
    expect(loginButton.disabled).toBe(false);
  });
});
