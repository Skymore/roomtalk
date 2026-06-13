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
        { id: 'root', component: 'Card', child: 'body' },
        { id: 'body', component: 'Column', children: ['title', 'choice'] },
        { id: 'title', component: 'Text', text: 'Summary' },
        {
          id: 'choice',
          component: 'ChoicePicker',
          label: 'Next step',
          options: [
            { label: 'Continue', value: 'continue' },
            { label: 'Export', value: 'export' },
          ],
          value: ['continue'],
        },
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

  it('repairs common model-generated A2UI aliases before validation', async () => {
    const payload = await normalizeA2UIPayload([
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
            { id: 'root', type: 'Card', children: [{ id: 'body' }] },
            { id: 'body', type: 'Column', children: [{ id: 'title' }, { id: 'choice' }, { id: 'button' }] },
            { id: 'title', type: 'Text', content: '{{demo.title}}' },
            { id: 'choice', type: 'MultipleChoice', options: [{ label: 'Continue', value: 'continue' }], value: ['continue'] },
            { id: 'button', type: 'Button', label: 'Continue' },
          ],
        },
      },
      {
        version: 'v0.9',
        updateDataModel: {
          surfaceId: 'summary-1',
          data: {
            demo: {
              title: 'Demo',
            },
          },
        },
      },
    ]);

    assert.equal(payload?.messages.length, 3);
    const updateComponents = payload?.messages[1] as any;
    assert.deepEqual(updateComponents.updateComponents.components[0], {
      id: 'root',
      component: 'Card',
      child: 'body',
    });
    assert.deepEqual(updateComponents.updateComponents.components[2], {
      id: 'title',
      component: 'Text',
      text: { path: '/demo/title' },
    });
    assert.equal(updateComponents.updateComponents.components[3].component, 'ChoicePicker');
    assert.equal(updateComponents.updateComponents.components[4].component, 'Button');
    assert.equal(updateComponents.updateComponents.components[5].id, 'button_label');
    const updateDataModel = payload?.messages[2] as any;
    assert.equal(updateDataModel.updateDataModel.path, '/');
    assert.equal(updateDataModel.updateDataModel.value.demo.title, 'Demo');
  });
});
