import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { A2UI_BASIC_CATALOG_ID, normalizeA2UIPayload } from './a2uiPayload';

const validMessages = [
  {
    version: 'v0.9',
    createSurface: {
      surfaceId: 'summary-1',
      catalogId: A2UI_BASIC_CATALOG_ID,
    },
  },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'summary-1',
      components: [
        { id: 'root', component: 'Card', child: 'title' },
        { id: 'title', component: 'Text', text: 'Summary' },
      ],
    },
  },
];

describe('A2UI payload normalization', () => {
  it('normalizes valid A2UI message arrays with the official v0.9 schema', async () => {
    const payload = await normalizeA2UIPayload(validMessages);

    assert.deepEqual(payload, {
      format: 'a2ui',
      version: 'v0.9',
      messages: validMessages,
    });
  });

  it('normalizes valid A2UI message wrappers', async () => {
    const payload = await normalizeA2UIPayload({ messages: validMessages });

    assert.equal(payload?.format, 'a2ui');
    assert.equal(payload?.version, 'v0.9');
    assert.equal(payload?.messages.length, 2);
  });

  it('rejects invalid A2UI messages instead of accepting markdown-fenced JSON', async () => {
    const payload = await normalizeA2UIPayload([
      { version: 'v0.9.1', createSurface: { surfaceId: 'summary-1' } },
    ]);

    assert.equal(payload, null);
  });
});
