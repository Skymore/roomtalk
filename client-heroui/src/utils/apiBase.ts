// Base URL + path helper for HTTP calls. Kept separate from socket.ts so modules
// that only need URL resolution (e.g. the sticker catalog) don't pull in — or get
// broken by test mocks of — the socket client.

export const API_BASE_URL = (import.meta.env.VITE_SOCKET_URL || '').replace(/\/$/, '');

export const apiPath = (path: string) =>
  (/^[a-z][a-z\d+\-.]*:\/\//i.test(path) ? path : `${API_BASE_URL}${path}`);
