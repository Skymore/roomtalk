export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexPermissionMode = 'plan' | 'edit' | 'approveForMe' | 'fullAccess';
export type CodexServiceTier = 'default' | 'priority';

export interface CodexRunSettings {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  permissionMode: CodexPermissionMode;
  serviceTier: CodexServiceTier;
}

export interface CodexModelOption {
  id: string;
  label: string;
  supportsFast: boolean;
}

export interface CodexReasoningOption {
  id: CodexReasoningEffort;
  labelKey: string;
}

export interface CodexPermissionOption {
  id: CodexPermissionMode;
  labelKey: string;
  descriptionKey: string;
  icon: string;
}

export interface CodexSpeedOption {
  id: CodexServiceTier;
  labelKey: string;
  descriptionKey: string;
}

const ROOM_CODEX_SETTINGS_PREFIX = 'roomtalk:codex-settings:';
const CODEX_SETTINGS_SCHEMA_VERSION = 3;
const LEGACY_DEFAULT_CODEX_MODEL = 'gpt-5.5';
const LEGACY_DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'xhigh';

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'high';
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'edit';
export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = 'default';

export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', supportsFast: true },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', supportsFast: true },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', supportsFast: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', supportsFast: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', supportsFast: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', supportsFast: false },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', supportsFast: false },
];

export const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  { id: 'low', labelKey: 'codexReasoningLight' },
  { id: 'medium', labelKey: 'codexReasoningMedium' },
  { id: 'high', labelKey: 'codexReasoningHigh' },
  { id: 'xhigh', labelKey: 'codexReasoningExtraHigh' },
];

export const CODEX_SPEED_OPTIONS: CodexSpeedOption[] = [
  { id: 'default', labelKey: 'codexSpeedStandard', descriptionKey: 'codexSpeedStandardDescription' },
  { id: 'priority', labelKey: 'codexSpeedFast', descriptionKey: 'codexSpeedFastDescription' },
];

export const CODEX_PERMISSION_OPTIONS: CodexPermissionOption[] = [
  {
    id: 'plan',
    labelKey: 'codexPermissionPlan',
    descriptionKey: 'codexPermissionPlanDescription',
    icon: 'lucide:eye',
  },
  {
    id: 'edit',
    labelKey: 'codexPermissionEdit',
    descriptionKey: 'codexPermissionEditDescription',
    icon: 'lucide:pencil-ruler',
  },
  {
    id: 'approveForMe',
    labelKey: 'codexPermissionApproveForMe',
    descriptionKey: 'codexPermissionApproveForMeDescription',
    icon: 'lucide:check-check',
  },
  {
    id: 'fullAccess',
    labelKey: 'codexPermissionFullAccess',
    descriptionKey: 'codexPermissionFullAccessDescription',
    icon: 'lucide:shield-alert',
  },
];

const CODEX_MODEL_IDS = new Set(CODEX_MODEL_OPTIONS.map(option => option.id));
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(CODEX_REASONING_OPTIONS.map(option => option.id));
const CODEX_PERMISSION_MODES = new Set<CodexPermissionMode>(CODEX_PERMISSION_OPTIONS.map(option => option.id));
const CODEX_SERVICE_TIERS = new Set<CodexServiceTier>(CODEX_SPEED_OPTIONS.map(option => option.id));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeCodexReasoningEffort = (value: unknown): CodexReasoningEffort => {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value;
  }
  return DEFAULT_CODEX_REASONING_EFFORT;
};

const normalizeCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'plan' || value === 'edit' || value === 'approveForMe' || value === 'fullAccess') {
    return value;
  }
  return DEFAULT_CODEX_PERMISSION_MODE;
};

export const codexModelLabel = (modelId: string): string => (
  CODEX_MODEL_OPTIONS.find(option => option.id === modelId)?.label
  || CODEX_MODEL_OPTIONS.find(option => option.id === DEFAULT_CODEX_MODEL)?.label
  || DEFAULT_CODEX_MODEL
);

export const codexReasoningLabelKey = (effort: CodexReasoningEffort): string => (
  CODEX_REASONING_OPTIONS.find(option => option.id === effort)?.labelKey
  || CODEX_REASONING_OPTIONS.find(option => option.id === DEFAULT_CODEX_REASONING_EFFORT)?.labelKey
  || 'codexReasoningExtraHigh'
);

export const codexPermissionLabelKey = (mode: CodexPermissionMode): string => (
  CODEX_PERMISSION_OPTIONS.find(option => option.id === mode)?.labelKey
  || CODEX_PERMISSION_OPTIONS.find(option => option.id === DEFAULT_CODEX_PERMISSION_MODE)?.labelKey
  || 'codexPermissionEdit'
);

export const defaultCodexRunSettings = (): CodexRunSettings => ({
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
  serviceTier: DEFAULT_CODEX_SERVICE_TIER,
});

export const normalizeCodexRunSettings = (
  value: unknown,
  fallback: CodexRunSettings = defaultCodexRunSettings(),
): CodexRunSettings => {
  const input = isRecord(value) ? value : {};
  const requestedModel = typeof input.model === 'string' && input.model.trim()
    ? input.model.trim()
    : fallback.model;
  const fallbackModel = CODEX_MODEL_IDS.has(fallback.model) ? fallback.model : DEFAULT_CODEX_MODEL;
  const normalizedModel = CODEX_MODEL_IDS.has(requestedModel) ? requestedModel : fallbackModel;
  const reasoningEffort = normalizeCodexReasoningEffort(input.reasoningEffort);
  const fallbackReasoningEffort = CODEX_REASONING_EFFORTS.has(fallback.reasoningEffort)
    ? fallback.reasoningEffort
    : DEFAULT_CODEX_REASONING_EFFORT;
  const permissionMode = normalizeCodexPermissionMode(input.permissionMode);
  const fallbackPermissionMode = CODEX_PERMISSION_MODES.has(fallback.permissionMode)
    ? fallback.permissionMode
    : DEFAULT_CODEX_PERMISSION_MODE;
  const serviceTier = input.serviceTier === 'priority' ? 'priority' : input.serviceTier === 'default' ? 'default' : null;
  const fallbackServiceTier = CODEX_SERVICE_TIERS.has(fallback.serviceTier)
    ? fallback.serviceTier
    : DEFAULT_CODEX_SERVICE_TIER;

  return {
    model: normalizedModel,
    reasoningEffort: CODEX_REASONING_EFFORTS.has(reasoningEffort) ? reasoningEffort : fallbackReasoningEffort,
    permissionMode: CODEX_PERMISSION_MODES.has(permissionMode) ? permissionMode : fallbackPermissionMode,
    serviceTier: CODEX_MODEL_OPTIONS.find(option => option.id === normalizedModel)?.supportsFast
      ? (serviceTier || fallbackServiceTier)
      : 'default',
  };
};

const storageKeyForRoom = (roomId: string) => `${ROOM_CODEX_SETTINGS_PREFIX}${roomId}`;

export const getStoredRoomCodexSettings = (
  roomId: string,
  fallback: CodexRunSettings = defaultCodexRunSettings(),
): CodexRunSettings => {
  try {
    const raw = localStorage.getItem(storageKeyForRoom(roomId));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    const storedSchemaVersion = isRecord(parsed) && typeof parsed.schemaVersion === 'number'
      ? parsed.schemaVersion
      : 1;
    if (isRecord(parsed) && storedSchemaVersion < CODEX_SETTINGS_SCHEMA_VERSION) {
      const usesLegacyModelDefaults = parsed.model === LEGACY_DEFAULT_CODEX_MODEL
        && parsed.reasoningEffort === LEGACY_DEFAULT_CODEX_REASONING_EFFORT;
      const migrated = normalizeCodexRunSettings({
        ...parsed,
        ...(usesLegacyModelDefaults ? {
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        } : {}),
      }, fallback);
      saveRoomCodexSettings(roomId, migrated);
      return migrated;
    }
    return normalizeCodexRunSettings(parsed, fallback);
  } catch {
    return fallback;
  }
};

export const saveRoomCodexSettings = (roomId: string, settings: CodexRunSettings): void => {
  try {
    localStorage.setItem(storageKeyForRoom(roomId), JSON.stringify({
      schemaVersion: CODEX_SETTINGS_SCHEMA_VERSION,
      ...normalizeCodexRunSettings(settings),
    }));
  } catch {
    // Storage can fail in private browsing or restricted contexts.
  }
};

export const updateStoredRoomCodexSettings = (
  roomId: string,
  updates: Partial<CodexRunSettings>,
  fallback: CodexRunSettings = defaultCodexRunSettings(),
): CodexRunSettings => {
  const next = normalizeCodexRunSettings({
    ...getStoredRoomCodexSettings(roomId, fallback),
    ...updates,
  }, fallback);
  saveRoomCodexSettings(roomId, next);
  return next;
};
