import { getSavedAIRoles, getSelectedAIRole } from './aiRoles';
import { defaultRoomAISettings, getStoredRoomAISettings } from './aiSettings';

export interface AIRequestSettings {
  systemPrompt: string;
  roleName: string;
  model?: string;
  maxContextMessages: number;
}

export interface AIModelContextRequestSettings {
  model?: string;
  maxContextMessages: number;
}

export type AIRequestRoomKind = 'chat' | 'coco';
export type RoomAIRequestSettings = AIRequestSettings | AIModelContextRequestSettings;

export const getRoomAIRequestSettings = (
  roomId: string,
  defaultModel = '',
): AIRequestSettings => {
  const settings = getStoredRoomAISettings(roomId, defaultRoomAISettings(defaultModel));
  const selectedRole = getSelectedAIRole(getSavedAIRoles(), settings.selectedRoleId);
  return {
    systemPrompt: selectedRole.systemPrompt,
    roleName: selectedRole.name,
    model: settings.selectedModel || undefined,
    maxContextMessages: settings.maxContextMessages,
  };
};

export function selectRoomAIRequestSettings(settings: AIRequestSettings, roomKind: 'chat'): AIRequestSettings;
export function selectRoomAIRequestSettings(settings: AIRequestSettings, roomKind: 'coco'): AIModelContextRequestSettings;
export function selectRoomAIRequestSettings(settings: AIRequestSettings, roomKind: AIRequestRoomKind): RoomAIRequestSettings;
export function selectRoomAIRequestSettings(
  settings: AIRequestSettings,
  roomKind: AIRequestRoomKind,
): RoomAIRequestSettings {
  if (roomKind === 'coco') {
    return {
      model: settings.model,
      maxContextMessages: settings.maxContextMessages,
    };
  }

  return settings;
}

export function getRoomAIRequestSettingsForKind(roomId: string, roomKind: 'chat', defaultModel?: string): AIRequestSettings;
export function getRoomAIRequestSettingsForKind(roomId: string, roomKind: 'coco', defaultModel?: string): AIModelContextRequestSettings;
export function getRoomAIRequestSettingsForKind(roomId: string, roomKind: AIRequestRoomKind, defaultModel?: string): RoomAIRequestSettings;
export function getRoomAIRequestSettingsForKind(
  roomId: string,
  roomKind: AIRequestRoomKind,
  defaultModel = '',
): RoomAIRequestSettings {
  return selectRoomAIRequestSettings(getRoomAIRequestSettings(roomId, defaultModel), roomKind);
}
