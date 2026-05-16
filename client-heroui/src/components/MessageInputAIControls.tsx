import React from 'react';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Tab,
  Tabs,
  Tooltip,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { AIRoleManager } from './AIRoleManager';
import { AIModelOption, formatModelPrice, getProviderLabel, isPremiumAIModel } from '../utils/aiModels';
import { AIRole, getAIRoleDisplayName } from '../utils/aiRoles';

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
      className="h-8 w-8 min-w-8 rounded-full text-[#5e5d59] dark:text-[#b0aea5] sm:h-9 sm:w-9 sm:min-w-9"
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
  isMacOS: boolean;
  currentInputText: string;
  imageCount: number;
  isSettingsOpen: boolean;
  onSettingsClose: () => void;
  onRoleChange: (roleId: string) => void;
  onModelChange: (model: string) => void;
  onAddRole: (role: AIRole) => void;
  onUpdateRole: (role: AIRole) => void;
  onDeleteRole: (roleId: string) => void;
  onAskAI: () => void;
  onSend: () => void;
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
  isMacOS,
  currentInputText,
  imageCount,
  isSettingsOpen,
  onSettingsClose,
  onRoleChange,
  onModelChange,
  onAddRole,
  onUpdateRole,
  onDeleteRole,
  onAskAI,
  onSend,
}) => {
  const { t } = useTranslation();
  const [isMobileViewport, setIsMobileViewport] = React.useState(false);
  const [pendingPremiumModelId, setPendingPremiumModelId] = React.useState<string | null>(null);
  const [premiumConfirmationStep, setPremiumConfirmationStep] = React.useState<1 | 2>(1);
  const pendingPremiumModel = aiModels.find(model => model.id === pendingPremiumModelId);
  const selectedModel = aiModels.find(model => model.id === (selectedAIModel || defaultAIModel));
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

  const closePremiumConfirmation = () => {
    setPendingPremiumModelId(null);
    setPremiumConfirmationStep(1);
  };

  const requestModelChange = (modelId: string) => {
    if (modelId === selectedAIModel) return;

    const model = aiModels.find(item => item.id === modelId);
    if (model && isPremiumAIModel(model)) {
      setPendingPremiumModelId(model.id);
      setPremiumConfirmationStep(1);
      return;
    }

    onModelChange(modelId);
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

    onModelChange(pendingPremiumModel.id);
    closePremiumConfirmation();
  };

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
          <Select
            size="sm"
            aria-label={t('selectAIRole')}
            selectedKeys={[selectedRoleId]}
            onSelectionChange={(keys) => {
              const selectedKey = Array.from(keys)[0]?.toString();
              if (selectedKey) onRoleChange(selectedKey);
            }}
            className="min-w-0 flex-[0.68] sm:flex-[0.9]"
            classNames={{
              trigger: "h-8 min-h-8 rounded-full bg-transparent px-1.5 text-[#4d4c48] data-[hover=true]:bg-[#e8e6dc] dark:text-[#faf9f5] dark:data-[hover=true]:bg-[#3a3a38] sm:h-9 sm:min-h-9 sm:px-2",
              value: "truncate text-[10px] font-semibold sm:text-xs",
              selectorIcon: "h-3 w-3 text-[#87867f] dark:text-[#b0aea5] sm:h-4 sm:w-4",
              popoverContent: "w-52 border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b] sm:w-auto",
              listboxWrapper: "relative max-h-[14rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent]",
            }}
            popoverProps={{
              placement: isMobileViewport ? 'top-start' : 'top',
              offset: 8,
              containerPadding: 12,
            }}
            isDisabled={isSending || isAiProcessing}
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
          <Select
            size="sm"
            aria-label={t('selectAIModel')}
            data-testid="ai-model-select"
            selectedKeys={[selectedAIModel || defaultAIModel]}
            onSelectionChange={(keys) => {
              const selectedKey = Array.from(keys)[0]?.toString();
              if (selectedKey) requestModelChange(selectedKey);
            }}
            className="min-w-0 flex-[1.62] sm:flex-[1.25]"
            classNames={{
              trigger: "h-8 min-h-8 rounded-full bg-transparent px-1.5 text-[#4d4c48] data-[hover=true]:bg-[#e8e6dc] dark:text-[#faf9f5] dark:data-[hover=true]:bg-[#3a3a38] sm:h-9 sm:min-h-9 sm:px-2",
              value: "truncate text-[10px] font-semibold sm:text-xs",
              selectorIcon: "h-3 w-3 text-[#87867f] dark:text-[#b0aea5] sm:h-4 sm:w-4",
              popoverContent: "w-52 border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b] sm:w-[min(22rem,calc(100vw-2rem))]",
              listbox: "w-full",
              listboxWrapper: "relative max-h-[16rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent]",
            }}
            popoverProps={{
              placement: isMobileViewport ? 'top-end' : 'top',
              offset: 8,
              containerPadding: 12,
            }}
            isDisabled={isSending || isAiProcessing}
            startContent={<Icon icon="lucide:brain-circuit" className="h-3.5 w-3.5 sm:h-4 sm:w-4" />}
            renderValue={() => (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate">{selectedModel?.label}</span>
                {selectedModel?.isDefault && (
                  <Icon
                    icon="lucide:badge-check"
                    aria-label={t('defaultModel')}
                    className="flex-shrink-0 text-[#c96442] dark:text-[#ff9b76]"
                    width={11}
                    height={11}
                  />
                )}
              </span>
            )}
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
        </div>

        <div className="flex flex-shrink-0 justify-end gap-1 sm:gap-2">
          <Tooltip content={`${t('askAI')} (${isMacOS ? 'Command' : 'Ctrl'}+Enter)`} placement="top">
            <Button
              color={selectedRole.color}
              size="sm"
              onPress={onAskAI}
              isLoading={isAiProcessing}
              isDisabled={isSending}
              className="h-8 w-8 min-w-8 rounded-full bg-[#30302e] px-0 text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413] sm:h-9 sm:w-auto sm:min-w-9 sm:px-3"
            >
              <Icon icon={selectedRole.icon} className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">{t('askAI')}</span>
            </Button>
          </Tooltip>

          <Tooltip content={`${t('send')} (Enter)`} placement="top">
            <Button
              type="button"
              onClick={onSend}
              color="primary"
              size="sm"
              isLoading={isSending}
              isDisabled={isSending || isAiProcessing || (!currentInputText.trim() && imageCount === 0)}
              className="h-8 w-8 min-w-8 rounded-full bg-[#c96442] px-0 text-[#faf9f5] shadow-[0_0_0_1px_#c96442] sm:h-9 sm:w-auto sm:min-w-9 sm:px-3"
            >
              <Icon icon="lucide:arrow-up" className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">{t('send')}</span>
            </Button>
          </Tooltip>
        </div>
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
            <Tabs aria-label={t('aiSettings')}>
              <Tab key="roles" title={t('aiRoles')}>
                <div className="mt-2">
                  <AIRoleManager
                    roles={roles}
                    selectedRoleId={selectedRoleId}
                    onSelectRole={onRoleChange}
                    onAddRole={onAddRole}
                    onUpdateRole={onUpdateRole}
                    onDeleteRole={onDeleteRole}
                  />
                </div>
              </Tab>
            </Tabs>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onSettingsClose}>{t('close')}</Button>
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
