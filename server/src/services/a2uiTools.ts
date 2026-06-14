import { A2UIPayload } from '../types';
import { A2UI_BASIC_CATALOG_ID, normalizeA2UIPayload } from './a2uiPayload';

export const A2UI_TOOL_NAME = 'a2ui_update';
export const MAX_A2UI_TOOL_ROUNDS = 4;
export const A2UI_BASIC_COMPONENT_NAMES = [
  'Text',
  'Image',
  'Icon',
  'Video',
  'AudioPlayer',
  'Row',
  'Column',
  'List',
  'Card',
  'Tabs',
  'Modal',
  'Divider',
  'Button',
  'TextField',
  'CheckBox',
  'ChoicePicker',
  'Slider',
  'DateTimeInput',
] as const;

const A2UI_BASIC_COMPONENT_LIST = A2UI_BASIC_COMPONENT_NAMES.join(', ');
const A2UI_DYNAMIC_VALUE_SCHEMA = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'JSON Pointer data binding, e.g. /title or /items/0/label.' },
      },
    },
    {
      type: 'object',
      required: ['call'],
      properties: {
        call: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
        returnType: { type: 'string' },
      },
      additionalProperties: false,
    },
  ],
};

const A2UI_COMPONENT_SCHEMA = {
  type: 'object',
  required: ['id', 'component'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    component: {
      type: 'string',
      enum: A2UI_BASIC_COMPONENT_NAMES,
      description: 'Use component, not type. The value must be one of the official A2UI v0.9 basic catalog component names.',
    },
    text: A2UI_DYNAMIC_VALUE_SCHEMA,
    url: A2UI_DYNAMIC_VALUE_SCHEMA,
    description: A2UI_DYNAMIC_VALUE_SCHEMA,
    name: A2UI_DYNAMIC_VALUE_SCHEMA,
    child: { type: 'string', description: 'Single child component id. Do not inline child objects.' },
    children: {
      anyOf: [
        { type: 'array', items: { type: 'string' }, description: 'Child component ids only. Do not inline child objects.' },
        {
          type: 'object',
          required: ['componentId', 'path'],
          additionalProperties: false,
          properties: {
            componentId: { type: 'string' },
            path: { type: 'string' },
          },
        },
      ],
    },
    tabs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'child'],
        additionalProperties: false,
        properties: {
          title: A2UI_DYNAMIC_VALUE_SCHEMA,
          child: { type: 'string' },
        },
      },
    },
    axis: { type: 'string', enum: ['horizontal', 'vertical'] },
    variant: { type: 'string' },
    action: {
      type: 'object',
      additionalProperties: true,
      description: 'A2UI Action object, usually { "event": { "name": "...", "context": {} } }.',
    },
    label: A2UI_DYNAMIC_VALUE_SCHEMA,
    value: A2UI_DYNAMIC_VALUE_SCHEMA,
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'value'],
        additionalProperties: false,
        properties: {
          label: A2UI_DYNAMIC_VALUE_SCHEMA,
          value: { type: 'string' },
        },
      },
    },
    displayStyle: { type: 'string', enum: ['checkbox', 'chips'] },
    filterable: { type: 'boolean' },
    min: A2UI_DYNAMIC_VALUE_SCHEMA,
    max: A2UI_DYNAMIC_VALUE_SCHEMA,
    enableDate: { type: 'boolean' },
    enableTime: { type: 'boolean' },
    align: { type: 'string', enum: ['start', 'center', 'end', 'stretch'] },
    justify: { type: 'string', enum: ['start', 'center', 'end', 'spaceAround', 'spaceBetween', 'spaceEvenly', 'stretch'] },
    direction: { type: 'string', enum: ['vertical', 'horizontal'] },
    fit: { type: 'string', enum: ['contain', 'cover', 'fill', 'none', 'scaleDown'] },
  },
};

const A2UI_TOOL_PARAMETER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: {
    messages: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'createSurface'],
            properties: {
              version: { const: 'v0.9' },
              createSurface: {
                type: 'object',
                additionalProperties: false,
                required: ['surfaceId', 'catalogId'],
                properties: {
                  surfaceId: { type: 'string' },
                  catalogId: { const: A2UI_BASIC_CATALOG_ID },
                  sendDataModel: { type: 'boolean' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'updateComponents'],
            properties: {
              version: { const: 'v0.9' },
              updateComponents: {
                type: 'object',
                additionalProperties: false,
                required: ['surfaceId', 'components'],
                properties: {
                  surfaceId: { type: 'string' },
                  components: { type: 'array', minItems: 1, items: A2UI_COMPONENT_SCHEMA },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'updateDataModel'],
            properties: {
              version: { const: 'v0.9' },
              updateDataModel: {
                type: 'object',
                additionalProperties: false,
                required: ['surfaceId', 'value'],
                properties: {
                  surfaceId: { type: 'string' },
                  path: { type: 'string', description: 'Use / for the whole data model.' },
                  value: { description: 'JSON value to bind into the data model.' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['version', 'deleteSurface'],
            properties: {
              version: { const: 'v0.9' },
              deleteSurface: {
                type: 'object',
                additionalProperties: false,
                required: ['surfaceId'],
                properties: {
                  surfaceId: { type: 'string' },
                },
              },
            },
          },
        ],
      },
    },
  },
};

export const openAIA2UITool = {
  type: 'function',
  function: {
    name: A2UI_TOOL_NAME,
    description: [
      'Stream an A2UI v0.9 server-to-client message batch to the user interface.',
      'Call this when a structured card, media preview, tabbed view, checklist, comparison, form, or live demo UI is useful.',
      'The server validates these messages with the official @a2ui/web_core v0.9 schema before rendering.',
    ].join(' '),
    parameters: A2UI_TOOL_PARAMETER_SCHEMA,
  },
};

export const anthropicA2UITool = {
  name: A2UI_TOOL_NAME,
  description: openAIA2UITool.function.description,
  input_schema: A2UI_TOOL_PARAMETER_SCHEMA,
};

// Context flag the model attaches to an action it wants to re-invoke the agent with.
// "Wiring" is opt-in per component: only actions whose event context sets this flag
// trigger a new LLM turn. Everything else is a plain client-side action.
export const A2UI_FOLLOW_UP_CONTEXT_KEY = 'followUp';

type A2UIComponentName = (typeof A2UI_BASIC_COMPONENT_NAMES)[number];
type A2UIComponentDoc = { name: A2UIComponentName; summary: string; example: string };

// Single source of truth for the per-component guidance injected into the system
// prompt. This mirrors what the official Python SDK's A2uiSchemaManager.generate_
// system_prompt() does (component list + one worked example each), but is kept in
// TS so it cannot drift from the v0.9 basic catalog we actually validate against.
// Every name in A2UI_BASIC_COMPONENT_NAMES must have exactly one entry here
// (enforced by a2uiTools.test.ts).
export const A2UI_COMPONENT_CATALOG: A2UIComponentDoc[] = [
  { name: 'Text', summary: 'Inline/heading text; bind with text, set variant (h3/body/caption).', example: '{"id":"title","component":"Text","text":{"path":"/title"},"variant":"h3"}' },
  { name: 'Image', summary: 'Static image from a concrete url; optional fit (cover/contain).', example: '{"id":"hero","component":"Image","url":{"path":"/imageUrl"},"fit":"cover"}' },
  { name: 'Icon', summary: 'Named glyph; name must be a known icon (info/check/play).', example: '{"id":"ico","component":"Icon","name":"info"}' },
  { name: 'Video', summary: 'Video player from a concrete url.', example: '{"id":"vid","component":"Video","url":{"path":"/videoUrl"}}' },
  { name: 'AudioPlayer', summary: 'Audio player from a concrete url.', example: '{"id":"aud","component":"AudioPlayer","url":{"path":"/audioUrl"}}' },
  { name: 'Row', summary: 'Horizontal layout; children ids plus align/justify.', example: '{"id":"row","component":"Row","children":["a","b"],"align":"center","justify":"spaceBetween"}' },
  { name: 'Column', summary: 'Vertical layout; children ids plus align/justify.', example: '{"id":"col","component":"Column","children":["a","b"],"align":"stretch"}' },
  { name: 'List', summary: 'Repeated stack; children ids plus direction/align.', example: '{"id":"list","component":"List","children":["i1","i2"],"direction":"vertical"}' },
  { name: 'Card', summary: 'Single-child container; use child (not children).', example: '{"id":"root","component":"Card","child":"body"}' },
  { name: 'Tabs', summary: 'Tabbed sections; each tab has title plus a child component id.', example: '{"id":"tabs","component":"Tabs","tabs":[{"title":"Inputs","child":"t1"},{"title":"Media","child":"t2"}]}' },
  { name: 'Modal', summary: 'Detail dialog; trigger and content are component ids.', example: '{"id":"modal","component":"Modal","trigger":"open_btn","content":"modal_body"}' },
  { name: 'Divider', summary: 'Visual separator; optional axis.', example: '{"id":"div","component":"Divider"}' },
  { name: 'Button', summary: 'Action button; child label id plus an action event.', example: '{"id":"cta","component":"Button","child":"cta_label","variant":"primary","action":{"event":{"name":"do_it","context":{}}}}' },
  { name: 'TextField', summary: 'Single-line text input bound to the data model.', example: '{"id":"name","component":"TextField","label":"Name","value":{"path":"/name"}}' },
  { name: 'CheckBox', summary: 'Boolean toggle bound to the data model.', example: '{"id":"agree","component":"CheckBox","label":"I agree","value":{"path":"/agree"}}' },
  { name: 'ChoicePicker', summary: 'Single/multi choice; options[].label+value, displayStyle chips/checkbox.', example: '{"id":"pick","component":"ChoicePicker","label":"Pick","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}],"value":["a"],"displayStyle":"chips"}' },
  { name: 'Slider', summary: 'Numeric slider; min/max plus value.', example: '{"id":"score","component":"Slider","label":"Score","min":0,"max":100,"value":{"path":"/score"}}' },
  { name: 'DateTimeInput', summary: 'Date/time picker; toggle enableDate/enableTime.', example: '{"id":"when","component":"DateTimeInput","label":"When","value":{"path":"/when"},"enableDate":true,"enableTime":true}' },
];

export const buildA2UIComponentGuide = (): string =>
  A2UI_COMPONENT_CATALOG
    .map(component => `  - ${component.name}: ${component.summary}\n    example: ${component.example}`)
    .join('\n');

export const buildA2UIToolSystemPrompt = (systemPrompt: string) => `${systemPrompt}

A2UI streaming UI capability:
- You may call the \`${A2UI_TOOL_NAME}\` tool to stream rich UI updates while answering.
- Use this tool for dashboards, task cards, comparisons, forms, checklists, or when explicitly asked for an A2UI demo. Treat A2UI as a template-first, data-first visual enhancement to the answer, not as an unrestricted application runtime.
- Do not print A2UI JSON in markdown. Use the tool only.
- All messages must use \`version: "v0.9"\`.
- To create a surface, first send:
  \`{"version":"v0.9","createSurface":{"surfaceId":"stable-id","catalogId":"${A2UI_BASIC_CATALOG_ID}"}}\`
- Then send one or more \`updateComponents\` and \`updateDataModel\` messages. The root component id should be \`root\`.
- Component objects must use \`component\`, not \`type\`. Text uses \`text\`, not \`content\`. Data model updates use \`value\`, not \`data\`. Data bindings use \`{"path":"/some/value"}\`, not moustache templates.
- A minimal valid component tree is:
  \`{"version":"v0.9","updateComponents":{"surfaceId":"stable-id","components":[{"id":"root","component":"Card","child":"body"},{"id":"body","component":"Column","children":["title","cta"]},{"id":"title","component":"Text","text":{"path":"/title"},"variant":"h3"},{"id":"cta","component":"Button","child":"cta_label","variant":"primary","action":{"event":{"name":"demo_click","context":{}}}},{"id":"cta_label","component":"Text","text":"Continue"}]}}\`
- A minimal valid data update is:
  \`{"version":"v0.9","updateDataModel":{"surfaceId":"stable-id","path":"/","value":{"title":"Streaming A2UI"}}}\`
- Use only these A2UI basic catalog components unless the client explicitly advertises more: ${A2UI_BASIC_COMPONENT_LIST}.
- Component reference (use these exact shapes; define each child as its own component with an id, never inline child objects):
${buildA2UIComponentGuide()}
- Use ChoicePicker for single or multiple choice inputs, Tabs for compact multi-section content, Modal for details opened from a trigger component, and Image/Video/AudioPlayer only when you have a concrete URL to render.
- Keep the data model source-first. Pick one source of truth for mutable state, such as \`tasks[].done\`, \`selectedOption\`, or \`quantity\`. Fields like status text, counts, totals, percentages, and progress are derived display values; recompute them from the source of truth before every \`updateDataModel\`.
- Do not bind user controls to derived fields when another control edits the underlying source. For example, if CheckBox controls edit \`tasks[].done\`, do not expose a Slider bound to \`progress\`; compute progress from the tasks instead.
- Do not claim that a button completed real payment, submission, deletion, booking, external API work, or other business side effects unless the product has a real backend reducer for that action. Without such a reducer, label it as a draft, preview, local selection, explanation, or assistant follow-up.
- Prefer incremental updates: create the surface early, then update components/data as the answer becomes clearer.
- Interactive follow-ups: a component's \`action\` reports a click back to you. If — and only if — clicking it should continue the conversation (you produce a new answer / new UI), set \`"context": { "${A2UI_FOLLOW_UP_CONTEXT_KEY}": true }\` inside that action's event. The server will then start a new assistant turn carrying the click. Decide per component which clicks deserve a follow-up; leave the flag off for purely cosmetic or client-only actions.
- For the A2UI demo role, if the latest user message is exactly "hi" or "HI", always trigger a compact but non-trivial A2UI demo surface with at least a title, status text, several checklist/detail lines, and one or more data-bound controls. Include at most one assistant follow-up Button whose event sets \`context.${A2UI_FOLLOW_UP_CONTEXT_KEY}=true\`; leave local-only controls without the follow-up flag.`;

// An action is "wired" to the agent only when the model explicitly opted in by
// setting context.followUp === true on the event (see buildA2UIToolSystemPrompt).
export const isA2UIFollowUpAction = (action: { context?: Record<string, unknown> } | null | undefined): boolean => (
  !!action && typeof action.context === 'object' && action.context !== null && action.context[A2UI_FOLLOW_UP_CONTEXT_KEY] === true
);

// Keys that are plumbing, not user intent, and should not be echoed back to the model.
const A2UI_FOLLOW_UP_INTERNAL_CONTEXT_KEYS = new Set([A2UI_FOLLOW_UP_CONTEXT_KEY, 'roomId', 'messageId']);

export const buildA2UIFollowUpMessageContent = (action: {
  name: string;
  sourceComponentId: string;
  context?: Record<string, unknown>;
}): string => {
  const meaningfulContext = Object.fromEntries(
    Object.entries(action.context ?? {}).filter(([key]) => !A2UI_FOLLOW_UP_INTERNAL_CONTEXT_KEYS.has(key)),
  );
  const hasContext = Object.keys(meaningfulContext).length > 0;
  return [
    `The user interacted with the streamed A2UI surface: action "${action.name}" on component "${action.sourceComponentId}".`,
    hasContext ? `Selection/context: ${JSON.stringify(meaningfulContext)}.` : '',
    'Continue the conversation based on this interaction, updating or replacing the A2UI surface as needed.',
  ].filter(Boolean).join(' ');
};

const parseToolArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

export const normalizeA2UIToolArguments = async (value: unknown): Promise<A2UIPayload | null> => {
  const parsed = parseToolArguments(value);
  return normalizeA2UIPayload(parsed);
};
