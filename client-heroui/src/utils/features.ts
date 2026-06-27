export interface FeatureFlags {
  coco: {
    enabled: boolean;
    mode: 'plan' | 'acceptEdits';
    availableModes: Array<'plan' | 'acceptEdits'>;
    defaultMode: 'plan' | 'acceptEdits';
    rollout?: 'disabled' | 'allowlist' | 'all';
    reason?: string;
  };
}

export const FALLBACK_FEATURE_FLAGS: FeatureFlags = {
  coco: { enabled: false, mode: 'plan', availableModes: ['plan'], defaultMode: 'plan', rollout: 'disabled' },
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
  const parseMode = (value: unknown): 'plan' | 'acceptEdits' => (
    value === 'acceptEdits' ? 'acceptEdits' : 'plan'
  );
  const cocoMode = parseMode(data.coco.mode);
  const availableModes: Array<'plan' | 'acceptEdits'> = Array.isArray(data.coco.availableModes)
    ? Array.from(new Set(data.coco.availableModes.map(parseMode) as Array<'plan' | 'acceptEdits'>))
    : (cocoMode === 'acceptEdits' ? ['plan', 'acceptEdits'] : ['plan']);
  const normalizedAvailableModes: Array<'plan' | 'acceptEdits'> = availableModes.includes('acceptEdits') && !availableModes.includes('plan')
    ? ['plan', ...availableModes]
    : availableModes;
  const defaultMode = parseMode(data.coco.defaultMode);

  return {
    coco: {
      enabled: data.coco.enabled,
      mode: cocoMode,
      availableModes: normalizedAvailableModes,
      defaultMode: normalizedAvailableModes.includes(defaultMode) ? defaultMode : 'plan',
      rollout: data.coco.rollout,
      reason: data.coco.reason,
    },
  };
};
