import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ImageUploadSessions } from './imageUploadSessions';

describe('ImageUploadSessions', () => {
  it('collects chunks out of order and returns a complete buffer', () => {
    const uploads = new ImageUploadSessions();
    assert.deepEqual(uploads.start({ fileId: 'file-1', totalChunks: 3, roomId: 'room-1', clientId: 'user-1' }), { ok: true });

    assert.deepEqual(uploads.addChunk('file-1', 2, Buffer.from('c').toString('base64')), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', 0, Buffer.from('a').toString('base64')), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', 1, Buffer.from('b').toString('base64')), { ok: true });

    const result = uploads.complete('file-1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.buffer.toString(), 'abc');
      assert.equal(result.session.roomId, 'room-1');
      assert.equal(result.session.clientId, 'user-1');
    }
  });

  it('rejects unknown sessions and invalid chunk indexes', () => {
    const uploads = new ImageUploadSessions();

    assert.deepEqual(uploads.addChunk('missing', 0, 'AA=='), { ok: false, error: 'missing-session' });

    assert.deepEqual(uploads.start({ fileId: 'file-1', totalChunks: 2, roomId: 'room-1', clientId: 'user-1' }), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', -1, 'AA=='), { ok: false, error: 'invalid-index' });
    assert.deepEqual(uploads.addChunk('file-1', 2, 'AA=='), { ok: false, error: 'invalid-index' });
  });

  it('rejects oversized upload declarations and accumulated chunks', () => {
    const uploads = new ImageUploadSessions(4, 2);

    assert.deepEqual(uploads.start({ fileId: 'too-many', totalChunks: 3, roomId: 'room-1', clientId: 'user-1' }), { ok: false, error: 'invalid-upload' });
    assert.deepEqual(uploads.start({ fileId: 'file-1', totalChunks: 2, roomId: 'room-1', clientId: 'user-1' }), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', 0, Buffer.from('abcd').toString('base64')), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', 1, Buffer.from('e').toString('base64')), { ok: false, error: 'too-large' });
    assert.deepEqual(uploads.addChunk('file-1', 0, Buffer.from('a').toString('base64')), { ok: true });
    assert.deepEqual(uploads.addChunk('file-1', 1, Buffer.from('bc').toString('base64')), { ok: true });
  });

  it('does not complete while any chunk is missing and clears completed sessions', () => {
    const uploads = new ImageUploadSessions();
    assert.deepEqual(uploads.start({ fileId: 'file-1', totalChunks: 2, roomId: 'room-1', clientId: 'user-1' }), { ok: true });

    assert.deepEqual(uploads.addChunk('file-1', 1, Buffer.from('b').toString('base64')), { ok: true });
    assert.deepEqual(uploads.complete('file-1'), { ok: false, error: 'incomplete' });

    uploads.clear('file-1');
    assert.equal(uploads.has('file-1'), false);
    assert.deepEqual(uploads.complete('file-1'), { ok: false, error: 'missing-session' });
  });
});
