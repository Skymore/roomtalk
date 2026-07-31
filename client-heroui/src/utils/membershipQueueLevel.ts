export type MembershipQueueLevel = 'highest' | 'high' | 'standard' | 'low' | 'lowest';

export const MEMBERSHIP_QUEUE_LEVEL_LABEL_KEYS: Record<MembershipQueueLevel, string> = {
  highest: 'membershipQueueLevelHighest',
  high: 'membershipQueueLevelHigh',
  standard: 'membershipQueueLevelStandard',
  low: 'membershipQueueLevelLow',
  lowest: 'membershipQueueLevelLowest',
};

export const getMembershipQueueLevel = (queuePriority: number): MembershipQueueLevel => {
  if (!Number.isFinite(queuePriority) || queuePriority < 1) return 'lowest';
  if (queuePriority <= 1) return 'highest';
  if (queuePriority <= 20) return 'high';
  if (queuePriority <= 60) return 'standard';
  if (queuePriority <= 99) return 'low';
  return 'lowest';
};
