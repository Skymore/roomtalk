import { apiPath, clientId, withClientAuthBody } from './socket';

export type PushNotificationStatus =
  | 'unsupported'
  | 'ios-install-required'
  | 'server-disabled'
  | 'default'
  | 'denied'
  | 'subscribed'
  | 'unsubscribed';

type PushPublicKeyResponse = {
  enabled: boolean;
  publicKey: string;
};

const serviceWorkerPath = '/sw.js';
const IOS_DEVICE_PATTERN = /iPad|iPhone|iPod/;

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
};

export const isPushNotificationSupported = () => (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window
);

export const isIOSDevice = () => (
  typeof navigator !== 'undefined' &&
  (IOS_DEVICE_PATTERN.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
);

export const isStandaloneWebApp = () => (
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
);

export const getPushPublicKey = async (): Promise<PushPublicKeyResponse> => {
  const response = await fetch(apiPath('/api/push/vapid-public-key'), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Failed to load push notification configuration');
  }
  return response.json() as Promise<PushPublicKeyResponse>;
};

const getServiceWorkerRegistration = async () => {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing || navigator.serviceWorker.register(serviceWorkerPath);
};

export const getPushNotificationStatus = async (): Promise<PushNotificationStatus> => {
  if (isIOSDevice() && !isStandaloneWebApp()) {
    return 'ios-install-required';
  }

  if (!isPushNotificationSupported()) {
    return 'unsupported';
  }

  const publicKey = await getPushPublicKey();
  if (!publicKey.enabled) {
    return 'server-disabled';
  }

  if (Notification.permission === 'denied') {
    return 'denied';
  }

  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    return 'subscribed';
  }

  return Notification.permission === 'default' ? 'default' : 'unsubscribed';
};

export const enablePushNotifications = async () => {
  if (!isPushNotificationSupported()) {
    throw new Error('Push notifications are not supported in this browser');
  }

  const publicKey = await getPushPublicKey();
  if (!publicKey.enabled || !publicKey.publicKey) {
    throw new Error('Push notifications are not enabled on this server');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }

  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription()
    || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey.publicKey),
    });

  const response = await fetch(apiPath('/api/push/subscriptions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withClientAuthBody({
      clientId,
      subscription,
      userAgent: navigator.userAgent,
    })),
  });
  if (!response.ok) {
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error('Failed to save push notification subscription');
  }
};

export const disablePushNotifications = async () => {
  if (!isPushNotificationSupported()) {
    return;
  }

  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }

  await fetch(apiPath('/api/push/subscriptions'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withClientAuthBody({
      clientId,
      endpoint: subscription.endpoint,
    })),
  }).catch(() => undefined);
  await subscription.unsubscribe();
};
