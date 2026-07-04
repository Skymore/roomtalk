import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCodexDeviceAuth,
  disconnectCodexConnection,
  getCodexConnectionStatus,
  startCodexDeviceAuth,
} from './codexConnection';

describe('Codex connection API helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('loads public connection status with client auth headers', async () => {
    localStorage.setItem('clientAuthToken', 'token-1');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        clientId: 'client-1',
        provider: 'codex',
        status: 'connected',
        authVersion: 1,
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
        locked: false,
      }),
    })));

    await expect(getCodexConnectionStatus('client-1')).resolves.toMatchObject({
      clientId: 'client-1',
      status: 'connected',
    });

    expect(fetch).toHaveBeenCalledWith('/api/codex/connection', {
      cache: 'no-store',
      headers: {
        'X-Client-Id': 'client-1',
        'X-Client-Auth-Token': 'token-1',
      },
    });
  });

  it('starts device auth with a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        clientId: 'client-1',
        provider: 'codex',
        status: 'pending',
        deviceAuth: {
          url: 'https://auth.openai.com/codex/device',
          code: 'ABCD-EFGH',
          expiresAt: '2026-07-04T00:15:00.000Z',
        },
      }),
    })));

    await expect(startCodexDeviceAuth('client-1')).resolves.toMatchObject({
      status: 'pending',
      deviceAuth: { code: 'ABCD-EFGH' },
    });

    expect(fetch).toHaveBeenCalledWith('/api/codex/connection/device-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': 'client-1',
      },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
  });

  it('disconnects Codex and parses API errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Codex device auth failed' }),
    })));

    await expect(disconnectCodexConnection('client-1')).rejects.toThrow('Codex device auth failed');
  });

  it('cancels pending device auth with client auth headers', async () => {
    localStorage.setItem('clientAuthToken', 'token-1');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
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
      }),
    })));

    await expect(cancelCodexDeviceAuth('client-1')).resolves.toMatchObject({
      cancelled: true,
      status: { status: 'disconnected' },
    });

    expect(fetch).toHaveBeenCalledWith('/api/codex/connection/device-auth', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': 'client-1',
        'X-Client-Auth-Token': 'token-1',
      },
      body: JSON.stringify({ clientId: 'client-1' }),
    });
  });
});
