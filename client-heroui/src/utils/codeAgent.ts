import { FeatureFlags } from './features';
import { CodeAgentBackend, CodeAgentMode, Room, RoomCocoStatus } from './types';
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

export const CODE_AGENT_BACKEND_OPTIONS = ['coco', 'codex', 'codex-app-server'] as const satisfies readonly CodeAgentBackend[];
const CODE_AGENT_BACKENDS = new Set<CodeAgentBackend>(CODE_AGENT_BACKEND_OPTIONS);

const runtimeRoomType = (room: Room | null | undefined): string | undefined => (
  room?.type as string | undefined
);

const storedCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => (
  room?.codeAgentBackend && CODE_AGENT_BACKENDS.has(room.codeAgentBackend) ? room.codeAgentBackend : null
);

export const getCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => {
  const roomType = runtimeRoomType(room);
  if (roomType === 'coco') {
    return storedCodeAgentBackend(room) || 'coco';
  }
  if (roomType === 'codex') {
    return storedCodeAgentBackend(room) || 'codex';
  }
  return null;
};

export const isCodeAgentRoom = (room: Room | null | undefined): boolean => (
  getCodeAgentBackend(room) !== null
);

export const getCodeAgentMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  normalizeCodeAgentMode(featureFlags.coco.mode)
);

export const getCodeAgentAvailableModes = (featureFlags: FeatureFlags): CodeAgentMode[] => (
  normalizeCodeAgentModeList(featureFlags.coco.availableModes)
);

export const getCodeAgentDefaultMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  getCodeAgentAvailableModes(featureFlags).includes(normalizeCodeAgentMode(featureFlags.coco.defaultMode))
    ? normalizeCodeAgentMode(featureFlags.coco.defaultMode)
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
  return backend === 'codex' ? 'codeAgentEngineCodex' : 'codeAgentEngineCoco';
};

export const getCodeAgentStatus = (room: Room | null | undefined): RoomCocoStatus | undefined => (
  getCodeAgentBackend(room) !== null ? (room?.cocoStatus || 'idle') : undefined
);
