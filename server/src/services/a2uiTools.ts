import { A2UIPayload } from '../types';
import { A2UI_BASIC_CATALOG_ID, normalizeA2UIPayload } from './a2uiPayload';

export const A2UI_TOOL_NAME = 'a2ui_update';
export const MAX_A2UI_TOOL_ROUNDS = 4;

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
        type: 'object',
        additionalProperties: true,
        properties: {
          version: { const: 'v0.9' },
        },
        required: ['version'],
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
      'Call this when a structured card, checklist, comparison, form, or live demo UI is useful.',
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
- Use only the basic catalog components unless the client explicitly advertises more: Text, Row, Column, Card, List, Divider, Button, TextField, CheckBox, MultipleChoice, Slider, DateTimeInput.
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
