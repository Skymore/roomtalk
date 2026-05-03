import React, { useState, useEffect, useRef, KeyboardEventHandler } from 'react';
import Modal from 'react-modal';
import { Button, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { Message } from '../utils/types'; // Import Message type
import { useTranslation } from 'react-i18next'; // Import useTranslation
import {
  getKeyboardCompositionSnapshot,
  isConfirmingIMEComposition,
} from '../utils/keyboardComposition';

// --- Remove Modal Styling object ---
// const customStyles: Modal.Styles = { /* ... */ };

// Make sure to bind modal to your appElement
// Modal.setAppElement('#root');

interface EditMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: Message | null; // Message to edit
  onSave: (messageId: string, newContent: string) => void;
  onSaveAndAskAI: (messageId: string, newContent: string) => void;
}

export const EditMessageModal: React.FC<EditMessageModalProps> = ({
  isOpen,
  onClose,
  message,
  onSave,
  onSaveAndAskAI,
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

      if (e.ctrlKey || e.metaKey) { // Ctrl+Enter or Cmd+Enter
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
      onRequestClose={onClose}
      // Apply overlay classes directly
      overlayClassName="fixed inset-0 bg-black/50 backdrop-blur-sm z-[1000] flex items-center justify-center"
      // Apply content classes directly
      className="relative m-4 w-full max-w-lg rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-5 text-[#141413] shadow-xl outline-none transition-all duration-200 dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]"
      contentLabel={t('editMessage')}
      ariaHideApp={false} // Set to true if you configure appElement
    >
      {message && ( // Only render content if message exists
        <div className="flex flex-col">
          {/* Use Tailwind classes */}
          <h2 className="mb-3 font-serif text-lg font-medium text-[#141413] dark:text-[#faf9f5]">
            {t('editMessage')}
          </h2>
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
            className="text-sm mb-4" // Use text-sm for consistency
            classNames={{
              input: "text-[#141413] dark:text-[#faf9f5] text-sm leading-normal placeholder:text-[#87867f]",
              inputWrapper: "p-2 bg-[#e8e6dc] dark:bg-[#30302e] border-[#dedbd0] dark:border-[#4d4c48] focus-within:border-[#c96442] transition-colors",
            }}
            placeholder={t('enterYourMessage')} // Use translation for placeholder
          />
          <div className="flex justify-end gap-2 mt-2">
            {/* Use t function for buttons */}
            <Button
              variant="flat"
              size="sm"
              onPress={onClose}
              className="text-[#5e5d59] transition-colors hover:bg-[#e8e6dc] dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="light"
              color="primary"
              size="sm"
              onPress={handleSaveClick}
              title={t('saveTitle')}
              className="text-[#30302e] transition-colors hover:bg-[#e8e6dc] dark:text-[#faf9f5] dark:hover:bg-[#30302e]"
            >
              <Icon icon="lucide:save" className="mr-1" width={14} height={14}/> {t('save')}
            </Button>
            <Button
              color="primary"
              size="sm"
              onPress={handleSaveAndAskAIClick}
              title={t('saveAndAskAITitle')}
              className="bg-[#c96442] text-[#faf9f5] transition-colors hover:bg-[#b85737]"
            >
               <Icon icon="lucide:sparkles" className="mr-1" width={14} height={14}/> {t('saveAndAskAI')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};
