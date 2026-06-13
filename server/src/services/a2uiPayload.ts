import { A2UIPayload } from '../types';

export const A2UI_VERSION: A2UIPayload['version'] = 'v0.9';
export const A2UI_BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

const MAX_A2UI_MESSAGES = 200;
const MAX_A2UI_PAYLOAD_BYTES = 128 * 1024;

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

type A2UIWebCoreV09 = {
  A2uiMessageListSchema: {
    safeParse(value: unknown): SafeParseResult<unknown[]>;
  };
  A2uiMessageListWrapperSchema: {
    safeParse(value: unknown): SafeParseResult<{ messages: unknown[] }>;
  };
};

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;
let webCorePromise: Promise<A2UIWebCoreV09> | null = null;

const getA2UIWebCore = () => {
  if (!webCorePromise) {
    webCorePromise = dynamicImport<A2UIWebCoreV09>('@a2ui/web_core/v0_9');
  }
  return webCorePromise;
};

const isWithinTransportLimits = (messages: unknown[]) => {
  if (messages.length === 0 || messages.length > MAX_A2UI_MESSAGES) {
    return false;
  }

  try {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8') <= MAX_A2UI_PAYLOAD_BYTES;
  } catch {
    return false;
  }
};

export const mergeA2UIPayloads = (
  current: A2UIPayload | undefined,
  incoming: A2UIPayload,
): A2UIPayload => {
  if (!current || current.format !== incoming.format || current.version !== incoming.version) {
    return incoming;
  }

  return {
    ...current,
    messages: [...current.messages, ...incoming.messages],
  };
};

export const normalizeA2UIPayload = async (value: unknown): Promise<A2UIPayload | null> => {
  const { A2uiMessageListSchema, A2uiMessageListWrapperSchema } = await getA2UIWebCore();

  const wrapperResult = A2uiMessageListWrapperSchema.safeParse(value);
  const listResult = wrapperResult.success
    ? { success: true as const, data: wrapperResult.data.messages }
    : A2uiMessageListSchema.safeParse(value);

  if (!listResult.success || !isWithinTransportLimits(listResult.data)) {
    return null;
  }

  return {
    format: 'a2ui',
    version: A2UI_VERSION,
    messages: listResult.data,
  };
};
