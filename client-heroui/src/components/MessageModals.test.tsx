// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Modal from 'react-modal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteConfirmationModal } from './DeleteConfirmationModal';
import { EditMessageModal } from './EditMessageModal';
import type { Message } from '../utils/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const message: Message = {
  id: 'message-1',
  clientId: 'client-1',
  roomId: 'room-1',
  content: 'edit this',
  timestamp: '2026-07-10T00:00:00.000Z',
  messageType: 'text',
};

const createAppRoot = () => {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  Modal.setAppElement(root);
  return root;
};

describe('message modals', () => {
  afterEach(() => {
    cleanup();
    document.getElementById('root')?.remove();
  });

  it('hides the app from assistive technology and restores focus for edit', async () => {
    const appRoot = createAppRoot();
    const Harness = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open edit</button>
          <EditMessageModal
            isOpen={open}
            onClose={() => setOpen(false)}
            message={message}
            onSave={vi.fn()}
            onSaveAndAskAI={vi.fn()}
          />
        </>
      );
    };
    render(<Harness />, { container: appRoot });
    const trigger = screen.getByRole('button', { name: 'open edit' });
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() => expect(appRoot.getAttribute('aria-hidden')).toBe('true'));
    expect(screen.getByRole('dialog', { name: 'editMessage' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'editMessage' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(appRoot.hasAttribute('aria-hidden')).toBe(false);
  });

  it('uses the same background isolation for delete confirmation', async () => {
    const appRoot = createAppRoot();
    const Harness = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>open delete</button>
          <DeleteConfirmationModal
            isOpen={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            messageContent="delete this"
          />
        </>
      );
    };
    render(<Harness />, { container: appRoot });
    fireEvent.click(screen.getByRole('button', { name: 'open delete' }));

    await waitFor(() => expect(appRoot.getAttribute('aria-hidden')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'confirmDeletion' })).toBeNull());
    expect(appRoot.hasAttribute('aria-hidden')).toBe(false);
  });
});
