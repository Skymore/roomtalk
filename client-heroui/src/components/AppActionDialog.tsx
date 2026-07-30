import React from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';

type AppConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
  tone?: 'default' | 'danger';
  isPending?: boolean;
};

export const AppConfirmDialog: React.FC<AppConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  tone = 'default',
  isPending = false,
}) => {
  const { t } = useTranslation();
  const isDanger = tone === 'danger';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      placement="center"
      classNames={{
        wrapper: 'roomtalk-modal-viewport px-3 sm:px-6',
        backdrop: 'bg-[#141413]/55 backdrop-blur-[2px]',
      }}
    >
      <ModalContent className="border border-[#dedbd0] bg-[#faf9f5] text-[#141413] shadow-2xl dark:border-[#3a3936] dark:bg-[#1d1d1b] dark:text-[#faf9f5]">
        <ModalHeader className="flex items-center gap-3 px-5 pb-2 pt-5">
          <span
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              isDanger
                ? 'bg-danger-50 text-danger-600 dark:bg-danger-950/50 dark:text-danger-400'
                : 'bg-[#fff1eb] text-[#a94f31] dark:bg-[#3a241d] dark:text-[#ff9b78]'
            }`}
            aria-hidden="true"
          >
            <Icon icon={isDanger ? 'lucide:triangle-alert' : 'lucide:circle-help'} className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 font-serif text-lg font-semibold leading-6">{title}</span>
        </ModalHeader>
        <ModalBody className="px-5 py-3 text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">
          {description}
        </ModalBody>
        <ModalFooter className="gap-2 border-t border-[#e5e2d9] px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 dark:border-[#30302e]">
          <Button variant="light" onPress={onClose} isDisabled={isPending} className="min-h-11 sm:min-h-9">
            {t('cancel')}
          </Button>
          <Button
            color={isDanger ? 'danger' : 'secondary'}
            onPress={onConfirm}
            isLoading={isPending}
            className="min-h-11 font-semibold sm:min-h-9"
          >
            {confirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

type AppTextInputDialogProps = {
  isOpen: boolean;
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  errorMessage?: string;
  isPending?: boolean;
};

export const AppTextInputDialog: React.FC<AppTextInputDialogProps> = ({
  isOpen,
  title,
  label,
  value,
  confirmLabel,
  onValueChange,
  onClose,
  onConfirm,
  errorMessage,
  isPending = false,
}) => {
  const { t } = useTranslation();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      placement="center"
      classNames={{
        wrapper: 'roomtalk-modal-viewport px-3 sm:px-6',
        backdrop: 'bg-[#141413]/55 backdrop-blur-[2px]',
      }}
    >
      <ModalContent className="border border-[#dedbd0] bg-[#faf9f5] text-[#141413] shadow-2xl dark:border-[#3a3936] dark:bg-[#1d1d1b] dark:text-[#faf9f5]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!isPending && value.trim()) onConfirm();
          }}
        >
          <ModalHeader className="px-5 pb-2 pt-5 font-serif text-lg font-semibold">{title}</ModalHeader>
          <ModalBody className="px-5 py-3">
            <Input
              autoFocus
              label={label}
              value={value}
              onValueChange={onValueChange}
              isInvalid={Boolean(errorMessage)}
              errorMessage={errorMessage}
              spellCheck="false"
              autoComplete="off"
              variant="bordered"
              classNames={{
                inputWrapper: 'min-h-12 border-[#c9c6bb] bg-[#fffdf8] group-data-[focus=true]:border-[#c96442] dark:border-[#4a4945] dark:bg-[#242421]',
                input: 'font-mono text-sm',
                label: 'text-[#5e5d59] dark:text-[#b0aea5]',
              }}
            />
          </ModalBody>
          <ModalFooter className="gap-2 border-t border-[#e5e2d9] px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 dark:border-[#30302e]">
            <Button type="button" variant="light" onPress={onClose} isDisabled={isPending} className="min-h-11 sm:min-h-9">
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              color="secondary"
              isLoading={isPending}
              isDisabled={!value.trim()}
              className="min-h-11 font-semibold sm:min-h-9"
            >
              {confirmLabel}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
};
