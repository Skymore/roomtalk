import { normalizeCodeAgentMode, normalizeCodeAgentModeList } from './codeAgentModes';
import type { CodeAgentBackend, CodeAgentMode } from './types';

const CODE_AGENT_BACKENDS = new Set<CodeAgentBackend>([
  'code-agent',
  'codex',
  'codex-app-server',
  'opencode',
  'hermes-agent',
]);

const normalizeCodeAgentBackends = (value: unknown): CodeAgentBackend[] => {
  if (!Array.isArray(value)) return ['code-agent'];
  const normalized = Array.from(new Set(value.filter(
    (backend): backend is CodeAgentBackend => typeof backend === 'string' && CODE_AGENT_BACKENDS.has(backend as CodeAgentBackend)
  )));
  return normalized.length ? normalized : ['code-agent'];
};

export interface FeatureFlags {
  codeAgent: {
    enabled: boolean;
    mode: CodeAgentMode;
    availableModes: CodeAgentMode[];
    defaultMode: CodeAgentMode;
    availableBackends: CodeAgentBackend[];
    rollout?: 'disabled' | 'allowlist' | 'all';
    reason?: string;
  };
  codex: {
    connections: {
      enabled: boolean;
    };
  };
  github: {
    connections: {
      enabled: boolean;
    };
  };
}

export const FALLBACK_FEATURE_FLAGS: FeatureFlags = {
  codeAgent: {
    enabled: false,
    mode: 'plan',
    availableModes: ['plan'],
    defaultMode: 'plan',
    availableBackends: ['code-agent'],
    rollout: 'disabled',
  },
  codex: { connections: { enabled: false } },
  github: { connections: { enabled: false } },
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
      availableBackends: normalizeCodeAgentBackends(data.codeAgent.availableBackends),
      rollout: data.codeAgent.rollout,
      reason: data.codeAgent.reason,
    },
    codex: {
      connections: {
        enabled: data?.codex?.connections?.enabled === true,
      },
    },
    github: {
      connections: {
        enabled: data?.github?.connections?.enabled === true,
      },
    },
  };
};
