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

interface MessageInputAISettingsButtonProps {
  onOpen: () => void;
  isDisabled: boolean;
}

export const MessageInputAISettingsButton: React.FC<MessageInputAISettingsButtonProps> = ({ onOpen, isDisabled }) => {
  return (
    <Button
      isIconOnly
      size="sm"
      variant="light"
      className="rounded-lg text-[#5e5d59] dark:text-[#b0aea5]"
      onPress={onOpen}
      isDisabled={isDisabled}
    >
      <Icon icon="lucide:settings-2" />
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
  const [pendingPremiumModelId, setPendingPremiumModelId] = React.useState<string | null>(null);
  const [premiumConfirmationStep, setPremiumConfirmationStep] = React.useState<1 | 2>(1);
  const pendingPremiumModel = aiModels.find(model => model.id === pendingPremiumModelId);

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
      <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 lg:mr-2">
          <Select
            size="sm"
            aria-label={t('selectAIRole')}
            selectedKeys={[selectedRoleId]}
            onSelectionChange={(keys) => {
              const selectedKey = Array.from(keys)[0]?.toString();
              if (selectedKey) onRoleChange(selectedKey);
            }}
            className="w-full sm:max-w-xs"
            classNames={{
              trigger: "bg-[#e8e6dc] text-[#4d4c48] data-[hover=true]:bg-[#dedbd0] dark:bg-[#30302e] dark:text-[#faf9f5]",
            }}
            isDisabled={isSending || isAiProcessing}
          >
            {roles.map((role) => (
              <SelectItem key={role.id} startContent={<Icon icon={role.icon} />}>
                {getAIRoleDisplayName(role, t)}
              </SelectItem>
            ))}
          </Select>
          <Select
            size="sm"
            aria-label={t('selectAIModel')}
            selectedKeys={[selectedAIModel || defaultAIModel]}
            onSelectionChange={(keys) => {
              const selectedKey = Array.from(keys)[0]?.toString();
              if (selectedKey) requestModelChange(selectedKey);
            }}
            className="w-full sm:max-w-xs"
            classNames={{
              trigger: "bg-[#e8e6dc] text-[#4d4c48] data-[hover=true]:bg-[#dedbd0] dark:bg-[#30302e] dark:text-[#faf9f5]",
              popoverContent: "border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]",
              listboxWrapper: "relative max-h-[18rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#87867f_transparent] after:pointer-events-none after:sticky after:bottom-0 after:block after:h-8 after:bg-gradient-to-t after:from-[#faf9f5] after:to-transparent dark:after:from-[#1d1d1b]",
            }}
            isDisabled={isSending || isAiProcessing}
            startContent={<Icon icon="lucide:brain-circuit" />}
          >
            {aiModels.map((model) => (
              <SelectItem
                key={model.id}
                description={formatModelPrice(model)}
                textValue={model.isDefault ? `${model.label} (${t('defaultModel')})` : model.label}
              >
                <span className="flex items-center gap-1.5">
                  <span>{model.isDefault ? `${model.label} (${t('defaultModel')})` : model.label}</span>
                  <span className="inline-flex items-center rounded px-1 py-px text-[9px] font-semibold leading-none border border-[#c2c0b6]/60 bg-[#e8e6dc] text-[#4d4c48] dark:border-[#4d4c48]/60 dark:bg-[#30302e] dark:text-[#b0aea5] whitespace-nowrap">
                    {getProviderLabel(model.provider)}
                  </span>
                  {isPremiumAIModel(model) && (
                    <Icon icon="lucide:gem" className="text-warning" width={11} height={11} />
                  )}
                </span>
              </SelectItem>
            ))}
          </Select>
        </div>

        <div className="flex justify-end gap-2">
          <Tooltip content={`${t('askAI')} (${isMacOS ? 'Command' : 'Ctrl'}+Enter)`} placement="top">
            <Button
              color={selectedRole.color}
              size="sm"
              onPress={onAskAI}
              isLoading={isAiProcessing}
              isDisabled={isSending}
              className="bg-[#30302e] px-4 text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
              startContent={<Icon icon={selectedRole.icon} className="h-4 w-4" />}
            >
              {t('askAI')}
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
              className="bg-[#c96442] px-4 text-[#faf9f5] shadow-[0_0_0_1px_#c96442]"
              startContent={<Icon icon="lucide:send" className="h-4 w-4" />}
            >
              {t('send')}
            </Button>
          </Tooltip>
        </div>
      </div>

      <Modal isOpen={isSettingsOpen} onClose={onSettingsClose} size="3xl">
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
