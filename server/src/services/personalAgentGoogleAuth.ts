// OAuth flow ported from OpenMuse google-auth.ts; original MIT notice in personalAgentGoogleTypes.ts.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'openmuse-zod';
import { RoomStore } from '../repositories/store';
import { CodexAuthCipher } from './codexConnection';
import { PersonalGoogleCredential } from './personalAgentGoogleTypes';

export class PersonalGoogleError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface PersonalGoogleConfig {
  clientId?: string; clientSecret?: string; encryptionKey?: string; redirectUri?: string;
}
interface Tokens {
  connectionId: string; accessToken: string; refreshToken?: string;
  expiresAt: number; scopes: string[]; account: string;
}
const tokenSchema = z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),expires_in:z.number(),scope:z.string().optional()});
export class PersonalAgentGoogleAuth {
  private readonly refreshing = new Map<string,Promise<string>>();
  private readonly cipher?: CodexAuthCipher;
  constructor(private readonly store: RoomStore, private readonly config: PersonalGoogleConfig, private readonly fetcher = fetch) {
    if (config.encryptionKey) this.cipher = new CodexAuthCipher(config.encryptionKey);
  }
  configured() { return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri && this.cipher); }
  private decode(stored: PersonalGoogleCredential | null): Tokens | null {
    if (!stored?.secret) return null;
    if (!this.cipher) throw new PersonalGoogleError('Google token encryption is not configured',503);
    return JSON.parse(this.cipher.decryptAuthJson(stored.secret));
  }
  async tokens(clientId: string) { return this.decode(await this.store.readPersonalGoogleCredential!(clientId)); }
  async status(clientId: string) {
    const tokens = await this.tokens(clientId);
    return {configured:this.configured(),connected:Boolean(tokens),account:tokens?.account,
      canSend:tokens?.scopes.includes('https://www.googleapis.com/auth/gmail.send') ?? false,
      canEditCalendar:tokens?.scopes.includes('https://www.googleapis.com/auth/calendar.events') ?? false};
  }
  async connect(clientId: string, write: boolean) {
    if (!this.configured()) throw new PersonalGoogleError('Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and CODEX_AUTH_ENCRYPTION_KEY to connect Google',503);
    const id = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), generation = randomUUID();
    const existing = this.decode(await this.store.rotatePersonalGoogleCredential!(clientId,generation,false));
    const scopes = Array.from(new Set([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ...(existing?.scopes ?? []),
      ...(write ? ['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events'] : []),
    ]));
    await this.store.savePersonalGoogleOAuthState!({id,clientId,generation,verifier,scopes,expiresAt:Date.now()+600000});
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({client_id:this.config.clientId!,redirect_uri:this.config.redirectUri!,response_type:'code',
      scope:scopes.join(' '),state:id,access_type:'offline',prompt:'consent',include_granted_scopes:'true',
      code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
    return {url:url.toString()};
  }
  private async tokenRequest(body: Record<string,string>, status: number) {
    const response = await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
        client_id:this.config.clientId!,client_secret:this.config.clientSecret!,...body}),signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new PersonalGoogleError('Google sign-in expired or failed. Connect again.',status);
    return tokenSchema.parse(await response.json());
  }
  async callback(stateId: string, code: string) {
    const state = await this.store.takePersonalGoogleOAuthState!(stateId);
    if (!state || state.expiresAt < Date.now()) throw new PersonalGoogleError('Google sign-in expired. Connect again.',400);
    const credential = await this.store.readPersonalGoogleCredential!(state.clientId);
    if (credential?.generation !== state.generation) throw new PersonalGoogleError('Google connection changed. Connect again.',409);
    const token = await this.tokenRequest({redirect_uri:this.config.redirectUri!,grant_type:'authorization_code',code,code_verifier:state.verifier},502);
    const profile = await this.fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile',{
      headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});
    if (!profile.ok) throw new PersonalGoogleError('Google did not grant Gmail read access. Connect again.',403);
    const {emailAddress} = z.object({emailAddress:z.email()}).parse(await profile.json());
    const previous = await this.tokens(state.clientId);
    const tokens: Tokens = {connectionId:randomUUID(),accessToken:token.access_token,
      refreshToken:token.refresh_token ?? (previous?.account === emailAddress ? previous.refreshToken : undefined),
      expiresAt:Date.now()+token.expires_in*1000,scopes:token.scope?.split(' ') ?? state.scopes,account:emailAddress};
    const saved = await this.store.savePersonalGoogleCredential!({clientId:state.clientId,generation:randomUUID(),
      connectionId:tokens.connectionId,secret:this.cipher!.encryptAuthJson(JSON.stringify(tokens))},state.generation);
    if (!saved) throw new PersonalGoogleError('Google was disconnected during sign-in. Connect again.',409);
  }
  async accessToken(clientId: string, expectedConnectionId?: string): Promise<string> {
    const tokens = await this.tokens(clientId);
    if (!tokens) throw new PersonalGoogleError('Google is disconnected',409);
    if (expectedConnectionId && tokens.connectionId !== expectedConnectionId) throw new PersonalGoogleError('Google account changed. Prepare a new action.',409);
    if (tokens.expiresAt > Date.now()+60000) return tokens.accessToken;
    const key = `${clientId}:${tokens.connectionId}`, pending = this.refreshing.get(key);
    if (pending) return pending;
    const task = this.refresh(clientId,tokens).finally(()=>this.refreshing.delete(key));
    this.refreshing.set(key,task);
    return task;
  }
  private async refresh(clientId: string, tokens: Tokens) {
    if (!tokens.refreshToken) throw new PersonalGoogleError('Google session expired. Connect again.',401);
    const token = await this.tokenRequest({grant_type:'refresh_token',refresh_token:tokens.refreshToken},401);
    const secret = this.cipher!.encryptAuthJson(JSON.stringify({...tokens,accessToken:token.access_token,expiresAt:Date.now()+token.expires_in*1000}));
    if (!await this.store.refreshPersonalGoogleCredential!(clientId,tokens.connectionId,secret)) throw new PersonalGoogleError('Google was disconnected during refresh',409);
    return token.access_token;
  }
  async disconnect(clientId: string) {
    const tokens = await this.tokens(clientId);
    await this.store.rotatePersonalGoogleCredential!(clientId,randomUUID(),true);
    if (!tokens) return;
    const response = await this.fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:tokens.refreshToken ?? tokens.accessToken}),signal:AbortSignal.timeout(15000)});
    if (!response.ok && response.status !== 400) throw new PersonalGoogleError('Disconnected locally. Remove access in Google account settings; Google revocation failed.',502);
  }
}
