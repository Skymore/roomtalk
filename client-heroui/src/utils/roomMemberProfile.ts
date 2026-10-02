import {
  apiPath,
  getClientAuthToken,
  getCurrentClientId,
  withClientAuthBody,
} from './socket';

const memberProfileHeaders = () => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Id': getCurrentClientId(),
  };
  const token = getClientAuthToken();
  if (token) headers['X-Client-Auth-Token'] = token;
  return headers;
};

export const getRoomNickname = async (roomId: string): Promise<string> => {
  const response = await fetch(apiPath(`/api/rooms/${encodeURIComponent(roomId)}/member-profile`), {
    cache: 'no-store',
    headers: memberProfileHeaders(),
  });
  if (!response.ok) {
    throw new Error('Failed to load room nickname');
  }
  const result = await response.json() as { nickname?: unknown };
  return typeof result.nickname === 'string' ? result.nickname : '';
};

export const setRoomNickname = async (roomId: string, nickname: string): Promise<string> => {
  const response = await fetch(apiPath(`/api/rooms/${encodeURIComponent(roomId)}/member-profile`), {
    method: 'PUT',
    headers: memberProfileHeaders(),
    body: JSON.stringify(withClientAuthBody({
      clientId: getCurrentClientId(),
      nickname,
    })),
  });
  if (!response.ok) {
    throw new Error('Failed to update room nickname');
  }
  const result = await response.json() as { nickname?: unknown };
  return typeof result.nickname === 'string' ? result.nickname : '';
};
