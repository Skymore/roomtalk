import { CodexPermissionMode, CodexReasoningEffort, CodexServiceTier } from '../types';

export interface CodexRunSettings {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  permissionMode: CodexPermissionMode;
  serviceTier: CodexServiceTier;
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'high';
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'approveForMe';
export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = 'default';

const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', supportsFast: true },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', supportsFast: true },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', supportsFast: true },
  { id: 'gpt-5.5', label: 'GPT-5.5', supportsFast: true },
  { id: 'gpt-5.4', label: 'GPT-5.4', supportsFast: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', supportsFast: false },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', supportsFast: false },
];

const CODEX_MODEL_IDS = new Set(CODEX_MODELS.map(model => model.id));
const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(['low', 'medium', 'high', 'xhigh']);
const CODEX_PERMISSION_MODES = new Set<CodexPermissionMode>(['plan', 'edit', 'approveForMe', 'fullAccess']);
const CODEX_SERVICE_TIERS = new Set<CodexServiceTier>(['default', 'priority']);

export const normalizeCodexRunSettings = (
  model?: unknown,
  reasoningEffort?: unknown,
  permissionMode?: unknown,
  serviceTier?: unknown
): CodexRunSettings => {
  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_CODEX_MODEL;
  const normalizedModel = CODEX_MODEL_IDS.has(requestedModel) ? requestedModel : DEFAULT_CODEX_MODEL;
  const normalizedReasoningEffort: CodexReasoningEffort =
    reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high' || reasoningEffort === 'xhigh'
      ? reasoningEffort
      : DEFAULT_CODEX_REASONING_EFFORT;
  const normalizedPermissionMode: CodexPermissionMode =
    permissionMode === 'plan' || permissionMode === 'edit' || permissionMode === 'approveForMe' || permissionMode === 'fullAccess'
      ? permissionMode
      : DEFAULT_CODEX_PERMISSION_MODE;
  const normalizedServiceTier: CodexServiceTier = serviceTier === 'priority' ? 'priority' : 'default';

  return {
    model: normalizedModel,
    reasoningEffort: CODEX_REASONING_EFFORTS.has(normalizedReasoningEffort)
      ? normalizedReasoningEffort
      : DEFAULT_CODEX_REASONING_EFFORT,
    permissionMode: CODEX_PERMISSION_MODES.has(normalizedPermissionMode)
      ? normalizedPermissionMode
      : DEFAULT_CODEX_PERMISSION_MODE,
    serviceTier: CODEX_MODELS.find(candidate => candidate.id === normalizedModel)?.supportsFast
      && CODEX_SERVICE_TIERS.has(normalizedServiceTier)
      ? normalizedServiceTier
      : DEFAULT_CODEX_SERVICE_TIER,
  };
};

export const codexModelLabel = (modelId: string): string => (
  CODEX_MODELS.find(model => model.id === modelId)?.label
  || CODEX_MODELS.find(model => model.id === DEFAULT_CODEX_MODEL)?.label
  || DEFAULT_CODEX_MODEL
);

export const codexReasoningLabel = (effort: CodexReasoningEffort): string => {
  switch (effort) {
    case 'low':
      return 'Light';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
  }
};

export const getCodexMessageAIModel = (settings: CodexRunSettings) => ({
  id: settings.model,
  apiModel: settings.model,
  provider: 'openai' as const,
  label: `${codexModelLabel(settings.model)} ${codexReasoningLabel(settings.reasoningEffort)}`,
});
