// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({
  apiPath: (path: string) => path,
  clientId: 'client-1',
  withClientAuthBody: (body: Record<string, unknown>) => body,
}));

const setNavigatorValue = (key: keyof Navigator, value: unknown) => {
  Object.defineProperty(navigator, key, {
    value,
    configurable: true,
  });
};

const setStandaloneMode = (matches: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    configurable: true,
  });
};

describe('push notification platform detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setNavigatorValue('userAgent', 'Mozilla/5.0');
    setNavigatorValue('platform', 'MacIntel');
    setNavigatorValue('maxTouchPoints', 0);
    setStandaloneMode(false);
    delete (window as any).PushManager;
    delete (window as any).Notification;
  });

  it('requires iOS users to install the Home Screen web app before enabling push', async () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    setNavigatorValue('platform', 'iPhone');
    setNavigatorValue('maxTouchPoints', 5);

    const { getPushNotificationStatus } = await import('./pushNotifications');

    await expect(getPushNotificationStatus()).resolves.toBe('ios-install-required');
  });

  it('continues to run normal support detection once iOS is standalone', async () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    setNavigatorValue('platform', 'iPhone');
    setNavigatorValue('maxTouchPoints', 5);
    setStandaloneMode(true);

    const { getPushNotificationStatus } = await import('./pushNotifications');

    await expect(getPushNotificationStatus()).resolves.toBe('unsupported');
  });

});
