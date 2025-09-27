import React, { useState, useEffect, useRef, KeyboardEventHandler } from 'react';
import Modal from 'react-modal';
import { Button, Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { Message } from '../utils/types'; // Import Message type
import { useTranslation } from 'react-i18next'; // Import useTranslation

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

  // Update text area when message changes or modal opens
  useEffect(() => {
    if (isOpen && message) {
      setEditedContent(message.content);
      // Auto-focus
      setTimeout(() => editInputRef.current?.focus(), 50);
    }
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

   // Handle keydown in textarea (Ctrl+Enter to Save & Ask AI, Enter to Save)
   const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
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
      overlayClassName="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm z-[1000] flex items-center justify-center"
      // Apply content classes directly
      className="relative bg-content2 dark:bg-content1 rounded-lg shadow-xl p-5 m-4 max-w-lg w-full border-1 border-content3 dark:border-content2 outline-none transition-all duration-200" 
      contentLabel={t('editMessage')}
      ariaHideApp={false} // Set to true if you configure appElement
    >
      {message && ( // Only render content if message exists
        <div className="flex flex-col">
          {/* Use Tailwind classes */}
          <h2 className="text-lg font-semibold mb-3 text-foreground dark:text-foreground">
            {t('editMessage')}
          </h2>
          <Textarea
            ref={editInputRef}
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            onKeyDown={handleKeyDown as unknown as KeyboardEventHandler<HTMLInputElement>} // Use onKeyDown on Textarea
            fullWidth
            minRows={3}
            maxRows={10}
            size="sm"
            variant="bordered"
            className="text-sm mb-4" // Use text-sm for consistency
            classNames={{
              input: "text-foreground dark:text-foreground text-sm leading-normal placeholder:text-foreground-400 dark:placeholder:text-foreground-500", // Ensure dark text is visible
              inputWrapper: "p-2 bg-content3 dark:bg-content2 border-content4 dark:border-content3 focus-within:border-primary dark:focus-within:border-primary transition-colors", // Style wrapper
            }}
            placeholder={t('enterYourMessage')} // Use translation for placeholder
          />
          <div className="flex justify-end gap-2 mt-2">
            {/* Use t function for buttons */}
            <Button 
              variant="flat" 
              size="sm" 
              onPress={onClose}
              className="text-default-600 hover:bg-content3 dark:hover:bg-content2 transition-colors"
            >
              {t('cancel')}
            </Button>
            <Button 
              variant="light" 
              color="primary" 
              size="sm" 
              onPress={handleSaveClick} 
              title={t('saveTitle')}
              className="text-primary hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
            >
              <Icon icon="lucide:save" className="mr-1" width={14} height={14}/> {t('save')}
            </Button>
            <Button 
              color="primary" 
              size="sm" 
              onPress={handleSaveAndAskAIClick} 
              title={t('saveAndAskAITitle')}
              className="bg-primary hover:bg-primary-600 dark:bg-primary-700 dark:hover:bg-primary-800 text-white transition-colors"
            >
               <Icon icon="lucide:sparkles" className="mr-1" width={14} height={14}/> {t('saveAndAskAI')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}; 