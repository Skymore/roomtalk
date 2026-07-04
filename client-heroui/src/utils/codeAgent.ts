import { FeatureFlags } from './features';
import { CodeAgentBackend, CodeAgentMode, Room, RoomCocoStatus } from './types';

export type { CodeAgentBackend, CodeAgentMode } from './types';

export const CODE_AGENT_BACKEND_OPTIONS = ['coco', 'codex', 'codex-app-server'] as const satisfies readonly CodeAgentBackend[];

const runtimeRoomType = (room: Room | null | undefined): string | undefined => (
  room?.type as string | undefined
);

export const getCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => {
  const roomType = runtimeRoomType(room);
  if (roomType === 'coco') {
    return room?.codeAgentBackend || 'coco';
  }
  if (roomType === 'codex') {
    return 'codex';
  }
  return null;
};

export const isCodeAgentRoom = (room: Room | null | undefined): boolean => (
  getCodeAgentBackend(room) !== null
);

export const getCodeAgentMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  featureFlags.coco.mode
);

export const getCodeAgentAvailableModes = (featureFlags: FeatureFlags): CodeAgentMode[] => (
  featureFlags.coco.availableModes?.length ? featureFlags.coco.availableModes : ['plan']
);

export const getCodeAgentDefaultMode = (featureFlags: FeatureFlags): CodeAgentMode => (
  featureFlags.coco.availableModes.includes(featureFlags.coco.defaultMode)
    ? featureFlags.coco.defaultMode
    : 'plan'
);

export const isSupportedCodeAgentBackend = (backend: CodeAgentBackend | null): boolean => (
  backend === 'coco' || backend === 'codex' || backend === 'codex-app-server'
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
