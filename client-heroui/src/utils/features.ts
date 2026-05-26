export interface FeatureFlags {
  coco: {
    enabled: boolean;
    mode: 'plan' | 'acceptEdits';
    rollout?: 'disabled' | 'allowlist' | 'all';
    reason?: string;
  };
}

export const FALLBACK_FEATURE_FLAGS: FeatureFlags = {
  coco: { enabled: false, mode: 'plan', rollout: 'disabled' },
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
  if (typeof data?.coco?.enabled !== 'boolean') {
    throw new Error('Feature flag response is invalid');
  }
  const cocoMode = data.coco.mode === 'acceptEdits' ? 'acceptEdits' : 'plan';

  return {
    coco: {
      enabled: data.coco.enabled,
      mode: cocoMode,
      rollout: data.coco.rollout,
      reason: data.coco.reason,
    },
  };
};
