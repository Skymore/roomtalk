import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { migrateS3Objects } from './migrateS3Objects';

const md5 = (value: Buffer) => createHash('md5').update(value).digest('hex');

describe('migrateS3Objects', () => {
  it('dry-runs without reading or writing object bodies', async () => {
    const body = Buffer.from('one');
    let bodyCalls = 0;
    const sourceClient = {
      async send(command: any) {
        if (command instanceof ListObjectsV2Command) {
          return { Contents: [{ Key: 'rooms/one', Size: body.length, ETag: `"${md5(body)}"` }] };
        }
        bodyCalls += 1;
        throw new Error('unexpected body read');
      },
    };
    const result = await migrateS3Objects({
      sourceClient,
      sourceBucket: 'source',
      targetClient: { send: async () => { throw new Error('unexpected target call'); } },
      targetBucket: 'target',
      execute: false,
    });
    assert.equal(result.listed, 1);
    assert.equal(result.totalBytes, body.length);
    assert.equal(bodyCalls, 0);
  });

  it('preserves object headers and verifies copied bytes, then skips an identical rerun', async () => {
    const body = Buffer.from('image-bytes');
    const sourceEtag = md5(body);
    let sourceGets = 0;
    let targetBody: Buffer | null = null;
    let targetInput: any;
    const sourceClient = {
      async send(command: any) {
        if (command instanceof ListObjectsV2Command) {
          return {
            Contents: [{
              Key: 'rooms/room-1/image.webp',
              Size: body.length,
              ETag: `"${sourceEtag}"`,
              LastModified: new Date('2026-07-20T00:00:00Z'),
            }],
          };
        }
        assert.ok(command instanceof GetObjectCommand);
        sourceGets += 1;
        return {
          Body: Readable.from([body]),
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=60',
          Metadata: { existing: 'metadata' },
        };
      },
    };
    const targetClient = {
      async send(command: any) {
        if (command instanceof HeadObjectCommand) {
          if (!targetBody) {
            const error: any = new Error('missing');
            error.name = 'NotFound';
            throw error;
          }
          return {
            ContentLength: targetBody.length,
            ETag: `"${md5(targetBody)}"`,
            Metadata: targetInput.Metadata,
          };
        }
        assert.ok(command instanceof PutObjectCommand);
        targetInput = command.input;
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        targetBody = Buffer.concat(chunks);
        return { ETag: `"${md5(targetBody)}"` };
      },
    };

    const first = await migrateS3Objects({
      sourceClient,
      sourceBucket: 'source',
      targetClient,
      targetBucket: 'target',
      execute: true,
    });
    assert.equal(first.copied, 1);
    assert.equal(first.verified, 1);
    assert.deepEqual(targetBody, body);
    assert.equal(targetInput.ContentType, 'image/webp');
    assert.equal(targetInput.CacheControl, 'private, max-age=60');
    assert.equal(targetInput.Metadata.existing, 'metadata');
    assert.equal(targetInput.Metadata['roomtalk-source-etag'], sourceEtag);

    const second = await migrateS3Objects({
      sourceClient,
      sourceBucket: 'source',
      targetClient,
      targetBucket: 'target',
      execute: true,
    });
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.verified, 1);
    assert.equal(sourceGets, 1);
  });
});
