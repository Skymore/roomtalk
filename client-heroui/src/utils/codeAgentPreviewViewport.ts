export const CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

export const CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS = [
  'iphone-se',
  'iphone-xr',
  'iphone-12-pro',
  'iphone-14-pro-max',
  'pixel-7',
  'samsung-galaxy-s8-plus',
  'samsung-galaxy-s20-ultra',
  'ipad-mini',
  'ipad-air',
  'ipad-pro',
  'surface-pro-7',
  'surface-duo',
  'galaxy-z-fold-5',
  'asus-zenbook-fold',
  'samsung-galaxy-a51-71',
  'nest-hub',
  'nest-hub-max',
] as const;

export type CodeAgentPreviewViewportPresetId =
  typeof CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS[number];

export interface CodeAgentPreviewViewportPreset {
  readonly id: CodeAgentPreviewViewportPresetId;
  readonly label: string;
  readonly category: 'Desktop' | 'Tablet' | 'Phone';
  readonly detail: string;
  readonly width: number;
  readonly height: number;
}

export type CodeAgentPreviewViewportSetting =
  | { readonly _tag: 'fill' }
  | {
    readonly _tag: 'freeform';
    readonly width: number;
    readonly height: number;
  }
  | {
    readonly _tag: 'preset';
    readonly width: number;
    readonly height: number;
    readonly presetId: CodeAgentPreviewViewportPresetId;
  };

export type CodeAgentPreviewViewportSize = {
  readonly width: number;
  readonly height: number;
};

export type CodeAgentPreviewViewportResizeInput =
  | { readonly mode: 'fill' }
  | {
    readonly mode: 'freeform';
    readonly width: number;
    readonly height: number;
  }
  | {
    readonly mode: 'preset';
    readonly preset: CodeAgentPreviewViewportPresetId;
    readonly orientation?: 'portrait' | 'landscape';
  };

type CodeAgentPreviewViewportPresetDefinition = Omit<
  CodeAgentPreviewViewportPreset,
  'id'
>;

export const FILL_CODE_AGENT_PREVIEW_VIEWPORT = {
  _tag: 'fill',
} as const satisfies CodeAgentPreviewViewportSetting;

const CODE_AGENT_PREVIEW_VIEWPORT_PRESET_DEFINITIONS = {
  'iphone-se': {
    label: 'iPhone SE',
    category: 'Phone',
    detail: '375 × 667',
    width: 375,
    height: 667,
  },
  'iphone-xr': {
    label: 'iPhone XR',
    category: 'Phone',
    detail: '414 × 896',
    width: 414,
    height: 896,
  },
  'iphone-12-pro': {
    label: 'iPhone 12 Pro',
    category: 'Phone',
    detail: '390 × 844',
    width: 390,
    height: 844,
  },
  'iphone-14-pro-max': {
    label: 'iPhone 14 Pro Max',
    category: 'Phone',
    detail: '430 × 932',
    width: 430,
    height: 932,
  },
  'pixel-7': {
    label: 'Pixel 7',
    category: 'Phone',
    detail: '412 × 915',
    width: 412,
    height: 915,
  },
  'samsung-galaxy-s8-plus': {
    label: 'Samsung Galaxy S8+',
    category: 'Phone',
    detail: '360 × 740',
    width: 360,
    height: 740,
  },
  'samsung-galaxy-s20-ultra': {
    label: 'Samsung Galaxy S20 Ultra',
    category: 'Phone',
    detail: '412 × 915',
    width: 412,
    height: 915,
  },
  'ipad-mini': {
    label: 'iPad Mini',
    category: 'Tablet',
    detail: '768 × 1024',
    width: 768,
    height: 1024,
  },
  'ipad-air': {
    label: 'iPad Air',
    category: 'Tablet',
    detail: '820 × 1180',
    width: 820,
    height: 1180,
  },
  'ipad-pro': {
    label: 'iPad Pro',
    category: 'Tablet',
    detail: '1024 × 1366',
    width: 1024,
    height: 1366,
  },
  'surface-pro-7': {
    label: 'Surface Pro 7',
    category: 'Tablet',
    detail: '912 × 1368',
    width: 912,
    height: 1368,
  },
  'surface-duo': {
    label: 'Surface Duo',
    category: 'Phone',
    detail: '540 × 720',
    width: 540,
    height: 720,
  },
  'galaxy-z-fold-5': {
    label: 'Galaxy Z Fold 5',
    category: 'Phone',
    detail: '344 × 882',
    width: 344,
    height: 882,
  },
  'asus-zenbook-fold': {
    label: 'Asus Zenbook Fold',
    category: 'Tablet',
    detail: '853 × 1280',
    width: 853,
    height: 1280,
  },
  'samsung-galaxy-a51-71': {
    label: 'Samsung Galaxy A51/71',
    category: 'Phone',
    detail: '412 × 914',
    width: 412,
    height: 914,
  },
  'nest-hub': {
    label: 'Nest Hub',
    category: 'Tablet',
    detail: '1024 × 600',
    width: 1024,
    height: 600,
  },
  'nest-hub-max': {
    label: 'Nest Hub Max',
    category: 'Tablet',
    detail: '1280 × 800',
    width: 1280,
    height: 800,
  },
} as const satisfies Record<
  CodeAgentPreviewViewportPresetId,
  CodeAgentPreviewViewportPresetDefinition
>;

export const CODE_AGENT_PREVIEW_VIEWPORT_PRESETS:
  readonly CodeAgentPreviewViewportPreset[] =
    CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS.map((id) => ({
      id,
      ...CODE_AGENT_PREVIEW_VIEWPORT_PRESET_DEFINITIONS[id],
    }));

export function normalizeCodeAgentPreviewViewportDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION;
  }
  return Math.min(
    CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION,
    Math.max(CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION, Math.round(value)),
  );
}

export function normalizeCodeAgentPreviewViewportSize(
  size: CodeAgentPreviewViewportSize,
): CodeAgentPreviewViewportSize {
  let width = normalizeCodeAgentPreviewViewportDimension(size.width);
  let height = normalizeCodeAgentPreviewViewportDimension(size.height);
  if (width * height <= CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA) {
    return { width, height };
  }
  if (width >= height) {
    width = Math.max(
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / height),
    );
  } else {
    height = Math.max(
      CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
      Math.floor(CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA / width),
    );
  }
  return { width, height };
}

export function resolveCodeAgentPreviewViewport(
  input: CodeAgentPreviewViewportResizeInput,
): CodeAgentPreviewViewportSetting {
  if (input.mode === 'fill') {
    return FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  }
  if (input.mode === 'preset') {
    const preset = CODE_AGENT_PREVIEW_VIEWPORT_PRESETS.find(
      (candidate) => candidate.id === input.preset,
    );
    if (!preset) {
      throw new Error(`Unknown preview viewport preset: ${input.preset}`);
    }
    const landscape = input.orientation === 'landscape';
    const portrait = input.orientation === 'portrait';
    const nativePortrait = preset.height >= preset.width;
    const shouldSwap = (landscape && nativePortrait) || (portrait && !nativePortrait);
    return {
      _tag: 'preset',
      width: shouldSwap ? preset.height : preset.width,
      height: shouldSwap ? preset.width : preset.height,
      presetId: preset.id,
    };
  }
  return {
    _tag: 'freeform',
    ...normalizeCodeAgentPreviewViewportSize({
      width: input.width,
      height: input.height,
    }),
  };
}

export function codeAgentPreviewViewportLabel(
  viewport: CodeAgentPreviewViewportSetting,
): string {
  return viewport._tag === 'fill' ? 'Fill panel' : `${viewport.width} × ${viewport.height}`;
}

export function codeAgentPreviewViewportPresetOrientation(
  viewport: CodeAgentPreviewViewportSetting,
): 'portrait' | 'landscape' | null {
  if (viewport._tag === 'fill' || viewport.width === viewport.height) {
    return null;
  }
  return viewport.width > viewport.height ? 'landscape' : 'portrait';
}

export function coerceCodeAgentPreviewViewportSetting(
  value: unknown,
): CodeAgentPreviewViewportSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const viewport = value as Partial<CodeAgentPreviewViewportSetting>;
  if (viewport._tag === 'fill') {
    return FILL_CODE_AGENT_PREVIEW_VIEWPORT;
  }
  if (
    viewport._tag === 'preset' &&
    typeof viewport.width === 'number' &&
    typeof viewport.height === 'number' &&
    typeof viewport.presetId === 'string' &&
    CODE_AGENT_PREVIEW_VIEWPORT_PRESET_IDS.includes(
      viewport.presetId as CodeAgentPreviewViewportPresetId,
    )
  ) {
    const size = normalizeCodeAgentPreviewViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    return { _tag: 'preset', presetId: viewport.presetId, ...size };
  }
  if (
    viewport._tag === 'freeform' &&
    typeof viewport.width === 'number' &&
    typeof viewport.height === 'number'
  ) {
    return {
      _tag: 'freeform',
      ...normalizeCodeAgentPreviewViewportSize({
        width: viewport.width,
        height: viewport.height,
      }),
    };
  }
  return null;
}
