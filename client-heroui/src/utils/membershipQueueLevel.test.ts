import { describe, expect, it } from 'vitest';
import { getMembershipQueueLevel } from './membershipQueueLevel';

describe('getMembershipQueueLevel', () => {
  it.each([
    [1, 'highest'],
    [2, 'high'],
    [20, 'high'],
    [21, 'standard'],
    [60, 'standard'],
    [61, 'low'],
    [99, 'low'],
    [100, 'lowest'],
  ] as const)('maps queue priority %s to %s', (priority, level) => {
    expect(getMembershipQueueLevel(priority)).toBe(level);
  });

  it('falls back to the lowest level for invalid priorities', () => {
    expect(getMembershipQueueLevel(0)).toBe('lowest');
    expect(getMembershipQueueLevel(Number.NaN)).toBe('lowest');
    expect(getMembershipQueueLevel(Number.POSITIVE_INFINITY)).toBe('lowest');
  });
});
