const CACHE_OWNER_FALLBACK = 'anonymous';

let persistenceRequest: Promise<boolean> | null = null;

export const getBrowserCacheOwnerId = () => {
  try {
    return localStorage.getItem('clientId')?.trim() || CACHE_OWNER_FALLBACK;
  } catch {
    return CACHE_OWNER_FALLBACK;
  }
};

export const getOwnedBrowserCacheName = (baseName: string, ownerId = getBrowserCacheOwnerId()) => (
  `${baseName}:${encodeURIComponent(ownerId)}`
);

export const ensurePersistentBrowserStorage = (): Promise<boolean> => {
  if (persistenceRequest) return persistenceRequest;
  persistenceRequest = (async () => {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist) return false;
    try {
      if (await storage.persisted?.()) return true;
      return await storage.persist();
    } catch {
      return false;
    }
  })();
  return persistenceRequest;
};

export const getBrowserStorageQuota = async (): Promise<number | null> => {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage?.estimate) return null;
  try {
    const estimate = await storage.estimate();
    return typeof estimate.quota === 'number' && Number.isFinite(estimate.quota)
      ? estimate.quota
      : null;
  } catch {
    return null;
  }
};
