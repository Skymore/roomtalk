import { useMemo, useState } from 'react';
import {
  addAIRole,
  AIRole,
  deleteAIRole,
  defaultAIRoles,
  getSavedAIRoles,
  getSelectedAIRole,
  saveAIRoles,
  updateAIRole,
} from '../utils/aiRoles';

export const useAIRoles = () => {
  const [{ aiRoles, selectedRoleId }, setRoleState] = useState(() => {
    const roles = getSavedAIRoles();
    return {
      aiRoles: roles,
      selectedRoleId: getSelectedAIRole(roles, defaultAIRoles[0].id).id,
    };
  });

  const selectedRole = useMemo(
    () => getSelectedAIRole(aiRoles, selectedRoleId),
    [aiRoles, selectedRoleId]
  );

  const handleRoleChange = (roleId: string) => {
    setRoleState(current => ({ ...current, selectedRoleId: roleId }));
  };

  const handleAddRole = (newRole: AIRole) => {
    const updatedRoles = addAIRole(aiRoles, newRole);
    saveAIRoles(updatedRoles);
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
