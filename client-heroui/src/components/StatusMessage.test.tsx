// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusMessage } from './StatusMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@iconify/react', () => ({
  Icon: ({ icon, ...props }: { icon: string; 'aria-hidden'?: boolean | 'true' | 'false' }) => (
    <span data-icon={icon} {...props} />
  ),
}));

vi.mock('@heroui/react', () => ({
  Button: ({ children, onPress, ...props }: {
    children: React.ReactNode;
    onPress?: () => void;
    [key: string]: unknown;
  }) => {
    const { size: _size, variant: _variant, color: _color, ...buttonProps } = props;
    return <button type="button" onClick={onPress} {...buttonProps}>{children}</button>;
  },
}));

describe('StatusMessage', () => {
  afterEach(cleanup);

  it('announces errors assertively and lets the user dismiss them', () => {
    const setError = vi.fn();
    render(<StatusMessage error="Could not join" success={null} setError={setError} />);

    expect(screen.getByRole('alert').textContent).toContain('Could not join');
    expect(screen.getByRole('alert').getAttribute('aria-atomic')).toBe('true');
    expect(screen.getByRole('alert').querySelector('[data-icon="lucide:alert-circle"]')?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(setError).toHaveBeenCalledWith(null);
  });

  it('uses a polite status region for success and never announces success over an error', () => {
    const { rerender } = render(<StatusMessage error={null} success="Saved" />);
    expect(screen.getByRole('status').textContent).toContain('Saved');

    rerender(<StatusMessage error="Failed" success="Saved" />);
    expect(screen.getByRole('alert').textContent).toContain('Failed');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
