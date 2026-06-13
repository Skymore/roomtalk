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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const pickString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value : undefined
);

const dynamicBindingFromTemplate = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const match = value.trim().match(/^\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*)\s*\}\}$/);
  if (!match) {
    return value;
  }

  const path = `/${match[1]
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(part => part.replace(/~/g, '~0').replace(/\//g, '~1'))
    .join('/')}`;
  return { path };
};

const normalizeChildren = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .map(child => typeof child === 'string' ? child : isRecord(child) ? pickString(child.id) : undefined)
      .filter((child): child is string => Boolean(child));
  }

  if (
    isRecord(value) &&
    typeof value.componentId === 'string' &&
    typeof value.path === 'string'
  ) {
    return {
      componentId: value.componentId,
      path: value.path,
    };
  }

  return [];
};

const normalizeAction = (componentId: string, action: unknown) => (
  isRecord(action)
    ? action
    : {
        event: {
          name: 'a2ui_component_action',
          context: { componentId },
        },
      }
);

const ICON_NAME_ALIASES: Record<string, string> = {
  check_circle: 'check',
  checkCircle: 'check',
  info_outline: 'info',
  play_arrow: 'play',
};

const normalizeComponent = (
  input: unknown,
): { component: Record<string, unknown>; extraComponents: Record<string, unknown>[] } | null => {
  if (!isRecord(input) || typeof input.id !== 'string') {
    return null;
  }

  let componentName = pickString(input.component) || pickString(input.type);
  if (componentName === 'MultipleChoice') {
    componentName = 'ChoicePicker';
  }
  if (!componentName) {
    return null;
  }

  const base = { id: input.id, component: componentName };
  const extraComponents: Record<string, unknown>[] = [];
  const normalizeDynamic = (value: unknown) => dynamicBindingFromTemplate(value);
  const normalizeString = (value: unknown, fallback = '') => normalizeDynamic(value ?? fallback);
  const normalizeBoolean = (value: unknown, fallback = false) => (
    typeof value === 'boolean' || isRecord(value) ? value : normalizeDynamic(value ?? fallback)
  );
  const normalizeNumber = (value: unknown, fallback = 0) => (
    typeof value === 'number' || isRecord(value) ? value : normalizeDynamic(value ?? fallback)
  );

  switch (componentName) {
    case 'Text':
      return {
        component: {
          ...base,
          text: normalizeString(input.text ?? input.content ?? input.label),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
        },
        extraComponents,
      };
    case 'Image':
      return {
        component: {
          ...base,
          url: normalizeString(input.url),
          ...(input.description !== undefined ? { description: normalizeString(input.description) } : {}),
          ...(typeof input.fit === 'string' ? { fit: input.fit } : {}),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
        },
        extraComponents,
      };
    case 'Icon': {
      const iconName = pickString(input.name) || pickString(input.icon) || 'info';
      return {
        component: {
          ...base,
          name: ICON_NAME_ALIASES[iconName] || iconName,
        },
        extraComponents,
      };
    }
    case 'Video':
      return { component: { ...base, url: normalizeString(input.url) }, extraComponents };
    case 'AudioPlayer':
      return {
        component: {
          ...base,
          url: normalizeString(input.url),
          ...(input.description !== undefined ? { description: normalizeString(input.description) } : {}),
        },
        extraComponents,
      };
    case 'Row':
    case 'Column':
      return {
        component: {
          ...base,
          children: normalizeChildren(input.children),
          ...(typeof input.align === 'string' ? { align: input.align } : {}),
          ...(typeof input.alignment === 'string' ? { align: input.alignment } : {}),
          ...(typeof input.justify === 'string' ? { justify: input.justify } : {}),
          ...(typeof input.distribution === 'string' ? { justify: input.distribution } : {}),
        },
        extraComponents,
      };
    case 'List':
      return {
        component: {
          ...base,
          children: normalizeChildren(input.children),
          ...(typeof input.direction === 'string' ? { direction: input.direction } : {}),
          ...(typeof input.align === 'string' ? { align: input.align } : {}),
        },
        extraComponents,
      };
    case 'Card': {
      const children = normalizeChildren(input.children);
      const child = pickString(input.child) || (Array.isArray(children) ? children[0] : undefined);
      return {
        component: { ...base, child: child || `${input.id}_content` },
        extraComponents: child ? extraComponents : [{ id: `${input.id}_content`, component: 'Text', text: '' }],
      };
    }
    case 'Tabs':
      return {
        component: {
          ...base,
          tabs: Array.isArray(input.tabs)
            ? input.tabs
                .filter(isRecord)
                .map(tab => ({
                  title: normalizeString(tab.title),
                  child: pickString(tab.child) || '',
                }))
                .filter(tab => tab.child)
            : [],
        },
        extraComponents,
      };
    case 'Modal':
      return {
        component: {
          ...base,
          trigger: pickString(input.trigger) || '',
          content: pickString(input.content) || '',
        },
        extraComponents,
      };
    case 'Divider':
      return {
        component: {
          ...base,
          ...(typeof input.axis === 'string' ? { axis: input.axis } : {}),
        },
        extraComponents,
      };
    case 'Button': {
      let child = pickString(input.child);
      if (!child) {
        child = `${input.id}_label`;
        extraComponents.push({
          id: child,
          component: 'Text',
          text: normalizeString(input.label ?? input.text ?? input.content ?? 'Continue'),
        });
      }

      return {
        component: {
          ...base,
          child,
          action: normalizeAction(input.id, input.action),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
        },
        extraComponents,
      };
    }
    case 'TextField':
      return {
        component: {
          ...base,
          label: normalizeString(input.label),
          ...(input.value !== undefined ? { value: normalizeString(input.value) } : {}),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
          ...(typeof input.validationRegexp === 'string' ? { validationRegexp: input.validationRegexp } : {}),
        },
        extraComponents,
      };
    case 'CheckBox':
      return {
        component: {
          ...base,
          label: normalizeString(input.label),
          value: normalizeBoolean(input.value ?? input.checked),
        },
        extraComponents,
      };
    case 'ChoicePicker':
      return {
        component: {
          ...base,
          ...(input.label !== undefined ? { label: normalizeString(input.label) } : {}),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
          options: Array.isArray(input.options)
            ? input.options
                .filter(isRecord)
                .map(option => ({
                  label: normalizeString(option.label),
                  value: pickString(option.value) || String(option.label ?? ''),
                }))
            : [],
          value: Array.isArray(input.value)
            ? input.value.filter((item): item is string => typeof item === 'string')
            : normalizeDynamic(input.value ?? []),
          ...(typeof input.displayStyle === 'string' ? { displayStyle: input.displayStyle } : {}),
          ...(typeof input.filterable === 'boolean' ? { filterable: input.filterable } : {}),
        },
        extraComponents,
      };
    case 'Slider':
      return {
        component: {
          ...base,
          ...(input.label !== undefined ? { label: normalizeString(input.label) } : {}),
          ...(input.min !== undefined ? { min: normalizeNumber(input.min) } : {}),
          max: normalizeNumber(input.max, 100),
          value: normalizeNumber(input.value),
        },
        extraComponents,
      };
    case 'DateTimeInput':
      return {
        component: {
          ...base,
          value: normalizeString(input.value),
          ...(typeof input.enableDate === 'boolean' ? { enableDate: input.enableDate } : {}),
          ...(typeof input.enableTime === 'boolean' ? { enableTime: input.enableTime } : {}),
          ...(input.min !== undefined ? { min: normalizeString(input.min) } : {}),
          ...(input.max !== undefined ? { max: normalizeString(input.max) } : {}),
          ...(input.label !== undefined ? { label: normalizeString(input.label) } : {}),
        },
        extraComponents,
      };
    default:
      return { component: { ...input, component: componentName }, extraComponents };
  }
};

const normalizeComponentMessages = (components: unknown) => {
  if (!Array.isArray(components)) {
    return components;
  }

  const normalized: Record<string, unknown>[] = [];
  for (const component of components) {
    const result = normalizeComponent(component);
    if (result) {
      normalized.push(result.component, ...result.extraComponents);
    }
  }
  return normalized;
};

const normalizeA2UIAliases = (value: unknown): unknown => {
  const normalizeMessage = (message: unknown): unknown => {
    if (!isRecord(message)) {
      return message;
    }

    if (isRecord(message.updateDataModel)) {
      const updateDataModel = { ...message.updateDataModel };
      if (!('value' in updateDataModel) && 'data' in updateDataModel) {
        updateDataModel.value = updateDataModel.data;
        updateDataModel.path ||= '/';
        delete updateDataModel.data;
      }
      return { ...message, updateDataModel };
    }

    if (isRecord(message.updateComponents)) {
      return {
        ...message,
        updateComponents: {
          ...message.updateComponents,
          components: normalizeComponentMessages(message.updateComponents.components),
        },
      };
    }

    return message;
  };

  if (Array.isArray(value)) {
    return value.map(normalizeMessage);
  }

  if (isRecord(value) && Array.isArray(value.messages)) {
    return {
      ...value,
      messages: value.messages.map(normalizeMessage),
    };
  }

  return value;
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

  const normalizedValue = normalizeA2UIAliases(value);
  const wrapperResult = A2uiMessageListWrapperSchema.safeParse(normalizedValue);
  const listResult = wrapperResult.success
    ? { success: true as const, data: wrapperResult.data.messages }
    : A2uiMessageListSchema.safeParse(normalizedValue);

  if (!listResult.success || !isWithinTransportLimits(listResult.data)) {
    return null;
  }

  return {
    format: 'a2ui',
    version: A2UI_VERSION,
    messages: listResult.data,
  };
};
