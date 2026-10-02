// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({
  apiPath: (path: string) => path,
  getClientAuthToken: () => 'auth-token-1',
  getCurrentClientId: () => 'client-1',
  withClientAuthBody: (body: Record<string, unknown>) => ({ ...body, clientAuthToken: 'auth-token-1' }),
}));

describe('room member profile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the current room nickname', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: 'room/1', nickname: '小狐' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getRoomNickname } = await import('./roomMemberProfile');
    await expect(getRoomNickname('room/1')).resolves.toBe('小狐');
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room%2F1/member-profile', {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': 'client-1',
        'X-Client-Auth-Token': 'auth-token-1',
      },
    });
  });

  it('updates or clears the current room nickname', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: 'room-1', nickname: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { setRoomNickname } = await import('./roomMemberProfile');
    await expect(setRoomNickname('room-1', '')).resolves.toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1/member-profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': 'client-1',
        'X-Client-Auth-Token': 'auth-token-1',
      },
      body: JSON.stringify({ clientId: 'client-1', nickname: '', clientAuthToken: 'auth-token-1' }),
    });
  });
});
