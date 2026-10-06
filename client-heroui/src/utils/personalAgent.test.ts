// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPersonalAgent, runPersonalAgentGoal, updatePersonalAgentGoal } from './personalAgent';

describe('personalAgent API', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('passes the account credential on private reads and goal mutations', async () => {
    localStorage.setItem('clientAuthToken', 'account-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ goal: { id: 'goal-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    await getPersonalAgent('client-1');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/personal-agent?clientId=client-1');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Client-Id': 'client-1', 'X-Client-Auth-Token': 'account-token' });
    await updatePersonalAgentGoal('client-1', 'goal-1', { enabled: false });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ clientId: 'client-1', enabled: false }) });
    await runPersonalAgentGoal('client-1', 'goal-1');
    expect(fetchMock.mock.calls[2][0]).toContain('/api/personal-agent/goals/goal-1/run');
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
  });

  it('preserves an account sign-in error status for the guest UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Sign in required' }) }));
    await expect(getPersonalAgent('guest-1')).rejects.toMatchObject({ message: 'Sign in required', status: 401 });
  });
});
