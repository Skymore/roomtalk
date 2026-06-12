import { Logger } from '../logger';
import { AudioTranscriptionRecord, RoomStore } from '../repositories/store';
import { MediaAsset } from '../types';
import { MediaObjectStorage } from './mediaObjectStorage';

const ASSEMBLYAI_TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 360;

type AssemblyAITranscriptStatus = 'queued' | 'processing' | 'completed' | 'error';

type AssemblyAITranscriptResponse = {
  id?: string;
  status?: AssemblyAITranscriptStatus;
  text?: string | null;
  language_code?: string | null;
  error?: string | null;
};

export interface AudioTranscriptionJob {
  record: AudioTranscriptionRecord;
  asset: MediaAsset;
}

export type AudioTranscriptionRunner = (job: AudioTranscriptionJob) => Promise<void>;

export interface AudioTranscriptionRunnerOptions {
  store: RoomStore;
  mediaObjectStorage: MediaObjectStorage;
  apiKey?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parseAssemblyAIError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: string; message?: string };
    return payload.error || payload.message || fallback;
  } catch {
    return fallback;
  }
};

const ensureAbsoluteUrl = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  throw new Error('Audio transcription requires an absolute media read URL');
};

const createTranscript = async (input: {
  apiKey: string;
  audioUrl: string;
  fetchImpl: typeof fetch;
}): Promise<AssemblyAITranscriptResponse> => {
  const response = await input.fetchImpl(ASSEMBLYAI_TRANSCRIPT_URL, {
    method: 'POST',
    headers: {
      Authorization: input.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: input.audioUrl,
      language_detection: true,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseAssemblyAIError(response, 'AssemblyAI transcript creation failed'));
  }

  return response.json() as Promise<AssemblyAITranscriptResponse>;
};

const getTranscript = async (input: {
  apiKey: string;
  transcriptId: string;
  fetchImpl: typeof fetch;
}): Promise<AssemblyAITranscriptResponse> => {
  const response = await input.fetchImpl(`${ASSEMBLYAI_TRANSCRIPT_URL}/${encodeURIComponent(input.transcriptId)}`, {
    method: 'GET',
    headers: {
      Authorization: input.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(await parseAssemblyAIError(response, 'AssemblyAI transcript polling failed'));
  }

  return response.json() as Promise<AssemblyAITranscriptResponse>;
};

export const createAssemblyAIAudioTranscriptionRunner = (options: AudioTranscriptionRunnerOptions): AudioTranscriptionRunner => {
  const fetchImpl = options.fetchImpl || fetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  return async ({ record, asset }) => {
    if (!options.apiKey) {
      await options.store.updateAudioTranscription(record.assetId, {
        status: 'failed',
        error: 'Audio transcription is not configured',
        completedAt: null,
      });
      return;
    }

    if (asset.kind !== 'audio') {
      await options.store.updateAudioTranscription(record.assetId, {
        status: 'failed',
        error: 'Only audio messages can be transcribed',
        completedAt: null,
      });
      return;
    }

    let current = await options.store.getAudioTranscription(record.assetId) || record;
    let providerTranscriptId = current.providerTranscriptId;

    try {
      if (!providerTranscriptId) {
        const signedReadUrl = await options.mediaObjectStorage.createReadUrl({
          objectKey: asset.objectKey,
          expiresInSeconds: 60 * 60,
        });
        const created = await createTranscript({
          apiKey: options.apiKey,
          audioUrl: ensureAbsoluteUrl(signedReadUrl.url),
          fetchImpl,
        });
        if (!created.id) {
          throw new Error('AssemblyAI did not return a transcript id');
        }
        providerTranscriptId = created.id;
        current = await options.store.updateAudioTranscription(record.assetId, {
          status: created.status === 'completed' ? 'completed' : 'processing',
          providerTranscriptId,
          transcript: created.text || null,
          languageCode: created.language_code || null,
          error: null,
          completedAt: created.status === 'completed' ? new Date().toISOString() : null,
        }) || current;

        if (created.status === 'completed') {
          return;
        }
        if (created.status === 'error') {
          throw new Error(created.error || 'AssemblyAI transcription failed');
        }
      } else if (current.status !== 'processing') {
        current = await options.store.updateAudioTranscription(record.assetId, {
          status: 'processing',
          error: null,
          completedAt: null,
        }) || current;
      }

      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const transcript = await getTranscript({
          apiKey: options.apiKey,
          transcriptId: providerTranscriptId,
          fetchImpl,
        });

        if (transcript.status === 'completed') {
          await options.store.updateAudioTranscription(record.assetId, {
            status: 'completed',
            transcript: transcript.text || '',
            languageCode: transcript.language_code || null,
            error: null,
            completedAt: new Date().toISOString(),
          });
          return;
        }

        if (transcript.status === 'error') {
          throw new Error(transcript.error || 'AssemblyAI transcription failed');
        }

        if (attempt < maxPollAttempts - 1) {
          await sleep(pollIntervalMs);
        }
      }

      options.logger.warn('Audio transcription polling exhausted without a terminal status', {
        assetId: record.assetId,
        roomId: record.roomId,
        messageId: record.messageId,
        providerTranscriptId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.store.updateAudioTranscription(record.assetId, {
        status: 'failed',
        error: message,
        completedAt: null,
      });
      options.logger.error('Audio transcription job failed', {
        error: message,
        assetId: record.assetId,
        roomId: record.roomId,
        messageId: record.messageId,
      });
    }
  };
};
