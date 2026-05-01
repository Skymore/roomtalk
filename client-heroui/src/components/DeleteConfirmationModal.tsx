import React from 'react';
import Modal from 'react-modal';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';

// Make sure to bind modal to your appElement (usually '#root')
// Do this once in your main App component or index.tsx
// Modal.setAppElement('#root'); // Example

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  messageContent?: string; // Optional: show snippet
}

export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  messageContent,
}) => {
  const { t } = useTranslation();

  return (
    <Modal
      isOpen={isOpen}
      onRequestClose={onClose}
      overlayClassName="fixed inset-0 bg-black/50 backdrop-blur-sm z-[1000] flex items-center justify-center"
      className="relative m-4 w-full max-w-md rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-5 text-[#141413] shadow-xl outline-none transition-all duration-200 dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]"
      contentLabel={t('confirmDeletion')}
      ariaHideApp={false} // Set to true if you configure appElement
    >
      <div className="flex flex-col">
        <h2 className="mb-3 font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">
          {t('confirmDeletion')}
        </h2>
        <p className="mb-4 text-sm text-[#5e5d59] dark:text-[#b0aea5]">
          {t('confirmDeleteMessagePrompt')}
        </p>
        {/* Optional: Show a snippet of the message */}
        {messageContent && (
          <div className="mb-4 max-h-20 overflow-y-auto overflow-hidden text-ellipsis rounded-lg border border-[#dedbd0] bg-[#e8e6dc] p-3 text-xs text-[#4d4c48] dark:border-[#30302e] dark:bg-[#30302e] dark:text-[#faf9f5]">
            "{messageContent}"
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <Button
            variant="flat"
            size="sm"
            onPress={onClose}
            className="text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
          >
            {t('cancel')}
          </Button>
          <Button
            color="danger"
            size="sm"
            onPress={onConfirm}
            className="bg-danger-500 hover:bg-danger-600 text-white transition-colors"
          >
            <Icon icon="lucide:trash-2" className="mr-1" width={14} height={14} />
            {t('delete')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
