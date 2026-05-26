import { FeatureFlags } from './features';
import { Room, RoomCocoStatus } from './types';

export type CodeAgentBackend = 'coco' | 'codex';
export type CodeAgentMode = FeatureFlags['coco']['mode'];

const runtimeRoomType = (room: Room | null | undefined): string | undefined => (
  room?.type as string | undefined
);

export const getCodeAgentBackend = (room: Room | null | undefined): CodeAgentBackend | null => {
  const roomType = runtimeRoomType(room);
  if (roomType === 'coco') {
    return 'coco';
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

export const isSupportedCodeAgentBackend = (backend: CodeAgentBackend | null): boolean => (
  backend === 'coco'
);

export const getCodeAgentStatus = (room: Room | null | undefined): RoomCocoStatus | undefined => (
  getCodeAgentBackend(room) === 'coco' ? (room?.cocoStatus || 'idle') : undefined
);
