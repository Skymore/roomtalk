export interface CodeAgentAccessControlOptions {
  enabled: boolean;
  allowedClientIds?: string[];
}

export type CodeAgentAccessDenyReason = 'disabled' | 'missing_client_id' | 'not_allowed';

export interface CodeAgentAccessResult {
  allowed: boolean;
  reason?: CodeAgentAccessDenyReason;
  message?: string;
}

export interface CodeAgentAccessControl {
  readonly enabled: boolean;
  readonly hasAllowlist: boolean;
  canUse(clientId?: string | null): CodeAgentAccessResult;
  toFeaturePayload(clientId?: string | null): {
    enabled: boolean;
    rollout: 'disabled' | 'allowlist' | 'all';
    reason?: CodeAgentAccessDenyReason;
  };
}

export const createCodeAgentAccessControl = (options: CodeAgentAccessControlOptions): CodeAgentAccessControl => {
  const allowedClientIds = options.allowedClientIds || [];
  const hasAllowlist = allowedClientIds.length > 0;

  const canUse = (clientId?: string | null): CodeAgentAccessResult => {
    if (!options.enabled) {
      return { allowed: false, reason: 'disabled', message: 'Code agent is disabled' };
    }
    if (!hasAllowlist) {
      return { allowed: true };
    }
    if (!clientId) {
      return { allowed: false, reason: 'missing_client_id', message: 'Code agent requires a registered client' };
    }
    if (!allowedClientIds.includes(clientId)) {
      return { allowed: false, reason: 'not_allowed', message: 'Code agent is not enabled for this user' };
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
