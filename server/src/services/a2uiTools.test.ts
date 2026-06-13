import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  A2UI_BASIC_COMPONENT_NAMES,
  A2UI_COMPONENT_CATALOG,
  A2UI_FOLLOW_UP_CONTEXT_KEY,
  buildA2UIFollowUpMessageContent,
  buildA2UIToolSystemPrompt,
  isA2UIFollowUpAction,
} from './a2uiTools';

describe('A2UI tool prompt', () => {
  it('advertises every official v0.9 basic catalog component', () => {
    const prompt = buildA2UIToolSystemPrompt('Base prompt.');

    for (const componentName of A2UI_BASIC_COMPONENT_NAMES) {
      assert.match(prompt, new RegExp(`\\b${componentName}\\b`));
    }

    assert.match(prompt, /Use ChoicePicker for single or multiple choice inputs/);
    assert.match(prompt, /Component objects must use `component`, not `type`/);
  });

  it('generates a worked example for every catalog component (no drift from names)', () => {
    const catalogNames = A2UI_COMPONENT_CATALOG.map(component => component.name).sort();
    assert.deepEqual(catalogNames, [...A2UI_BASIC_COMPONENT_NAMES].sort());

    const prompt = buildA2UIToolSystemPrompt('Base prompt.');
    for (const component of A2UI_COMPONENT_CATALOG) {
      assert.ok(prompt.includes(component.example), `prompt is missing example for ${component.name}`);
    }
  });

  it('documents the opt-in follow-up wiring convention', () => {
    const prompt = buildA2UIToolSystemPrompt('Base prompt.');
    assert.match(prompt, new RegExp(`context.*${A2UI_FOLLOW_UP_CONTEXT_KEY}`));
  });
});

describe('A2UI follow-up actions', () => {
  it('only treats actions opted in via context.followUp as follow-ups', () => {
    assert.equal(isA2UIFollowUpAction({ context: { [A2UI_FOLLOW_UP_CONTEXT_KEY]: true } }), true);
    assert.equal(isA2UIFollowUpAction({ context: { [A2UI_FOLLOW_UP_CONTEXT_KEY]: false } }), false);
    assert.equal(isA2UIFollowUpAction({ context: { other: 1 } }), false);
    assert.equal(isA2UIFollowUpAction({}), false);
    assert.equal(isA2UIFollowUpAction(null), false);
  });

  it('echoes user selection but drops plumbing keys from the follow-up message', () => {
    const content = buildA2UIFollowUpMessageContent({
      name: 'submit_choice',
      sourceComponentId: 'cta',
      context: {
        [A2UI_FOLLOW_UP_CONTEXT_KEY]: true,
        roomId: 'room-1',
        messageId: 'msg-1',
        dataModel: { selectedNextStep: ['export'] },
      },
    });

    assert.match(content, /action "submit_choice" on component "cta"/);
    assert.match(content, /selectedNextStep/);
    assert.doesNotMatch(content, new RegExp(A2UI_FOLLOW_UP_CONTEXT_KEY));
    assert.doesNotMatch(content, /room-1/);
    assert.doesNotMatch(content, /msg-1/);
  });

  it('omits the context clause when only plumbing keys are present', () => {
    const content = buildA2UIFollowUpMessageContent({
      name: 'ack',
      sourceComponentId: 'btn',
      context: { [A2UI_FOLLOW_UP_CONTEXT_KEY]: true, roomId: 'r', messageId: 'm' },
    });

    assert.doesNotMatch(content, /Selection\/context/);
    assert.match(content, /Continue the conversation/);
  });
});
