import { SocketConnectionContext } from './types';

const ASSEMBLYAI_TOKEN_ENDPOINT = 'https://streaming.assemblyai.com/v3/token';
// Token redemption window. The browser must open the streaming WebSocket within
// this many seconds of receiving the token (AssemblyAI allows 1-600).
const TOKEN_EXPIRES_IN_SECONDS = 300;

/**
 * Mints short-lived AssemblyAI streaming tokens so the browser can connect
 * directly to the realtime transcription WebSocket without ever seeing the
 * account API key. The key stays server-side; only a 5-minute token is exposed.
 */
export function registerTranscriptionHandlers({ socket, store, socketLogger, assemblyAIApiKey, resolveClientId }: SocketConnectionContext) {
  const resolveAckCallback = (
    payloadOrCallback?: unknown,
    maybeCallback?: unknown,
  ): ((response: { success: boolean; token?: string; expiresInSeconds?: number; error?: string }) => void) | undefined => {
    if (typeof payloadOrCallback === 'function') {
      return payloadOrCallback as (response: { success: boolean; token?: string; expiresInSeconds?: number; error?: string }) => void;
    }
    if (typeof maybeCallback === 'function') {
      return maybeCallback as (response: { success: boolean; token?: string; expiresInSeconds?: number; error?: string }) => void;
    }
    return undefined;
  };

  socket.on('create_transcription_token', async (
    payloadOrCallback?: unknown,
    maybeCallback?: unknown,
  ) => {
    const callback = resolveAckCallback(payloadOrCallback, maybeCallback);

    if (!assemblyAIApiKey) {
      callback?.({ success: false, error: 'Transcription is not configured' });
      return;
    }

    const clientId = await resolveClientId();
    if (!clientId) {
      callback?.({ success: false, error: 'You are not registered' });
      return;
    }

    try {
      const params = new URLSearchParams({ expires_in_seconds: String(TOKEN_EXPIRES_IN_SECONDS) });
      const response = await fetch(`${ASSEMBLYAI_TOKEN_ENDPOINT}?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: assemblyAIApiKey },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        socketLogger.error('Failed to mint AssemblyAI streaming token', { status: response.status, body, clientId });
        callback?.({ success: false, error: 'Failed to create transcription token' });
        return;
      }

      const data = await response.json() as { token?: string; expires_in_seconds?: number };
      if (!data.token) {
        socketLogger.error('AssemblyAI token response missing token', { clientId });
        callback?.({ success: false, error: 'Failed to create transcription token' });
        return;
      }

      callback?.({ success: true, token: data.token, expiresInSeconds: data.expires_in_seconds });
    } catch (error) {
      socketLogger.error('Error creating AssemblyAI streaming token', { error, clientId });
      callback?.({ success: false, error: 'Failed to create transcription token' });
    }
  });
}
