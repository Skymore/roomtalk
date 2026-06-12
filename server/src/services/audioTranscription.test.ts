import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioTranscriptionRecord } from '../repositories/store';
import { MediaAsset } from '../types';
import { createAssemblyAIAudioTranscriptionRunner } from './audioTranscription';

const record = (overrides: Partial<AudioTranscriptionRecord> = {}): AudioTranscriptionRecord => ({
  assetId: 'audio-asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  requestedByClientId: 'client-1',
  status: 'pending',
  provider: 'assemblyai',
  createdAt: '2026-05-03T10:00:00.000Z',
  updatedAt: '2026-05-03T10:00:00.000Z',
  ...overrides,
});

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'audio-asset-1',
  roomId: 'room-1',
  messageId: 'message-1',
  objectKey: 'rooms/room-1/media/audio/audio-asset-1',
  kind: 'audio',
  mimeType: 'audio/webm',
  byteSize: 456,
  createdAt: '2026-05-03T10:00:00.000Z',
  ...overrides,
});

describe('AssemblyAI audio transcription runner', () => {
  it('creates a non-streaming transcript with language detection and persists the completed result', async () => {
    let storedRecord = record();
    const fetchRequests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetchRequests.push({ url: String(url), init });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'provider-transcript-1', status: 'processing' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'provider-transcript-1',
        status: 'completed',
        text: '你好 hello',
        language_code: 'zh',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const runner = createAssemblyAIAudioTranscriptionRunner({
      store: {
        async getAudioTranscription() {
          return storedRecord;
        },
        async updateAudioTranscription(_assetId: string, updates: any) {
          storedRecord = { ...storedRecord, ...updates, updatedAt: updates.updatedAt || storedRecord.updatedAt };
          if (updates.error === null) delete storedRecord.error;
          return storedRecord;
        },
      } as any,
      mediaObjectStorage: {
        isConfigured: () => true,
        async createReadUrl() {
          return { url: 'https://media.example/audio-asset-1.webm', expiresAt: '2026-05-03T11:00:00.000Z' };
        },
      } as any,
      apiKey: 'assembly-key',
      logger: { warn() {}, error() {} } as any,
      fetchImpl: fetchImpl as any,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });

    await runner({ record: storedRecord, asset: asset() });

    assert.equal(fetchRequests.length, 2);
    assert.equal(fetchRequests[0].url, 'https://api.assemblyai.com/v2/transcript');
    assert.deepEqual(JSON.parse(fetchRequests[0].init?.body as string), {
      audio_url: 'https://media.example/audio-asset-1.webm',
      language_detection: true,
    });
    assert.equal(fetchRequests[1].url, 'https://api.assemblyai.com/v2/transcript/provider-transcript-1');
    assert.equal(storedRecord.status, 'completed');
    assert.equal(storedRecord.providerTranscriptId, 'provider-transcript-1');
    assert.equal(storedRecord.transcript, '你好 hello');
    assert.equal(storedRecord.languageCode, 'zh');
    assert.ok(storedRecord.completedAt);
  });

  it('marks the record failed when AssemblyAI is not configured', async () => {
    let storedRecord = record();
    const runner = createAssemblyAIAudioTranscriptionRunner({
      store: {
        async updateAudioTranscription(_assetId: string, updates: any) {
          storedRecord = { ...storedRecord, ...updates, updatedAt: updates.updatedAt || storedRecord.updatedAt };
          return storedRecord;
        },
      } as any,
      mediaObjectStorage: {} as any,
      logger: { warn() {}, error() {} } as any,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
    });

    await runner({ record: storedRecord, asset: asset() });

    assert.equal(storedRecord.status, 'failed');
    assert.equal(storedRecord.error, 'Audio transcription is not configured');
  });
});
