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
      overlayClassName="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm z-[1000] flex items-center justify-center"
      className="relative bg-content2 dark:bg-content1 rounded-lg shadow-xl p-5 m-4 max-w-md w-full border-1 border-content3 dark:border-content2 outline-none transition-all duration-200"
      contentLabel={t('confirmDeletion')}
      ariaHideApp={false} // Set to true if you configure appElement
    >
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold mb-3 text-foreground dark:text-foreground">
          {t('confirmDeletion')}
        </h2>
        <p className="text-sm text-foreground-500 dark:text-foreground-400 mb-4">
          {t('confirmDeleteMessagePrompt')}
        </p>
        {/* Optional: Show a snippet of the message */}
        {messageContent && (
          <div className="text-xs bg-content3 dark:bg-content2 p-3 rounded-md border-1 border-content4 dark:border-content3 mb-4 overflow-hidden text-ellipsis max-h-20 overflow-y-auto text-foreground-500 dark:text-foreground-400">
            "{messageContent}"
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <Button 
            variant="flat" 
            size="sm" 
            onPress={onClose}
            className="text-default-600 hover:bg-content3 dark:hover:bg-content2 transition-colors"
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