import { FeatureFlags } from './features';
import { CodeAgentBackend, CodeAgentMode, Room, RoomCodeAgentStatus } from './types';
import {
  normalizeCodeAgentMode,
  normalizeCodeAgentModeList,
} from './codeAgentModes';

export type { CodeAgentBackend, CodeAgentMode } from './types';
export {
  getCodeAgentModeDescriptionKey,
  getCodeAgentModeIcon,
  getCodeAgentModeLabelKey,
  getHighestCodeAgentMode,
  normalizeCodeAgentMode,
  normalizeCodeAgentModeList,
} from './codeAgentModes';

export const CODE_AGENT_BACKEND_OPTIONS = [
  'code-agent',
  'codex-app-server',
  'opencode',
  'hermes-agent',
] as const satisfies readonly CodeAgentBackend[];
const CODE_AGENT_BACKENDS = new Set<CodeAgentBackend>([
  'code-agent',
  'codex',
  'codex-app-server',
  'opencode',
  'hermes-agent',
]);

export const getCodeAgentAssistantDisplayName = (username: string | null | undefined): string | undefined => {
  const trimmed = username?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed === 'CodexApp' ? 'Codex' : trimmed;
};

const runtimeRoomType = (room: Room | null | undefined): string | undefined => (
  room?.type as string | undefined
);

const storedCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => (
  room?.codeAgentBackend && CODE_AGENT_BACKENDS.has(room.codeAgentBackend) ? room.codeAgentBackend : null
);

export const getCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => {
  const roomType = runtimeRoomType(room);
  if (roomType === 'codeAgent') {
    return storedCodeAgentBackend(room) || 'code-agent';
  }
  if (roomType === 'codex') {
    return storedCodeAgentBackend(room) || 'codex-app-server';
  }
  return null;
};

export const isCodeAgentRoom = (room: Room | null | undefined): boolean => (
  getCodeAgentBackend(room) !== null
);

export const getCodeAgentMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  normalizeCodeAgentMode(featureFlags.codeAgent.mode)
);

export const getCodeAgentAvailableModes = (featureFlags: FeatureFlags): CodeAgentMode[] => (
  normalizeCodeAgentModeList(featureFlags.codeAgent.availableModes)
);

export const getCodeAgentAvailableBackends = (featureFlags: FeatureFlags): CodeAgentBackend[] => {
  const available = featureFlags.codeAgent.availableBackends.filter(backend => (
    CODE_AGENT_BACKENDS.has(backend)
  ));
  return available.length ? Array.from(new Set(available)) : ['code-agent'];
};

export const getVisibleCodeAgentBackendOptions = (
  availableBackends: readonly CodeAgentBackend[],
  currentBackend?: CodeAgentBackend | null,
): CodeAgentBackend[] => {
  const selectable = CODE_AGENT_BACKEND_OPTIONS.filter(backend => availableBackends.includes(backend));
  return currentBackend === 'codex' && availableBackends.includes('codex')
    ? ['codex', ...selectable]
    : selectable;
};

export const getCodeAgentDefaultMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  getCodeAgentAvailableModes(featureFlags).includes(normalizeCodeAgentMode(featureFlags.codeAgent.defaultMode))
    ? normalizeCodeAgentMode(featureFlags.codeAgent.defaultMode)
    : 'plan'
);

export const isSupportedCodeAgentBackend = (backend: CodeAgentBackend | null): boolean => (
  backend !== null && CODE_AGENT_BACKENDS.has(backend)
);

export const isCodexCodeAgentBackend = (backend: CodeAgentBackend | null | undefined): boolean => (
  backend === 'codex' || backend === 'codex-app-server'
);

export const getCodeAgentBackendLabelKey = (backend: CodeAgentBackend): string => {
  switch (backend) {
    case 'codex-app-server':
      return 'codeAgentEngineCodexAppServer';
    case 'codex':
      return 'codeAgentEngineCodex';
    case 'opencode':
      return 'codeAgentEngineOpenCode';
    case 'hermes-agent':
      return 'codeAgentEngineHermesAgent';
    case 'code-agent':
      return 'codeAgentEngineCodeAgent';
  }
};

export const getCodeAgentStatus = (room: Room | null | undefined): RoomCodeAgentStatus | undefined => (
  getCodeAgentBackend(room) !== null ? (room?.codeAgentStatus || 'idle') : undefined
);
