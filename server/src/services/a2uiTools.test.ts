import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  A2UI_BASIC_COMPONENT_NAMES,
  A2UI_COMPONENT_CATALOG,
  A2UI_FOLLOW_UP_CONTEXT_KEY,
  buildA2UIFollowUpMessageContent,
  buildA2UIToolSystemPrompt,
  isA2UIFollowUpAction,
  sanitizeA2UIFollowUpContext,
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
    assert.match(prompt, /If .+ and only if .+ clicking it should continue the conversation/);
    assert.match(prompt, /purely cosmetic or client-only actions/);
  });

  it('constrains A2UI generation to data-first templates and honest actions', () => {
    const prompt = buildA2UIToolSystemPrompt('Base prompt.');

    assert.match(prompt, /template-first, data-first/);
    assert.match(prompt, /source of truth/);
    assert.match(prompt, /derived display values/);
    assert.match(prompt, /recompute them from the source of truth/);
    assert.match(prompt, /do not expose a Slider bound to `progress`/);
    assert.match(prompt, /Do not claim that a button completed real payment, submission, deletion, booking/);
    assert.match(prompt, /backend reducer/);
  });

  it('keeps the automatic hi demo trigger opt-in to the demo role', () => {
    const defaultPrompt = buildA2UIToolSystemPrompt('Base prompt.');
    const demoPrompt = buildA2UIToolSystemPrompt('Base prompt.', { includeDemoTrigger: true });

    assert.doesNotMatch(defaultPrompt, /latest user message is exactly "hi"/);
    assert.match(demoPrompt, /latest user message is exactly "hi"/);
    assert.match(demoPrompt, /at most one assistant follow-up Button/);
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

  it('echoes sanitized user selection but drops plumbing keys from the follow-up message', () => {
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
    assert.match(content, /sanitized, source-focused/);
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

  it('recomputes task summary from tasks and removes stale derived display fields', () => {
    const sanitized = sanitizeA2UIFollowUpContext({
      [A2UI_FOLLOW_UP_CONTEXT_KEY]: true,
      dataModel: {
        title: 'Daily tasks',
        subtitle: 'stale subtitle',
        status: '2 / 5 completed',
        progress: 40,
        note: 'old note',
        taskSummary: { doneCount: 2, total: 5, progressPercent: 40 },
        tasks: [
          { label: 'Email', done: false },
          { label: 'Report', done: true },
          { label: 'Run', done: true },
          { label: 'Read', done: true },
          { label: 'Groceries', done: true },
        ],
      },
    });

    assert.deepEqual(sanitized, {
      dataModel: {
        title: 'Daily tasks',
        tasks: [
          { label: 'Email', done: false },
          { label: 'Report', done: true },
          { label: 'Run', done: true },
          { label: 'Read', done: true },
          { label: 'Groceries', done: true },
        ],
        taskSummary: {
          doneCount: 4,
          total: 5,
          progressPercent: 80,
        },
      },
    });

    const content = buildA2UIFollowUpMessageContent({
      name: 'task_mark_one_done',
      sourceComponentId: 'done_btn',
      context: sanitized,
    });
    assert.match(content, /"progressPercent":80/);
    assert.doesNotMatch(content, /2 \/ 5 completed/);
    assert.doesNotMatch(content, /"progress":40/);
  });

  it('bounds large follow-up context before sending it back to the model', () => {
    const sanitized = sanitizeA2UIFollowUpContext({
      dataModel: {
        title: 'Large payload',
        notes: 'x'.repeat(700),
        items: Array.from({ length: 30 }, (_, index) => ({ index, label: `Item ${index}` })),
      },
    });

    assert.equal((sanitized.dataModel as { notes: string }).notes.length < 700, true);
    assert.equal((sanitized.dataModel as { items: unknown[] }).items.length, 21);
    assert.deepEqual((sanitized.dataModel as { items: unknown[] }).items.at(-1), { _truncatedItems: 10 });

    const content = buildA2UIFollowUpMessageContent({
      name: 'large',
      sourceComponentId: 'btn',
      context: { dataModel: sanitized.dataModel },
    });
    assert.equal(content.length < 7000, true);
    assert.match(content, /truncated/);
  });
});
