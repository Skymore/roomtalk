import { normalizeCodeAgentMode, normalizeCodeAgentModeList } from './codeAgentModes';
import type { CodeAgentMode } from './types';

export interface FeatureFlags {
  codeAgent: {
    enabled: boolean;
    mode: CodeAgentMode;
    availableModes: CodeAgentMode[];
    defaultMode: CodeAgentMode;
    rollout?: 'disabled' | 'allowlist' | 'all';
    reason?: string;
  };
  codex: {
    connections: {
      enabled: boolean;
    };
  };
}

export const FALLBACK_FEATURE_FLAGS: FeatureFlags = {
  codeAgent: { enabled: false, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan', rollout: 'disabled' },
  codex: { connections: { enabled: false } },
};

const getApiBaseUrl = () => {
  const socketUrl = import.meta.env.VITE_SOCKET_URL;

  if (!socketUrl || socketUrl === '/') {
    return '';
  }

  return socketUrl.replace(/\/$/, '');
};

export const fetchFeatureFlags = async (clientId: string): Promise<FeatureFlags> => {
  const query = new URLSearchParams({ clientId });
  const response = await fetch(`${getApiBaseUrl()}/api/features?${query.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to load feature flags: ${response.status}`);
  }

  const data = await response.json();
  if (typeof data?.codeAgent?.enabled !== 'boolean') {
    throw new Error('Feature flag response is invalid');
  }
  const codeAgentMode = normalizeCodeAgentMode(data.codeAgent.mode);
  const normalizedAvailableModes = normalizeCodeAgentModeList(
    Array.isArray(data.codeAgent.availableModes) ? data.codeAgent.availableModes : [codeAgentMode]
  );
  const defaultMode = normalizeCodeAgentMode(data.codeAgent.defaultMode);

  return {
    codeAgent: {
      enabled: data.codeAgent.enabled,
      mode: codeAgentMode,
      availableModes: normalizedAvailableModes,
      defaultMode: normalizedAvailableModes.includes(defaultMode) ? defaultMode : 'plan',
      rollout: data.codeAgent.rollout,
      reason: data.codeAgent.reason,
    },
    codex: {
      connections: {
        enabled: data?.codex?.connections?.enabled === true,
      },
    },
  };
};
