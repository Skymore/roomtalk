import {
  DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
  normalizeAIContextMessageLimit,
} from './aiContext';

const ROOM_AI_SETTINGS_PREFIX = 'roomtalk:ai-settings:';

export interface RoomAISettings {
  selectedRoleId: string;
  selectedModel: string;
  maxContextMessages: number;
}

export const defaultRoomAISettings = (defaultModel = ''): RoomAISettings => ({
  selectedRoleId: 'default',
  selectedModel: defaultModel,
  maxContextMessages: DEFAULT_AI_CONTEXT_MESSAGE_LIMIT,
});

const storageKeyForRoom = (roomId: string) => `${ROOM_AI_SETTINGS_PREFIX}${roomId}`;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const normalizeRoomAISettings = (
  value: unknown,
  fallback: RoomAISettings = defaultRoomAISettings(),
): RoomAISettings => {
  const input = isRecord(value) ? value : {};
  return {
    selectedRoleId: typeof input.selectedRoleId === 'string' && input.selectedRoleId.trim()
      ? input.selectedRoleId
      : fallback.selectedRoleId,
    selectedModel: typeof input.selectedModel === 'string' && input.selectedModel.trim()
      ? input.selectedModel
      : fallback.selectedModel,
    maxContextMessages: normalizeAIContextMessageLimit(input.maxContextMessages, fallback.maxContextMessages),
  };
};

export const getStoredRoomAISettings = (
  roomId: string,
  fallback: RoomAISettings = defaultRoomAISettings(),
): RoomAISettings => {
  try {
    const raw = localStorage.getItem(storageKeyForRoom(roomId));
    if (!raw) {
      return fallback;
    }
    return normalizeRoomAISettings(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
};

export const saveRoomAISettings = (roomId: string, settings: RoomAISettings): void => {
  try {
    localStorage.setItem(storageKeyForRoom(roomId), JSON.stringify(normalizeRoomAISettings(settings)));
  } catch {
    // Storage can fail in private browsing or restricted contexts.
  }
};

export const updateStoredRoomAISettings = (
  roomId: string,
  updates: Partial<RoomAISettings>,
  fallback: RoomAISettings = defaultRoomAISettings(),
): RoomAISettings => {
  const next = normalizeRoomAISettings({
    ...getStoredRoomAISettings(roomId, fallback),
    ...updates,
  }, fallback);
  saveRoomAISettings(roomId, next);
  return next;
};
