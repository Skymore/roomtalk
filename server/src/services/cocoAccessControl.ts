export interface CocoAccessControlOptions {
  enabled: boolean;
  allowedClientIds?: string[];
}

export type CocoAccessDenyReason = 'disabled' | 'missing_client_id' | 'not_allowed';

export interface CocoAccessResult {
  allowed: boolean;
  reason?: CocoAccessDenyReason;
  message?: string;
}

export interface CocoAccessControl {
  readonly enabled: boolean;
  readonly hasAllowlist: boolean;
  canUse(clientId?: string | null): CocoAccessResult;
  toFeaturePayload(clientId?: string | null): {
    enabled: boolean;
    rollout: 'disabled' | 'allowlist' | 'all';
    reason?: CocoAccessDenyReason;
  };
}

export const createCocoAccessControl = (options: CocoAccessControlOptions): CocoAccessControl => {
  const allowedClientIds = options.allowedClientIds || [];
  const hasAllowlist = allowedClientIds.length > 0;

  const canUse = (clientId?: string | null): CocoAccessResult => {
    if (!options.enabled) {
      return { allowed: false, reason: 'disabled', message: 'Coco is disabled' };
    }
    if (!hasAllowlist) {
      return { allowed: true };
    }
    if (!clientId) {
      return { allowed: false, reason: 'missing_client_id', message: 'Coco requires a registered client' };
    }
    if (!allowedClientIds.includes(clientId)) {
      return { allowed: false, reason: 'not_allowed', message: 'Coco is not enabled for this user' };
    }
    return { allowed: true };
  };

  return {
    enabled: options.enabled,
    hasAllowlist,
    canUse,
    toFeaturePayload(clientId?: string | null) {
      const access = canUse(clientId);
      return {
        enabled: access.allowed,
        rollout: !options.enabled ? 'disabled' : hasAllowlist ? 'allowlist' : 'all',
        ...(access.reason ? { reason: access.reason } : {}),
      };
    },
  };
};
