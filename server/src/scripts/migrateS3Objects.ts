import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Transform } from 'stream';

type S3CommandClient = {
  send(command: GetObjectCommand | HeadObjectCommand | ListObjectsV2Command | PutObjectCommand): Promise<any>;
};

type ListedObject = {
  objectKey: string;
  byteSize: number;
  etag?: string;
  lastModified?: string;
};

export type S3MigrationResult = {
  listed: number;
  totalBytes: number;
  copied: number;
  copiedBytes: number;
  skipped: number;
  verified: number;
};

const cleanEtag = (etag?: string) => etag?.replace(/^"|"$/g, '');
const isMd5Etag = (etag?: string) => Boolean(etag && /^[a-f0-9]{32}$/i.test(etag));

const listObjects = async (client: S3CommandClient, bucket: string) => {
  const objects: ListedObject[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }));
    for (const object of response.Contents || []) {
      if (!object.Key || typeof object.Size !== 'number') {
        continue;
      }
      objects.push({
        objectKey: object.Key,
        byteSize: object.Size,
        etag: cleanEtag(object.ETag),
        lastModified: object.LastModified?.toISOString(),
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
};

const readTargetHead = async (client: S3CommandClient, bucket: string, objectKey: string) => {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (error: any) {
    if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
};

const targetMatchesSource = (source: ListedObject, target: any) => {
  if (!target || Number(target.ContentLength) !== source.byteSize) {
    return false;
  }
  const sourceEtag = cleanEtag(source.etag);
  const targetEtag = cleanEtag(target.ETag);
  if (isMd5Etag(sourceEtag) && targetEtag === sourceEtag) {
    return true;
  }
  return Boolean(sourceEtag && target.Metadata?.['roomtalk-source-etag'] === sourceEtag);
};

const copyObject = async (input: {
  sourceClient: S3CommandClient;
  sourceBucket: string;
  targetClient: S3CommandClient;
  targetBucket: string;
  entry: ListedObject;
}) => {
  const source = await input.sourceClient.send(new GetObjectCommand({
    Bucket: input.sourceBucket,
    Key: input.entry.objectKey,
  }));
  if (!source.Body || typeof source.Body.pipe !== 'function') {
    throw new Error(`S3 object ${input.entry.objectKey} returned no Node-readable body`);
  }

  const hash = createHash('md5');
  let receivedBytes = 0;
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.length;
      hash.update(buffer);
      callback(null, buffer);
    },
  });
  source.Body.on('error', (error: Error) => hashingStream.destroy(error));
  source.Body.pipe(hashingStream);

  const sourceEtag = cleanEtag(input.entry.etag);
  await input.targetClient.send(new PutObjectCommand({
    Bucket: input.targetBucket,
    Key: input.entry.objectKey,
    Body: hashingStream,
    ContentLength: input.entry.byteSize,
    ContentType: source.ContentType,
    CacheControl: source.CacheControl,
    ContentDisposition: source.ContentDisposition,
    ContentEncoding: source.ContentEncoding,
    ContentLanguage: source.ContentLanguage,
    Metadata: {
      ...(source.Metadata || {}),
      ...(sourceEtag ? { 'roomtalk-source-etag': sourceEtag } : {}),
      ...(input.entry.lastModified ? { 'roomtalk-source-last-modified': input.entry.lastModified } : {}),
    },
  }));

  if (receivedBytes !== input.entry.byteSize) {
    throw new Error(`S3 object ${input.entry.objectKey} size mismatch: expected ${input.entry.byteSize}, received ${receivedBytes}`);
  }
  const copiedMd5 = hash.digest('hex');
  if (isMd5Etag(sourceEtag) && sourceEtag !== copiedMd5) {
    throw new Error(`S3 object ${input.entry.objectKey} source MD5 mismatch`);
  }

  const target = await readTargetHead(input.targetClient, input.targetBucket, input.entry.objectKey);
  if (!target || Number(target.ContentLength) !== input.entry.byteSize) {
    throw new Error(`S3 object ${input.entry.objectKey} target size verification failed`);
  }
  const targetEtag = cleanEtag(target.ETag);
  if (isMd5Etag(targetEtag) && targetEtag !== copiedMd5) {
    throw new Error(`S3 object ${input.entry.objectKey} target MD5 verification failed`);
  }
};

export const migrateS3Objects = async (input: {
  sourceClient: S3CommandClient;
  sourceBucket: string;
  targetClient: S3CommandClient;
  targetBucket: string;
  execute: boolean;
  concurrency?: number;
  onProgress?: (result: S3MigrationResult) => void;
}): Promise<S3MigrationResult> => {
  const objects = await listObjects(input.sourceClient, input.sourceBucket);
  const result: S3MigrationResult = {
    listed: objects.length,
    totalBytes: objects.reduce((sum, object) => sum + object.byteSize, 0),
    copied: 0,
    copiedBytes: 0,
    skipped: 0,
    verified: 0,
  };
  if (!input.execute) {
    return result;
  }

  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const entry = objects[index];
      if (!entry) return;
      const target = await readTargetHead(input.targetClient, input.targetBucket, entry.objectKey);
      if (targetMatchesSource(entry, target)) {
        result.skipped += 1;
        result.verified += 1;
      } else {
        await copyObject({
          sourceClient: input.sourceClient,
          sourceBucket: input.sourceBucket,
          targetClient: input.targetClient,
          targetBucket: input.targetBucket,
          entry,
        });
        result.copied += 1;
        result.copiedBytes += entry.byteSize;
        result.verified += 1;
      }
      input.onProgress?.(result);
    }
  };

  const concurrency = Math.max(1, Math.min(16, input.concurrency || 4));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
};

const readRequired = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const createClient = (prefix: 'SOURCE' | 'TARGET') => new S3Client({
  region: process.env[`${prefix}_S3_REGION`] || 'us-east-1',
  endpoint: readRequired(`${prefix}_S3_ENDPOINT`),
  forcePathStyle: process.env[`${prefix}_S3_FORCE_PATH_STYLE`] === 'true',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: readRequired(`${prefix}_S3_ACCESS_KEY_ID`),
    secretAccessKey: readRequired(`${prefix}_S3_SECRET_ACCESS_KEY`),
  },
});

const valueAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const main = async () => {
  const execute = process.argv.includes('--execute');
  let completed = 0;
  const result = await migrateS3Objects({
    sourceClient: createClient('SOURCE'),
    sourceBucket: readRequired('SOURCE_S3_BUCKET'),
    targetClient: createClient('TARGET'),
    targetBucket: readRequired('TARGET_S3_BUCKET'),
    execute,
    concurrency: Number(valueAfter('--concurrency') || '4'),
    onProgress: (progress) => {
      const current = progress.copied + progress.skipped;
      if (current === progress.listed || current - completed >= 100) {
        completed = current;
        console.log(JSON.stringify({ progress: current, total: progress.listed }));
      }
    },
  });
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...result }));
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
