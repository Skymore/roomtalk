// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureIntro } from './FeatureIntro';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('FeatureIntro', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('runs the primary action when clicked', async () => {
    const onAction = vi.fn(async () => undefined);
    render(
      <FeatureIntro
        featureKey="test-feature"
        title="New setting"
        description="Use this feature from settings."
        actionLabel="Start"
        onAction={onAction}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  });

  it('persists dismissal by feature key', () => {
    const { rerender } = render(
      <FeatureIntro
        featureKey="dismissed-feature"
        title="Dismiss me"
        description="This should go away."
      />
    );

    fireEvent.click(screen.getByLabelText('dismissIntro'));
    expect(localStorage.getItem('ftue:dismissed-feature')).toBe('dismissed');

    rerender(
      <FeatureIntro
        featureKey="dismissed-feature"
        title="Dismiss me"
        description="This should go away."
      />
    );

    expect(screen.queryByText('Dismiss me')).toBeNull();
  });
});
