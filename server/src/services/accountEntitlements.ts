export type MembershipTier = 'free' | 'pro' | 'priority';
export type MembershipStatus = 'active' | 'past_due' | 'cancelled';
export type SchedulingTier = 'guest' | MembershipTier;
export type AccountCreditState = 'none' | 'available' | 'exhausted';

export interface AccountEntitlement {
  accountId?: string;
  tier: SchedulingTier;
  status: MembershipStatus;
  effectiveTier: SchedulingTier;
  creditBalanceUsd: number;
  lifetimeUsageUsd: number;
  creditState: Exclude<AccountCreditState, 'none'>;
  queuePriority: number;
  creditUnlimited?: boolean;
  monthlyCreditAllowanceUsd?: number;
  monthlyCreditRemainingUsd?: number;
  monthlyCreditPeriodStart?: string;
  monthlyCreditPeriodEnd?: string;
  priorityOverride?: number;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  externalProvider?: string;
  updatedAt: string;
}

export interface AssistantRunSchedulingSnapshot {
  accountId?: string;
  membershipTier: SchedulingTier;
  creditState: AccountCreditState;
  queuePriority: number;
}

export const BULLMQ_MAX_PRIORITY = 2_097_152;
export const FREE_MONTHLY_CREDIT_USD = 5;
export const MONTHLY_CREDIT_USD: Record<MembershipTier, number> = { free: 5, pro: 20, priority: 50 };
export const CREDIT_OVERDRAFT_LIMIT_USD = 5;

export const getAIModelAccessError = (
  entitlement: Pick<AccountEntitlement, 'effectiveTier' | 'creditBalanceUsd' | 'creditUnlimited'> | null,
  model: { id: string; apiModel?: string; pricing?: { inputPerMillion: number } },
): string | undefined => {
  if (entitlement?.creditUnlimited) return;
  if (!entitlement) return 'AI credits are temporarily unavailable';
  const membersOnly = /(?:gpt-6-astra|claude-fable)/.test(`${model.id} ${model.apiModel || ''}`);
  if (membersOnly && entitlement.effectiveTier !== 'pro' && entitlement.effectiveTier !== 'priority') {
    return 'This model requires an active Pro or Priority membership';
  }
  if (entitlement.creditBalanceUsd <= -CREDIT_OVERDRAFT_LIMIT_USD) {
    return 'AI credits have reached the -$5 limit. Wait for monthly credits or add credits';
  }
  if (entitlement.creditBalanceUsd <= 0
    && !(typeof model.pricing?.inputPerMillion === 'number' && model.pricing.inputPerMillion < 1)) {
    return 'Credits are exhausted. Choose a model with input pricing below $1 per million tokens';
  }
};

const PRIORITY_POLICY: Record<SchedulingTier, {
  available: number;
  exhausted: number;
}> = {
  guest: { available: 100, exhausted: 100 },
  free: { available: 60, exhausted: 80 },
  pro: { available: 20, exhausted: 40 },
  priority: { available: 1, exhausted: 10 },
};

export const normalizeQueuePriority = (value: number): number => (
  Math.min(BULLMQ_MAX_PRIORITY, Math.max(1, Math.floor(value)))
);

export const resolveEffectiveMembershipTier = (
  tier: MembershipTier,
  status: MembershipStatus,
): MembershipTier => status === 'active' ? tier : 'free';

export const resolveAssistantRunScheduling = (input?: {
  accountId?: string;
  tier: SchedulingTier;
  status: MembershipStatus;
  creditBalanceUsd: number;
  priorityOverride?: number;
  creditUnlimited?: boolean;
} | null): AssistantRunSchedulingSnapshot => {
  if (!input) {
    return {
      membershipTier: 'guest',
      creditState: 'none',
      queuePriority: PRIORITY_POLICY.guest.exhausted,
    };
  }

  if (input.creditUnlimited) {
    return {
      accountId: input.accountId,
      membershipTier: 'priority',
      creditState: 'available',
      queuePriority: PRIORITY_POLICY.priority.available,
    };
  }

  const membershipTier = input.tier === 'guest' ? 'guest' : resolveEffectiveMembershipTier(input.tier, input.status);
  const creditState = input.creditBalanceUsd > 0 ? 'available' : 'exhausted';
  const configuredPriority = input.priorityOverride !== undefined
    ? normalizeQueuePriority(input.priorityOverride)
    : PRIORITY_POLICY[membershipTier][creditState];

  return {
    ...(input.accountId ? { accountId: input.accountId } : {}),
    membershipTier,
    creditState,
    queuePriority: configuredPriority,
  };
};
