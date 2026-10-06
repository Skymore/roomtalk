import { PersonalAgentProfile } from '../types';

export const PERSONAL_AGENT_MAX_INSTRUCTIONS_CHARS = 8_000;
export const PERSONAL_AGENT_MAX_MEMORY_CHARS = 16_000;
export const PERSONAL_AGENT_MEMORY_API_SUFFIX = '/personal-memory';

export const buildPersonalAgentPrompt = (
  profile: PersonalAgentProfile,
  prompt: string,
  memoryToolsAvailable: boolean,
): string => [
  '# Your personal agent identity',
  `Your name is ${profile.name.slice(0, 80)}. You are this user's persistent personal assistant.`,
  'Use the personal instructions and memory below as context for the current task.',
  'Do not claim to have saved a memory or scheduled a task unless the corresponding operation succeeded.',
  '\n## Personal instructions',
  profile.instructions.slice(0, PERSONAL_AGENT_MAX_INSTRUCTIONS_CHARS) || '(none)',
  '\n## Personal memory',
  profile.memory.slice(0, PERSONAL_AGENT_MAX_MEMORY_CHARS) || '(none)',
  ...(memoryToolsAvailable ? [
    '\n## Persistent memory tool',
    'You can read and update this same personal memory from the shell using the turn-scoped RoomTalk broker.',
    '`roomtalk memory get --json` returns {memory,updatedAt}.',
    'Write the complete updated memory to a UTF-8 file, then run `roomtalk memory set --file <path> --expected-updated-at <updatedAt returned by get> --json` to save it.',
    'Read the latest memory before replacing it, preserve unrelated entries, and summarize durable preferences or useful facts rather than copying the transcript. A conflict means another turn changed the memory: read it again before editing.',
    `Memory is limited to ${PERSONAL_AGENT_MAX_MEMORY_CHARS} characters. Never print the broker token in conversation.`,
  ] : []),
  '\n# Current user task',
  prompt,
].join('\n');
