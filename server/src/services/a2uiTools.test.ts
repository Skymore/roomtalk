import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { A2UI_BASIC_COMPONENT_NAMES, buildA2UIToolSystemPrompt } from './a2uiTools';

describe('A2UI tool prompt', () => {
  it('advertises every official v0.9 basic catalog component', () => {
    const prompt = buildA2UIToolSystemPrompt('Base prompt.');

    for (const componentName of A2UI_BASIC_COMPONENT_NAMES) {
      assert.match(prompt, new RegExp(`\\b${componentName}\\b`));
    }

    assert.match(prompt, /Use ChoicePicker for single or multiple choice inputs/);
    assert.match(prompt, /Component objects must use `component`, not `type`/);
  });
});
