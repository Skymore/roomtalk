import { getSavedAIRoles, getSelectedAIRole } from './aiRoles';
import { defaultRoomAISettings, getStoredRoomAISettings } from './aiSettings';

export interface AIRequestSettings {
  systemPrompt: string;
  roleName: string;
  model?: string;
  maxContextMessages: number;
}

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
