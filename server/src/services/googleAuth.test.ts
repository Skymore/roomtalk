import assert from 'assert/strict';
import { describe, it } from 'node:test';
import { resolveGoogleClientIds, verifyGoogleCredential } from './googleAuth';

const oauthClient = (payload: Record<string, unknown>, capture?: { request?: unknown }) => ({
  async verifyIdToken(request: unknown) {
    if (capture) {
      capture.request = request;
    }
    return {
      getPayload() {
        return payload;
      },
    };
  },
});

describe('google auth service', () => {
  it('resolves unique configured Google client IDs', () => {
    assert.deepEqual(resolveGoogleClientIds({
      GOOGLE_CLIENT_ID: ' client-1 ',
      GOOGLE_CLIENT_IDS: 'client-2, client-1,',
    } as NodeJS.ProcessEnv), ['client-1', 'client-2']);
  });

  it('rejects Google credentials when the server is not configured or the credential is missing', async () => {
    assert.deepEqual(await verifyGoogleCredential('token', [], oauthClient({}) as any), {
      ok: false,
      status: 503,
      error: 'Google login is not configured',
    });
    assert.deepEqual(await verifyGoogleCredential('', ['client-1'], oauthClient({}) as any), {
      ok: false,
      status: 400,
      error: 'Google credential is required',
    });
  });

  it('verifies Google ID tokens and maps the profile', async () => {
    const capture: { request?: unknown } = {};
    const result = await verifyGoogleCredential('id-token', ['client-1'], oauthClient({
      sub: 'google-subject-1',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada Lovelace',
      picture: 'https://example.com/ada.png',
    }, capture) as any);

    assert.deepEqual(capture.request, { idToken: 'id-token', audience: ['client-1'] });
    assert.deepEqual(result, {
      ok: true,
      profile: {
        providerSubject: 'google-subject-1',
        email: 'ada@example.com',
        emailVerified: true,
        displayName: 'Ada Lovelace',
        avatarUrl: 'https://example.com/ada.png',
      },
    });
  });

  it('rejects invalid or unverified Google payloads', async () => {
    assert.deepEqual(await verifyGoogleCredential('id-token', ['client-1'], oauthClient({}) as any), {
      ok: false,
      status: 401,
      error: 'Invalid Google credential',
    });
    assert.deepEqual(await verifyGoogleCredential('id-token', ['client-1'], oauthClient({
      sub: 'google-subject-1',
      email_verified: false,
    }) as any), {
      ok: false,
      status: 401,
      error: 'Google email is not verified',
    });
  });

  it('returns invalid credential when Google verification throws', async () => {
    const throwingClient = {
      async verifyIdToken() {
        throw new Error('bad token');
      },
    };

    assert.deepEqual(await verifyGoogleCredential('id-token', ['client-1'], throwingClient as any), {
      ok: false,
      status: 401,
      error: 'Invalid Google credential',
    });
  });
});
