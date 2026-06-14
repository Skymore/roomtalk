import { useEffect, useMemo, useState } from 'react';
import {
  addAIRole,
  AIRole,
  deleteAIRole,
  getSavedAIRoles,
  getSelectedAIRole,
  saveAIRoles,
  updateAIRole,
} from '../utils/aiRoles';
import { getStoredRoomAISettings, updateStoredRoomAISettings } from '../utils/aiSettings';

const roleStateForRoom = (roomId: string) => {
  const roles = getSavedAIRoles();
  const settings = getStoredRoomAISettings(roomId);
  const selectedRole = getSelectedAIRole(roles, settings.selectedRoleId);
  return {
    aiRoles: roles,
    selectedRoleId: selectedRole.id,
  };
};

export const useAIRoles = (roomId: string) => {
  const [{ aiRoles, selectedRoleId }, setRoleState] = useState(() => {
    return roleStateForRoom(roomId);
  });

  useEffect(() => {
    setRoleState(roleStateForRoom(roomId));
  }, [roomId]);

  const selectedRole = useMemo(
    () => getSelectedAIRole(aiRoles, selectedRoleId),
    [aiRoles, selectedRoleId]
  );

  const handleRoleChange = (roleId: string) => {
    setRoleState(current => {
      const nextRole = getSelectedAIRole(current.aiRoles, roleId);
      updateStoredRoomAISettings(roomId, { selectedRoleId: nextRole.id });
      return { ...current, selectedRoleId: nextRole.id };
    });
  };

  const handleAddRole = (newRole: AIRole) => {
    const updatedRoles = addAIRole(aiRoles, newRole);
    saveAIRoles(updatedRoles);
    updateStoredRoomAISettings(roomId, { selectedRoleId: newRole.id });
    setRoleState({ aiRoles: updatedRoles, selectedRoleId: newRole.id });
  };

  const handleUpdateRole = (updatedRole: AIRole) => {
    const updatedRoles = updateAIRole(aiRoles, updatedRole);
    saveAIRoles(updatedRoles);
    setRoleState(current => ({ ...current, aiRoles: updatedRoles }));
  };

  const handleDeleteRole = (roleId: string) => {
    const { roles: updatedRoles, selectedRoleId: nextSelectedRoleId } = deleteAIRole(aiRoles, roleId, selectedRoleId);
    saveAIRoles(updatedRoles);
    updateStoredRoomAISettings(roomId, { selectedRoleId: nextSelectedRoleId });
    setRoleState({ aiRoles: updatedRoles, selectedRoleId: nextSelectedRoleId });
  };

  return {
    aiRoles,
    selectedRoleId,
    selectedRole,
    handleRoleChange,
    handleAddRole,
    handleUpdateRole,
    handleDeleteRole,
  };
};
