export type AIRoleColor = "primary" | "secondary" | "success" | "warning" | "danger";

export interface AIRole {
  id: string;
  name: string;
  systemPrompt: string;
  color: AIRoleColor;
  icon: string;
}

export interface AIRoleDraft {
  name: string;
  systemPrompt: string;
}

export const defaultAIRoles: AIRole[] = [
  {
    id: "default",
    name: "Assistant",
    systemPrompt: "You are a helpful, creative, friendly assistant. Respond concisely and clearly.",
    color: "secondary",
    icon: "lucide:bot",
  },
  {
    id: "a2ui-demo",
    name: "A2UI Demo",
    systemPrompt: "You are an A2UI streaming demo assistant. If the latest user message is exactly HI, hi, or Hi, call the A2UI UI tool immediately to create a compact demo surface using the official basic catalog, including layout, status text, tabs or grouped sections, at least one input control such as ChoicePicker/TextField/Slider, and one primary action button. Continue with a short text answer while the UI updates stream. Do not print raw UI JSON.",
    color: "warning",
    icon: "lucide:layout-dashboard",
  },
  {
    id: "coder",
    name: "Code Expert",
    systemPrompt: "You are a programming expert who provides detailed technical solutions and code examples. Focus on best practices and performance.",
    color: "primary",
    icon: "lucide:code",
  },
  {
    id: "creative",
    name: "Creative Writer",
    systemPrompt: "You are a creative writing assistant with a vivid imagination. Help users with storytelling and creative content.",
    color: "success",
    icon: "lucide:pen",
  },
];

const AI_ROLES_KEY = "aiRoles";
const AI_ROLES_DEFAULT_VERSION_KEY = "aiRolesDefaultVersion";
const CURRENT_DEFAULT_ROLE_VERSION = "2026-06-a2ui-demo";

const getApiBaseUrl = () => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL;
  return !socketUrl || socketUrl === "/" ? "" : socketUrl.replace(/\/$/, "");
};

const getClientIdForApi = () => {
  const existing = localStorage.getItem('clientId');
  if (existing) {
    return existing;
  }

  const generated = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem('clientId', generated);
  return generated;
};

const getClientAuthTokenForApi = () => {
  const token = localStorage.getItem('clientAuthToken')?.trim();
  return token || undefined;
};

const defaultRoleKeys: Record<string, { nameKey: string; promptKey: string }> = {
  default: { nameKey: "roleAssistantName", promptKey: "roleAssistantPrompt" },
  "a2ui-demo": { nameKey: "roleA2UIDemoName", promptKey: "roleA2UIDemoPrompt" },
  coder: { nameKey: "roleCodeExpertName", promptKey: "roleCodeExpertPrompt" },
  creative: { nameKey: "roleCreativeWriterName", promptKey: "roleCreativeWriterPrompt" },
};

export const getAIRoleDisplayName = (role: AIRole, t: (key: string) => string) => {
  const roleKeys = defaultRoleKeys[role.id];
  return roleKeys ? t(roleKeys.nameKey) : role.name;
};

export const getAIRoleDisplayPrompt = (role: AIRole, t: (key: string) => string) => {
  const roleKeys = defaultRoleKeys[role.id];
  return roleKeys ? t(roleKeys.promptKey) : role.systemPrompt;
};

export const getSavedAIRoles = (): AIRole[] => {
  try {
    const saved = localStorage.getItem(AI_ROLES_KEY);
    if (!saved) {
      return defaultAIRoles;
    }

    const roles = JSON.parse(saved);
    if (!Array.isArray(roles)) {
      return defaultAIRoles;
    }

    const defaultVersion = localStorage.getItem(AI_ROLES_DEFAULT_VERSION_KEY);
    if (defaultVersion === CURRENT_DEFAULT_ROLE_VERSION) {
      return roles;
    }

    const roleIds = new Set(roles.map(role => role?.id));
    const migratedRoles = [
      ...roles,
      ...defaultAIRoles.filter(role => !roleIds.has(role.id)),
    ];
    localStorage.setItem(AI_ROLES_KEY, JSON.stringify(migratedRoles));
    localStorage.setItem(AI_ROLES_DEFAULT_VERSION_KEY, CURRENT_DEFAULT_ROLE_VERSION);
    return migratedRoles;
  } catch (e) {
    console.error("Error loading AI roles:", e);
    return defaultAIRoles;
  }
};

export const saveAIRoles = (roles: AIRole[]) => {
  try {
    localStorage.setItem(AI_ROLES_KEY, JSON.stringify(roles));
    localStorage.setItem(AI_ROLES_DEFAULT_VERSION_KEY, CURRENT_DEFAULT_ROLE_VERSION);
  } catch (e) {
    console.error("Error saving AI roles:", e);
  }
};

export const addAIRole = (roles: AIRole[], role: AIRole) => [...roles, role];

export const updateAIRole = (roles: AIRole[], updatedRole: AIRole) => {
  return roles.map(role => role.id === updatedRole.id ? updatedRole : role);
};

export const getSelectedAIRole = (roles: AIRole[], selectedRoleId: string) => {
  return roles.find(role => role.id === selectedRoleId) || roles[0] || defaultAIRoles[0];
};

export const deleteAIRole = (
  roles: AIRole[],
  roleId: string,
  selectedRoleId: string
): { roles: AIRole[]; selectedRoleId: string } => {
  if (roles.length <= 1) {
    return { roles, selectedRoleId };
  }

  const updatedRoles = roles.filter(role => role.id !== roleId);
  return {
    roles: updatedRoles,
    selectedRoleId: roleId === selectedRoleId ? updatedRoles[0].id : selectedRoleId,
  };
};

export const generateAIRoleDraft = async (idea: string): Promise<AIRoleDraft> => {
  const clientAuthToken = getClientAuthTokenForApi();
  const response = await fetch(`${getApiBaseUrl()}/api/ai-role-draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idea,
      clientId: getClientIdForApi(),
      clientAuthToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to generate AI role draft: ${response.status}`);
  }

  const draft = await response.json() as Partial<AIRoleDraft>;
  if (!draft.name || !draft.systemPrompt) {
    throw new Error("AI role draft response is invalid");
  }

  return { name: draft.name, systemPrompt: draft.systemPrompt };
};
