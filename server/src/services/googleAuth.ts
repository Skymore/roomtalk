import { OAuth2Client } from 'google-auth-library';
import { GoogleAccountProfile } from '../repositories/store';

export const resolveGoogleClientIds = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const values = [
    env.GOOGLE_CLIENT_ID,
    ...(env.GOOGLE_CLIENT_IDS || '').split(','),
  ];
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
};

export type VerifyGoogleCredentialResult =
  | { ok: true; profile: GoogleAccountProfile }
  | { ok: false; error: string; status: number };

export const verifyGoogleCredential = async (
  credential: string,
  clientIds: string[],
  oauthClient = new OAuth2Client(),
): Promise<VerifyGoogleCredentialResult> => {
  if (!clientIds.length) {
    return { ok: false, status: 503, error: 'Google login is not configured' };
  }

  if (!credential || typeof credential !== 'string') {
    return { ok: false, status: 400, error: 'Google credential is required' };
  }

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: credential,
      audience: clientIds,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      return { ok: false, status: 401, error: 'Invalid Google credential' };
    }
    const emailVerified = payload.email_verified as boolean | undefined;
    if (emailVerified === false) {
      return { ok: false, status: 401, error: 'Google email is not verified' };
    }

    return {
      ok: true,
      profile: {
        providerSubject: payload.sub,
        email: payload.email,
        emailVerified: emailVerified ?? true,
        displayName: payload.name,
        avatarUrl: payload.picture,
      },
    };
  } catch {
    return { ok: false, status: 401, error: 'Invalid Google credential' };
  }
};
