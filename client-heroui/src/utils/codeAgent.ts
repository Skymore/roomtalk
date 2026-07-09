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

export const CODE_AGENT_BACKEND_OPTIONS = ['code-agent', 'codex-app-server'] as const satisfies readonly CodeAgentBackend[];
const CODE_AGENT_BACKENDS = new Set<CodeAgentBackend>(['code-agent', 'codex', 'codex-app-server']);

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
  if (backend === 'codex-app-server') {
    return 'codeAgentEngineCodexAppServer';
  }
  return backend === 'codex' ? 'codeAgentEngineCodex' : 'codeAgentEngineCodeAgent';
};

export const getCodeAgentStatus = (room: Room | null | undefined): RoomCodeAgentStatus | undefined => (
  getCodeAgentBackend(room) !== null ? (room?.codeAgentStatus || 'idle') : undefined
);
