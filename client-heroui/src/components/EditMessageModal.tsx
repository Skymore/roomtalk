import React, { useState, useEffect, useRef, KeyboardEventHandler } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { Message } from '../utils/types'; // Import Message type
import { useTranslation } from 'react-i18next'; // Import useTranslation
import {
  getKeyboardCompositionSnapshot,
  isConfirmingIMEComposition,
} from '../utils/keyboardComposition';

// --- Remove Modal Styling object ---
// const customStyles: Modal.Styles = { /* ... */ };

interface EditMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: Message | null; // Message to edit
  onSave: (messageId: string, newContent: string) => void;
  onSaveAndAskAI: (messageId: string, newContent: string) => void;
  showSaveAndAskAI?: boolean;
}

export const EditMessageModal: React.FC<EditMessageModalProps> = ({
  isOpen,
  onClose,
  message,
  onSave,
  onSaveAndAskAI,
  showSaveAndAskAI = true,
}) => {
  const { t } = useTranslation(); // Get t function
  const [editedContent, setEditedContent] = useState('');
  const editInputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  // Update text area when message changes or modal opens
  useEffect(() => {
    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    if (isOpen && message) {
      setEditedContent(message.content);
      // Auto-focus
      focusTimer = setTimeout(() => editInputRef.current?.focus(), 50);
    }

    return () => {
      if (focusTimer) {
        clearTimeout(focusTimer);
      }
    };
  }, [isOpen, message]);

  const handleSaveClick = () => {
    if (!message) return;
    const trimmedContent = editedContent.trim();
    // Only save if content actually changed and is not empty
    if (trimmedContent && trimmedContent !== message.content) {
      onSave(message.id, trimmedContent);
    }
    onClose(); // Close modal after action
  };

  const handleSaveAndAskAIClick = () => {
    if (!message) return;
    const trimmedContent = editedContent.trim();
     // Only save if content actually changed and is not empty
    if (trimmedContent && trimmedContent !== message.content) {
      onSaveAndAskAI(message.id, trimmedContent);
    } else if (trimmedContent === message.content){
      // If content didn't change, still trigger AI based on this message
      // Note: onSaveAndAskAI expects newContent, but we pass original
      // The receiving function should handle this (or we adjust the prop)
      // Let's assume for now triggering AI requires a change, or handle it in MessageList
      console.warn("Content unchanged, Save & Ask AI might not proceed unless handled in MessageList.");
      // Alternative: Call a different function? Or adjust onSaveAndAskAI?
      // For now, we only proceed if content changed.
      onClose();
      return;
    }
    onClose(); // Close modal after action
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
  };

  // Handle keydown in textarea (Ctrl+Enter to Save & Ask AI, Enter to Save)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isConfirmingIMEComposition(getKeyboardCompositionSnapshot(
        e,
        isComposingRef.current,
        lastCompositionEndAtRef.current
      ))) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && showSaveAndAskAI) { // Ctrl+Enter or Cmd+Enter
        e.preventDefault();
        handleSaveAndAskAIClick();
      } else if (!e.shiftKey) { // Just Enter
        e.preventDefault();
        handleSaveClick();
      }
      // Allow Shift+Enter for new lines
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
    }
  };


  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      placement="center"
      classNames={{
        wrapper: 'roomtalk-modal-viewport px-3 sm:px-6',
        backdrop: 'bg-[#141413]/55 backdrop-blur-[2px]',
      }}
    >
      <ModalContent className="border border-[#dedbd0] bg-[#faf9f5] text-[#141413] shadow-2xl dark:border-[#3a3936] dark:bg-[#1d1d1b] dark:text-[#faf9f5]">
        {message ? (
          <>
          <ModalHeader className="px-5 pb-2 pt-5 font-serif text-lg font-semibold">
            {t('editMessage')}
          </ModalHeader>
          <ModalBody className="px-5 py-3">
          <Textarea
            ref={editInputRef}
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            onKeyDown={handleKeyDown as unknown as KeyboardEventHandler<HTMLInputElement>} // Use onKeyDown on Textarea
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            fullWidth
            minRows={3}
            maxRows={10}
            size="sm"
            variant="bordered"
            className="text-sm"
            classNames={{
              input: "text-[#141413] dark:text-[#faf9f5] text-sm leading-normal placeholder:text-[#5e5d59]",
              inputWrapper: "p-2 bg-[#e8e6dc] dark:bg-[#30302e] border-[#dedbd0] dark:border-[#4d4c48] focus-within:border-[#c96442] transition-colors",
            }}
            placeholder={t('enterYourMessage')} // Use translation for placeholder
          />
          </ModalBody>
          <ModalFooter className="flex-wrap gap-2 border-t border-[#e5e2d9] px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 dark:border-[#30302e]">
            <Button
              variant="light"
              onPress={onClose}
              className="min-h-11 text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e] sm:min-h-9"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="light"
              color="primary"
              onPress={handleSaveClick}
              title={t('saveTitle')}
              className="min-h-11 text-[#30302e] transition-colors hover:bg-[#e8e6dc] dark:text-[#faf9f5] dark:hover:bg-[#30302e] sm:min-h-9"
            >
              <Icon icon="lucide:save" className="mr-1" width={14} height={14}/> {t('save')}
            </Button>
            {showSaveAndAskAI && (
              <Button
                color="secondary"
                onPress={handleSaveAndAskAIClick}
                title={t('saveAndAskAITitle')}
                className="min-h-11 bg-secondary font-semibold text-secondary-foreground transition-colors hover:bg-[#94462f] dark:hover:bg-[#e08a6a] sm:min-h-9"
              >
                <Icon icon="lucide:sparkles" className="mr-1" width={14} height={14}/> {t('saveAndAskAI')}
              </Button>
            )}
          </ModalFooter>
          </>
        ) : null}
      </ModalContent>
    </Modal>
  );
};
