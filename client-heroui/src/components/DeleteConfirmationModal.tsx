import React from 'react';
import { useTranslation } from 'react-i18next';
import { AppConfirmDialog } from './AppActionDialog';

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  messageContent?: string;
}

export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  messageContent,
}) => {
  const { t } = useTranslation();

  return (
    <AppConfirmDialog
      isOpen={isOpen}
      title={t('confirmDeletion')}
      description={(
        <div className="space-y-3">
          <p>{t('confirmDeleteMessagePrompt')}</p>
          {messageContent ? (
            <blockquote className="max-h-24 overflow-y-auto break-words rounded-xl border border-[#dedbd0] bg-[#f0eee6] px-3 py-2 text-xs leading-5 text-[#4d4c48] dark:border-[#3a3936] dark:bg-[#242421] dark:text-[#e8e6dc]">
              “{messageContent}”
            </blockquote>
          ) : null}
        </div>
      )}
      confirmLabel={t('delete')}
      tone="danger"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
};
