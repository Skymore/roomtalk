import React from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { AIRoleManager } from './AIRoleManager';
import { HoverTooltip } from './HoverTooltip';
import { AIModelOption, formatModelPrice, getProviderLabel, isPremiumAIModel } from '../utils/aiModels';
import { AIRole, getAIRoleDisplayName } from '../utils/aiRoles';
import {
  MAX_AI_CONTEXT_MESSAGE_LIMIT,
  MIN_AI_CONTEXT_MESSAGE_LIMIT,
  normalizeAIContextMessageLimit,
} from '../utils/aiContext';
import { CodeAgentBackend, CodeAgentMode, isCodexCodeAgentBackend } from '../utils/codeAgent';
import {
  CODEX_PERMISSION_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  defaultCodexRunSettings,
  type CodexPermissionMode,
  type CodexRunSettings,
} from '../utils/codexSettings';

const formatPriceRate = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 10) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2).replace(/\.?0+$/, '')}`;
  return `$${value.toFixed(3).replace(/\.?0+$/, '')}`;
};

const ModelPriceGrid: React.FC<{ model: AIModelOption }> = ({ model }) => {
  if (!model.pricing) {
    return (
      <div className="mt-1 text-[11px] leading-4 text-[#87867f] dark:text-[#b0aea5]">
        —
      </div>
    );
  }

  const priceItems = [
    { label: 'IN', value: formatPriceRate(model.pricing.inputPerMillion) },
    { label: 'CACHE', value: formatPriceRate(model.pricing.cachedInputPerMillion) },
    { label: 'OUT', value: formatPriceRate(model.pricing.outputPerMillion) },
  ];

  return (
    <div className="mt-1 grid w-full grid-cols-3 gap-x-3 border-t border-[#dedbd0]/60 pt-1 dark:border-[#4d4c48]/55">
      {priceItems.map((item) => (
        <span
          key={item.label}
          className="min-w-0"
        >
          <span className="block truncate text-[8px] font-semibold leading-3 text-[#87867f] dark:text-[#8f8d86]">
            {item.label}
          </span>
          <span className="block truncate text-[10px] font-semibold leading-3 text-[#141413] dark:text-[#faf9f5]">
            {item.value === '—' ? item.value : `${item.value}/M`}
          </span>
        </span>
      ))}
    </div>
  );
};

const codexPermissionToCodeAgentMode = (permissionMode: CodexPermissionMode): CodeAgentMode => (
  permissionMode === 'plan' ? 'plan' : 'acceptEdits'
);

interface MessageInputAISettingsButtonProps {
  onOpen: () => void;
  isDisabled: boolean;
}

export const MessageInputAISettingsButton: React.FC<MessageInputAISettingsButtonProps> = ({ onOpen, isDisabled }) => {
  const { t } = useTranslation();

  return (
    <Button
      isIconOnly
      size="sm"
      variant="light"
      aria-label={t('aiSettings')}
      className="h-7 w-7 min-w-7 rounded-full text-[#5e5d59] dark:text-[#b0aea5] sm:h-9 sm:w-9 sm:min-w-9"
      onPress={onOpen}
      isDisabled={isDisabled}
    >
      <Icon icon="lucide:settings-2" className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
    </Button>
  );
};

interface MessageInputAIControlsProps {
  roles: AIRole[];
  selectedRoleId: string;
  selectedRole: AIRole;
  aiModels: AIModelOption[];
  selectedAIModel: string;
  defaultAIModel: string;
  isSending: boolean;
  isAiProcessing: boolean;
  isInputLocked?: boolean;
  canPost: boolean;
  isMacOS: boolean;
  currentInputText: string;
  imageCount: number;
  aiContextMessageLimit: number;
  isSettingsOpen: boolean;
  onSettingsClose: () => void;
  onRoleChange: (roleId: string) => void;
  onModelChange: (model: string) => void;
  onAIContextMessageLimitChange: (limit: number) => void;
  onAddRole: (role: AIRole) => void;
  onUpdateRole: (role: AIRole) => void;
  onDeleteRole: (roleId: string) => void;
  onAskAI: () => void;
  onSend: () => void;
  isCodeAgentRoom?: boolean;
  codeAgentBackend?: CodeAgentBackend;
  codeAgentMode?: CodeAgentMode;
  codeAgentMaxMode?: CodeAgentMode;
  canSwitchCodeAgentMode?: boolean;
  onCodeAgentModeChange?: (mode: CodeAgentMode) => void;
  codexRunSettings?: CodexRunSettings;
  onCodexRunSettingsChange?: (settings: Partial<CodexRunSettings>) => void;
}

export const MessageInputAIControls: React.FC<MessageInputAIControlsProps> = ({
  roles,
  selectedRoleId,
  selectedRole,
  aiModels,
  selectedAIModel,
  defaultAIModel,
  isSending,
  isAiProcessing,
  isInputLocked = false,
  canPost,
  isMacOS,
  currentInputText,
  imageCount,
  aiContextMessageLimit,
  isSettingsOpen,
  onSettingsClose,
  onRoleChange,
  onModelChange,
  onAIContextMessageLimitChange,
  onAddRole,
  onUpdateRole,
  onDeleteRole,
  onAskAI,
  onSend,
  isCodeAgentRoom = false,
  codeAgentBackend = 'coco',
  codeAgentMode = 'plan',
  codeAgentMaxMode = 'plan',
  canSwitchCodeAgentMode = codeAgentMaxMode === 'acceptEdits',
  onCodeAgentModeChange,
  codexRunSettings = defaultCodexRunSettings(),
  onCodexRunSettingsChange,
}) => {
  const { t } = useTranslation();
  const [isMobileViewport, setIsMobileViewport] = React.useState(false);
  const [aiContextMessageLimitDraft, setAIContextMessageLimitDraft] = React.useState(() => (
    normalizeAIContextMessageLimit(aiContextMessageLimit)
  ));
  const [selectedAIModelDraft, setSelectedAIModelDraft] = React.useState(selectedAIModel || defaultAIModel);
  const [selectedRoleIdDraft, setSelectedRoleIdDraft] = React.useState(selectedRoleId);
  const [codeAgentModeDraft, setCodeAgentModeDraft] = React.useState<CodeAgentMode>('plan');
  const [codexRunSettingsDraft, setCodexRunSettingsDraft] = React.useState<CodexRunSettings>(codexRunSettings);
  const [pendingPremiumModelId, setPendingPremiumModelId] = React.useState<string | null>(null);
  const [premiumConfirmationStep, setPremiumConfirmationStep] = React.useState<1 | 2>(1);
  const pendingPremiumModel = aiModels.find(model => model.id === pendingPremiumModelId);
  const hasInputContent = currentInputText.trim().length > 0 || imageCount > 0;
  const isControlLocked = isSending || isAiProcessing || isInputLocked || !canPost;
  const askActionLabel = isCodeAgentRoom ? t('runAgent') : t('askAI');
  const askActionIcon = isCodeAgentRoom ? 'lucide:bot' : selectedRole.icon;
  const isCodexCodeAgent = isCodeAgentRoom && isCodexCodeAgentBackend(codeAgentBackend);
  const effectiveCodeAgentMode = codeAgentMaxMode === 'acceptEdits' ? codeAgentMode : 'plan';
  const canSwitchEffectiveCodeAgentMode = isCodeAgentRoom && codeAgentMaxMode === 'acceptEdits' && canSwitchCodeAgentMode;
  const appliedAIModelId = selectedAIModel || defaultAIModel;
  const selectedRoleDraft = roles.find(role => role.id === selectedRoleIdDraft) || selectedRole;
  const codeAgentModeOptions: Array<{ id: CodeAgentMode; label: string; icon: string }> = [
    { id: 'plan', label: t('codeAgentReadOnlyMode'), icon: 'lucide:eye' },
    ...(codeAgentMaxMode === 'acceptEdits'
      ? [{ id: 'acceptEdits' as const, label: t('codeAgentEditMode'), icon: 'lucide:pencil-ruler' }]
      : []),
  ];
  const codexPermissionOptions = codeAgentMaxMode === 'acceptEdits'
    ? CODEX_PERMISSION_OPTIONS
    : CODEX_PERMISSION_OPTIONS.filter(option => option.id === 'plan');
  const selectedCodexPermissionOption = (
    codexPermissionOptions.find(option => option.id === codexRunSettingsDraft.permissionMode)
    || codexPermissionOptions[0]
    || CODEX_PERMISSION_OPTIONS[0]
  );
  const compactItemClassNames = {
    base: "w-full px-2 py-2",
    title: "text-xs font-medium leading-4 text-[#141413] dark:text-[#faf9f5]",
    wrapper: "min-w-0 w-full",
  };

  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const updateViewport = () => setIsMobileViewport(query.matches);

    updateViewport();
    query.addEventListener('change', updateViewport);

    return () => query.removeEventListener('change', updateViewport);
  }, []);

  React.useEffect(() => {
    if (!isSettingsOpen) return;
    setAIContextMessageLimitDraft(normalizeAIContextMessageLimit(aiContextMessageLimit));
    setSelectedAIModelDraft(appliedAIModelId);
    setSelectedRoleIdDraft(selectedRoleId);
    setCodeAgentModeDraft(effectiveCodeAgentMode);
    setCodexRunSettingsDraft({
      ...codexRunSettings,
      permissionMode: effectiveCodeAgentMode === 'plan'
        ? 'plan'
        : codexRunSettings.permissionMode,
    });
    setPendingPremiumModelId(null);
    setPremiumConfirmationStep(1);
  }, [aiContextMessageLimit, appliedAIModelId, codexRunSettings, effectiveCodeAgentMode, selectedRoleId, isSettingsOpen]);

  const closePremiumConfirmation = () => {
    setPendingPremiumModelId(null);
    setPremiumConfirmationStep(1);
  };

  const requestModelChange = (modelId: string) => {
    if (modelId === selectedAIModelDraft) return;

    const model = aiModels.find(item => item.id === modelId);
    if (model && isPremiumAIModel(model)) {
      setPendingPremiumModelId(model.id);
      setPremiumConfirmationStep(1);
      return;
    }

    setSelectedAIModelDraft(modelId);
  };

  const confirmPremiumModelChange = () => {
    if (!pendingPremiumModel) {
      closePremiumConfirmation();
      return;
    }

    if (premiumConfirmationStep === 1) {
      setPremiumConfirmationStep(2);
      return;
    }

    setSelectedAIModelDraft(pendingPremiumModel.id);
    closePremiumConfirmation();
  };

  const handleAIContextMessageLimitInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setAIContextMessageLimitDraft(normalizeAIContextMessageLimit(event.target.value, MIN_AI_CONTEXT_MESSAGE_LIMIT));
  };

  const handleCodeAgentModeSelection = (keys: 'all' | Set<React.Key>) => {
    if (keys === 'all') return;
    const selectedKey = Array.from(keys)[0]?.toString();
    if (isCodexCodeAgent && (selectedKey === 'plan' || selectedKey === 'edit' || selectedKey === 'approveForMe' || selectedKey === 'fullAccess')) {
      setCodexRunSettingsDraft(current => ({ ...current, permissionMode: selectedKey }));
      setCodeAgentModeDraft(codexPermissionToCodeAgentMode(selectedKey));
      return;
    }
    if (selectedKey === 'plan' || selectedKey === 'acceptEdits') {
      setCodeAgentModeDraft(selectedKey);
    }
  };
  const handleCodexModelSelection = (keys: 'all' | Set<React.Key>) => {
    if (keys === 'all') return;
    const selectedKey = Array.from(keys)[0]?.toString();
    if (selectedKey && CODEX_MODEL_OPTIONS.some(option => option.id === selectedKey)) {
      setCodexRunSettingsDraft(current => ({ ...current, model: selectedKey }));
    }
  };
  const handleCodexReasoningSelection = (keys: 'all' | Set<React.Key>) => {
    if (keys === 'all') return;
    const selectedKey = Array.from(keys)[0]?.toString();
    if (selectedKey === 'low' || selectedKey === 'medium' || selectedKey === 'high' || selectedKey === 'xhigh') {
      setCodexRunSettingsDraft(current => ({ ...current, reasoningEffort: selectedKey }));
    }
  };
  const normalizedAIContextMessageLimitDraft = normalizeAIContextMessageLimit(aiContextMessageLimitDraft);
  const normalizedAIContextMessageLimit = normalizeAIContextMessageLimit(aiContextMessageLimit);
  const settingsChanged = (
    (!isCodexCodeAgent && selectedAIModelDraft !== appliedAIModelId)
    || normalizedAIContextMessageLimitDraft !== normalizedAIContextMessageLimit
    || (!isCodeAgentRoom && selectedRoleIdDraft !== selectedRoleId)
    || (isCodeAgentRoom && codeAgentModeDraft !== effectiveCodeAgentMode)
    || (isCodexCodeAgent && (
      codexRunSettingsDraft.model !== codexRunSettings.model
      || codexRunSettingsDraft.reasoningEffort !== codexRunSettings.reasoningEffort
      || codexRunSettingsDraft.permissionMode !== codexRunSettings.permissionMode
    ))
  );
  const handleSettingsApply = () => {
    if (!settingsChanged) return;

    if (!isCodexCodeAgent && selectedAIModelDraft !== appliedAIModelId) {
      onModelChange(selectedAIModelDraft);
    }
    if (isCodexCodeAgent && (
      codexRunSettingsDraft.model !== codexRunSettings.model
      || codexRunSettingsDraft.reasoningEffort !== codexRunSettings.reasoningEffort
      || codexRunSettingsDraft.permissionMode !== codexRunSettings.permissionMode
    )) {
      onCodexRunSettingsChange?.(codexRunSettingsDraft);
    }
    if (!isCodeAgentRoom && selectedRoleIdDraft !== selectedRoleId) {
      onRoleChange(selectedRoleIdDraft);
    }
    if (isCodeAgentRoom && codeAgentModeDraft !== effectiveCodeAgentMode && canSwitchEffectiveCodeAgentMode) {
      onCodeAgentModeChange?.(codeAgentModeDraft);
    }
    if (normalizedAIContextMessageLimitDraft !== normalizedAIContextMessageLimit) {
      setAIContextMessageLimitDraft(normalizedAIContextMessageLimitDraft);
      onAIContextMessageLimitChange(normalizedAIContextMessageLimitDraft);
    }
    onSettingsClose();
  };

  return (
    <>
      <div className="flex flex-shrink-0 items-center justify-end gap-1 sm:min-w-0 sm:flex-1 sm:gap-2">
        <HoverTooltip content={`${askActionLabel} (${isMacOS ? 'Command' : 'Ctrl'}+Enter)`} placement="top">
          <Button
            color={isCodeAgentRoom ? 'default' : selectedRole.color}
            size="sm"
            onPress={onAskAI}
            isDisabled={isControlLocked}
            aria-label={askActionLabel}
            className="relative !h-7 !w-7 !min-w-7 overflow-hidden rounded-full bg-[#30302e] px-0 text-[#faf9f5] shadow-[0_0_0_1px_rgba(48,48,46,0.7)] dark:bg-[#faf9f5] dark:text-[#141413] dark:shadow-[0_0_0_1px_rgba(250,249,245,0.7)] sm:!h-9 sm:!w-auto sm:!min-w-9 sm:px-3"
          >
            <span className={`flex items-center justify-center gap-1.5 ${isAiProcessing ? 'opacity-0' : 'opacity-100'}`}>
              <Icon icon={askActionIcon} className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">{askActionLabel}</span>
            </span>
            {isAiProcessing && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <Icon icon="lucide:loader-circle" className="h-3.5 w-3.5 animate-spin sm:h-4 sm:w-4" />
              </span>
            )}
          </Button>
        </HoverTooltip>

        <HoverTooltip content={`${t('send')} (Enter)`} placement="top">
          <Button
            type="button"
            onClick={onSend}
            color="primary"
            size="sm"
            isDisabled={isControlLocked || !hasInputContent}
            aria-label={t('send')}
            className="relative !h-7 !w-7 !min-w-7 overflow-hidden rounded-full bg-[#c96442] px-0 text-[#faf9f5] shadow-[0_0_0_1px_rgba(201,100,66,0.7)] sm:!h-9 sm:!w-auto sm:!min-w-9 sm:px-3"
          >
            <span className={`flex items-center justify-center gap-1.5 ${isSending ? 'opacity-0' : 'opacity-100'}`}>
              <Icon icon="lucide:arrow-up" className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">{t('send')}</span>
            </span>
            {isSending && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <Icon icon="lucide:loader-circle" className="h-3.5 w-3.5 animate-spin sm:h-4 sm:w-4" />
              </span>
            )}
          </Button>
        </HoverTooltip>
      </div>

      <Modal
        isOpen={isSettingsOpen}
        onClose={onSettingsClose}
        size={isMobileViewport ? 'md' : '3xl'}
        placement={isMobileViewport ? 'bottom' : 'center'}
        scrollBehavior="inside"
        classNames={{
          wrapper: "items-end px-0 sm:items-center sm:px-6",
          base: "m-0 max-h-[82dvh] w-full max-w-none rounded-b-none rounded-t-2xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b] sm:m-4 sm:max-h-[85dvh] sm:w-full sm:max-w-3xl sm:rounded-large",
          header: "px-5 pb-2 pt-5 sm:px-6",
          body: "px-5 py-3 sm:px-6",
          footer: "px-5 pb-5 pt-2 sm:px-6",
          closeButton: "right-4 top-4",
        }}
      >
        <ModalContent>
          <ModalHeader>{t('aiSettings')}</ModalHeader>
          <ModalBody>
            {isCodexCodeAgent ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  size="sm"
                  label={t('selectCodexModel')}
                  aria-label={t('selectCodexModel')}
                  data-testid="codex-model-select"
                  selectedKeys={[codexRunSettingsDraft.model]}
                  onSelectionChange={handleCodexModelSelection}
                  classNames={{
                    trigger: "min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]",
                    label: "text-[#5e5d59] dark:text-[#b0aea5]",
                    value: "text-sm font-semibold",
                    popoverContent: "w-[min(18rem,calc(100vw-2rem))] border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
                    listboxWrapper: "relative max-h-[14rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent]",
                  }}
                  startContent={<Icon icon="lucide:terminal" className="h-4 w-4" />}
                >
                  {CODEX_MODEL_OPTIONS.map((model) => (
                    <SelectItem
                      key={model.id}
                      classNames={compactItemClassNames}
                      textValue={model.label}
                    >
                      <span className="block truncate text-xs font-medium leading-4">
                        {model.label}
                      </span>
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  size="sm"
                  label={t('selectCodexReasoning')}
                  aria-label={t('selectCodexReasoning')}
                  data-testid="codex-reasoning-select"
                  selectedKeys={[codexRunSettingsDraft.reasoningEffort]}
                  onSelectionChange={handleCodexReasoningSelection}
                  classNames={{
                    trigger: "min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]",
                    label: "text-[#5e5d59] dark:text-[#b0aea5]",
                    value: "text-sm font-semibold",
                    popoverContent: "w-[min(15rem,calc(100vw-2rem))] border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
                  }}
                  startContent={<Icon icon="lucide:gauge" className="h-4 w-4" />}
                >
                  {CODEX_REASONING_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.id}
                      classNames={compactItemClassNames}
                      startContent={<Icon icon="lucide:gauge" className="h-3.5 w-3.5" />}
                    >
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            ) : (
              <Select
                size="sm"
                label={t('selectAIModel')}
                aria-label={t('selectAIModel')}
                data-testid="ai-model-select"
                selectedKeys={[selectedAIModelDraft]}
                onSelectionChange={(keys) => {
                  const selectedKey = Array.from(keys)[0]?.toString();
                  if (selectedKey) requestModelChange(selectedKey);
                }}
                classNames={{
                  trigger: "min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]",
                  label: "text-[#5e5d59] dark:text-[#b0aea5]",
                  value: "text-sm font-semibold",
                  popoverContent: "w-[min(22rem,calc(100vw-2rem))] border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
                  listboxWrapper: "relative max-h-[16rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent]",
                }}
                startContent={<Icon icon="lucide:brain-circuit" className="h-4 w-4" />}
              >
                {aiModels.map((model) => (
                  <SelectItem
                    key={model.id}
                    classNames={compactItemClassNames}
                    textValue={model.label}
                  >
                    <span className="block w-full min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs font-medium leading-4">
                          {model.label}
                        </span>
                        {model.isDefault && (
                          <Icon
                            icon="lucide:badge-check"
                            aria-label={t('defaultModel')}
                            className="flex-shrink-0 text-[#c96442] dark:text-[#ff9b76]"
                            width={11}
                            height={11}
                          />
                        )}
                        <span className="inline-flex flex-shrink-0 items-center rounded px-1 py-px text-[9px] font-semibold leading-none border border-[#c2c0b6]/60 bg-[#e8e6dc] text-[#4d4c48] dark:border-[#4d4c48]/60 dark:bg-[#30302e] dark:text-[#b0aea5] whitespace-nowrap">
                          {getProviderLabel(model.provider)}
                        </span>
                        {isPremiumAIModel(model) && (
                          <Icon icon="lucide:gem" className="flex-shrink-0 text-warning" width={10} height={10} />
                        )}
                      </span>
                      <ModelPriceGrid model={model} />
                    </span>
                  </SelectItem>
                ))}
              </Select>
            )}
            {isCodeAgentRoom && (
              <div className="space-y-2 rounded-lg border border-[#dedbd0] bg-[#f0eee6] p-3 dark:border-[#30302e] dark:bg-[#242421]">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#87867f] dark:text-[#b0aea5]">
                  <Icon
                    icon={isCodexCodeAgent ? selectedCodexPermissionOption.icon : codeAgentModeDraft === 'plan' ? 'lucide:eye' : 'lucide:pencil-ruler'}
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  {isCodexCodeAgent ? t('selectCodexPermission') : t('selectCodeAgentMode')}
                </div>
                <Select
                  size="sm"
                  aria-label={isCodexCodeAgent ? t('selectCodexPermission') : t('codeAgentModeControl')}
                  data-testid="code-agent-mode-select"
                  selectedKeys={[isCodexCodeAgent ? selectedCodexPermissionOption.id : codeAgentModeDraft]}
                  onSelectionChange={handleCodeAgentModeSelection}
                  isDisabled={!canSwitchEffectiveCodeAgentMode}
                  classNames={{
                    trigger: "min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]",
                    value: "text-sm font-semibold",
                    popoverContent: "border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
                  }}
                >
                  {isCodexCodeAgent
                    ? codexPermissionOptions.map((option) => (
                      <SelectItem
                        key={option.id}
                        classNames={compactItemClassNames}
                        startContent={<Icon icon={option.icon} className="h-3.5 w-3.5" />}
                      >
                        {t(option.labelKey)}
                      </SelectItem>
                    ))
                    : codeAgentModeOptions.map((option) => (
                      <SelectItem
                        key={option.id}
                        classNames={compactItemClassNames}
                        startContent={<Icon icon={option.icon} className="h-3.5 w-3.5" />}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                </Select>
                <p className="text-xs leading-5 text-[#5e5d59] dark:text-[#b0aea5]">
                  {!canSwitchEffectiveCodeAgentMode
                    ? t('codeAgentModeLockedDescription')
                    : isCodexCodeAgent
                      ? t(selectedCodexPermissionOption.descriptionKey)
                      : (codeAgentModeDraft === 'plan' ? t('codeAgentReadOnlyDescription') : t('codeAgentEditDescription'))}
                </p>
              </div>
            )}
            {!isCodeAgentRoom && (
              <Select
                size="sm"
                label={t('selectAIRole')}
                aria-label={t('selectAIRole')}
                selectedKeys={[selectedRoleIdDraft]}
                onSelectionChange={(keys) => {
                  const selectedKey = Array.from(keys)[0]?.toString();
                  if (selectedKey) setSelectedRoleIdDraft(selectedKey);
                }}
                classNames={{
                  trigger: "min-h-11 rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]",
                  label: "text-[#5e5d59] dark:text-[#b0aea5]",
                  value: "text-sm font-semibold",
                  popoverContent: "w-52 border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
                  listboxWrapper: "relative max-h-[14rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent]",
                }}
                startContent={<Icon icon={selectedRoleDraft.icon} className="h-4 w-4" />}
              >
                {roles.map((role) => (
                  <SelectItem
                    key={role.id}
                    classNames={compactItemClassNames}
                    startContent={<Icon icon={role.icon} className="h-3.5 w-3.5" />}
                  >
                    {getAIRoleDisplayName(role, t)}
                  </SelectItem>
                ))}
              </Select>
            )}
            <div className="space-y-2 rounded-lg border border-[#dedbd0] bg-[#f0eee6] p-3 dark:border-[#30302e] dark:bg-[#242421]">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#87867f] dark:text-[#b0aea5]">
                <Icon icon="lucide:brain-circuit" className="h-3.5 w-3.5" aria-hidden="true" />
                {t('aiContextLimit')}
              </div>
              <Input
                type="number"
                aria-label={t('aiContextLimit')}
                description={t('aiContextLimitDescription')}
                min={MIN_AI_CONTEXT_MESSAGE_LIMIT}
                max={MAX_AI_CONTEXT_MESSAGE_LIMIT}
                step={1}
                value={String(aiContextMessageLimitDraft)}
                onChange={handleAIContextMessageLimitInputChange}
                classNames={{ inputWrapper: 'h-11' }}
              />
            </div>
            {!isCodeAgentRoom && (
              <AIRoleManager
                roles={roles}
                selectedRoleId={selectedRoleIdDraft}
                onSelectRole={setSelectedRoleIdDraft}
                onAddRole={onAddRole}
                onUpdateRole={onUpdateRole}
                onDeleteRole={onDeleteRole}
              />
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              color="secondary"
              onPress={handleSettingsApply}
              isDisabled={!settingsChanged}
              className="bg-[#c96442] text-[#faf9f5]"
            >
              {t('apply')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={Boolean(pendingPremiumModel)}
        onClose={closePremiumConfirmation}
        isDismissable={false}
        size="md"
      >
        <ModalContent>
          <ModalHeader>
            {premiumConfirmationStep === 1
              ? t('premiumModelPriceConfirmationTitle')
              : t('premiumModelFinalConfirmationTitle')}
          </ModalHeader>
          <ModalBody>
            {pendingPremiumModel && (
              <div className="space-y-3 text-sm text-[#4d4c48] dark:text-[#b0aea5]">
                <p>
                  {premiumConfirmationStep === 1
                    ? t('premiumModelPriceConfirmationBody', {
                        model: pendingPremiumModel.label,
                        price: formatModelPrice(pendingPremiumModel),
                      })
                    : t('premiumModelFinalConfirmationBody', {
                        model: pendingPremiumModel.label,
                        price: formatModelPrice(pendingPremiumModel),
                      })}
                </p>
                <div className="rounded-md border border-warning-300 bg-warning-50 px-3 py-2 text-warning-700 dark:border-warning-700 dark:bg-warning-950/30 dark:text-warning-200">
                  {formatModelPrice(pendingPremiumModel)}
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={closePremiumConfirmation}>{t('cancel')}</Button>
            <Button color="warning" onPress={confirmPremiumModelChange}>
              {premiumConfirmationStep === 1 ? t('premiumModelPriceConfirmationContinue') : t('switchPremiumModel')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};
