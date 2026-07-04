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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hides Codex controls when the feature is disabled', () => {
    render(<SettingsView {...baseProps} isCodexConnectionsEnabled={false} />);

    expect(screen.queryByText('codexConnection')).toBeNull();
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
});
