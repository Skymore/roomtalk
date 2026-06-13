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

export const buildA2UIToolSystemPrompt = (systemPrompt: string) => `${systemPrompt}

A2UI streaming UI capability:
- You may call the \`${A2UI_TOOL_NAME}\` tool to stream rich UI updates while answering.
- Use this tool for dashboards, task cards, comparisons, forms, checklists, or when explicitly asked for an A2UI demo.
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
- Use ChoicePicker for single or multiple choice inputs.
- Use Tabs for compact multi-section content, Modal for details opened from a trigger component, and Image/Video/AudioPlayer only when you have a concrete URL to render.
- Use official v0.9 layout props: Row/Column support children plus align/justify; List supports children plus direction/align. Do not use inline child objects; define each child as a component with an id.
- Prefer incremental updates: create the surface early, then update components/data as the answer becomes clearer.
- For the A2UI demo role, if the latest user message is exactly "hi" or "HI", always trigger a compact but non-trivial A2UI demo surface with at least a title, status text, several checklist/detail lines, and one Button action.`;

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
