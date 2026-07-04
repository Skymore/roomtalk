export const CODE_AGENT_CANONICAL_MODES = [
  'plan',
  'edit',
  'approveForMe',
  'fullAccess',
] as const;

export type CanonicalCodeAgentMode = typeof CODE_AGENT_CANONICAL_MODES[number];
export type LegacyCodeAgentMode = 'acceptEdits';
export type CodeAgentModeValue = CanonicalCodeAgentMode | LegacyCodeAgentMode;

const LEGACY_MODE_ALIASES: Record<string, CanonicalCodeAgentMode> = {
  acceptEdits: 'edit',
};

const CODE_AGENT_MODE_RANK: Record<CanonicalCodeAgentMode, number> = {
  plan: 0,
  edit: 1,
  approveForMe: 2,
  fullAccess: 3,
};

const CODE_AGENT_MODE_LABEL_KEYS: Record<CanonicalCodeAgentMode, string> = {
  plan: 'codexPermissionPlan',
  edit: 'codexPermissionEdit',
  approveForMe: 'codexPermissionApproveForMe',
  fullAccess: 'codexPermissionFullAccess',
};

const CODE_AGENT_MODE_DESCRIPTION_KEYS: Record<CanonicalCodeAgentMode, string> = {
  plan: 'codexPermissionPlanDescription',
  edit: 'codexPermissionEditDescription',
  approveForMe: 'codexPermissionApproveForMeDescription',
  fullAccess: 'codexPermissionFullAccessDescription',
};

const CODE_AGENT_MODE_ICONS: Record<CanonicalCodeAgentMode, string> = {
  plan: 'lucide:eye',
  edit: 'lucide:pencil-ruler',
  approveForMe: 'lucide:check-check',
  fullAccess: 'lucide:shield-alert',
};

export const normalizeCodeAgentMode = (value: unknown): CanonicalCodeAgentMode => {
  if (typeof value === 'string') {
    if ((CODE_AGENT_CANONICAL_MODES as readonly string[]).includes(value)) {
      return value as CanonicalCodeAgentMode;
    }
    if (LEGACY_MODE_ALIASES[value]) {
      return LEGACY_MODE_ALIASES[value];
    }
  }
  return 'plan';
};

export const codeAgentModeRank = (mode: CodeAgentModeValue): number => (
  CODE_AGENT_MODE_RANK[normalizeCodeAgentMode(mode)]
);

export const normalizeCodeAgentModeList = (modes?: readonly unknown[]): CanonicalCodeAgentMode[] => {
  const normalized = (modes || [])
    .map(normalizeCodeAgentMode)
    .filter((mode): mode is CanonicalCodeAgentMode => Boolean(mode));

  if (!normalized.length) {
    return ['plan'];
  }

  const highestRank = normalized.reduce((rank, mode) => Math.max(rank, CODE_AGENT_MODE_RANK[mode]), 0);
  return CODE_AGENT_CANONICAL_MODES.filter(mode => CODE_AGENT_MODE_RANK[mode] <= highestRank);
};

export const getHighestCodeAgentMode = (modes: readonly CodeAgentModeValue[]): CanonicalCodeAgentMode => (
  normalizeCodeAgentModeList(modes).at(-1) || 'plan'
);

export const getCodeAgentModeLabelKey = (mode: CodeAgentModeValue): string => (
  CODE_AGENT_MODE_LABEL_KEYS[normalizeCodeAgentMode(mode)]
);

export const getCodeAgentModeDescriptionKey = (mode: CodeAgentModeValue): string => (
  CODE_AGENT_MODE_DESCRIPTION_KEYS[normalizeCodeAgentMode(mode)]
);

export const getCodeAgentModeIcon = (mode: CodeAgentModeValue): string => (
  CODE_AGENT_MODE_ICONS[normalizeCodeAgentMode(mode)]
);
