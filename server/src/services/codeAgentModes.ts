import { CodeAgentMode } from '../types';

export const CODE_AGENT_CANONICAL_MODES = [
  'plan',
  'edit',
  'approveForMe',
  'fullAccess',
] as const;

export type CanonicalCodeAgentMode = typeof CODE_AGENT_CANONICAL_MODES[number];

const LEGACY_MODE_ALIASES: Record<string, CanonicalCodeAgentMode> = {
  acceptEdits: 'edit',
};

const CODE_AGENT_MODE_RANK: Record<CanonicalCodeAgentMode, number> = {
  plan: 0,
  edit: 1,
  approveForMe: 2,
  fullAccess: 3,
};

export const normalizeCodeAgentMode = (value: unknown): CanonicalCodeAgentMode | null => {
  if (typeof value !== 'string') {
    return null;
  }
  if ((CODE_AGENT_CANONICAL_MODES as readonly string[]).includes(value)) {
    return value as CanonicalCodeAgentMode;
  }
  return LEGACY_MODE_ALIASES[value] || null;
};

export const isCodeAgentMode = (value: unknown): value is CodeAgentMode => (
  normalizeCodeAgentMode(value) !== null
);

export const codeAgentModeRank = (mode: CodeAgentMode): number => (
  CODE_AGENT_MODE_RANK[normalizeCodeAgentMode(mode) || 'plan']
);

export const normalizeCodeAgentModeSet = (values: readonly unknown[]): CanonicalCodeAgentMode[] => {
  const normalized = values
    .map(normalizeCodeAgentMode)
    .filter((mode): mode is CanonicalCodeAgentMode => Boolean(mode));

  if (!normalized.length) {
    return ['plan'];
  }

  const highestRank = normalized.reduce((rank, mode) => Math.max(rank, CODE_AGENT_MODE_RANK[mode]), 0);
  return CODE_AGENT_CANONICAL_MODES.filter(mode => CODE_AGENT_MODE_RANK[mode] <= highestRank);
};

export const highestCodeAgentMode = (modes: readonly CodeAgentMode[]): CanonicalCodeAgentMode => (
  normalizeCodeAgentModeSet(modes).at(-1) || 'plan'
);

export const codeAgentModeAllowsWriteTools = (mode: CodeAgentMode): boolean => (
  codeAgentModeRank(mode) >= CODE_AGENT_MODE_RANK.edit
);

export const codeAgentModeAllowsShell = (mode: CodeAgentMode): boolean => (
  codeAgentModeRank(mode) >= CODE_AGENT_MODE_RANK.edit
);

export const codeAgentModeAllowsStaticPublish = (mode: CodeAgentMode): boolean => (
  codeAgentModeRank(mode) >= CODE_AGENT_MODE_RANK.fullAccess
);
