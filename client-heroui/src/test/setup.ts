type JsdomGlobal = typeof globalThis & {
  jsdom?: {
    window: Window;
  };
};

const createStorageMock = (): Storage => {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
};

const browserWindow = (globalThis as JsdomGlobal).jsdom?.window;

const testLocalStorage = browserWindow?.localStorage ?? createStorageMock();
const testSessionStorage = browserWindow?.sessionStorage ?? createStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  enumerable: true,
  value: testLocalStorage,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  enumerable: true,
  value: testSessionStorage,
});
