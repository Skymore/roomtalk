// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const katexRenderMock = vi.hoisted(() => vi.fn());

vi.mock('katex', () => ({
  default: {
    render: katexRenderMock,
  },
  render: katexRenderMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('MarkdownContent math rendering', () => {
  afterEach(() => {
    cleanup();
    katexRenderMock.mockReset();
  });

  it('does not enable trusted KaTeX commands for user-authored formulas', async () => {
    const { MarkdownContent } = await import('./MarkdownContent');
    render(<MarkdownContent content={'$x$'} />);

    await waitFor(() => expect(katexRenderMock).toHaveBeenCalled());
    const options = katexRenderMock.mock.calls[0][2];
    expect(options.trust).toBe(false);
  }, 15_000);

  it('renders raw HTML as text instead of creating DOM elements', async () => {
    const { MarkdownContent } = await import('./MarkdownContent');
    const { container } = render(<MarkdownContent content={'hello <img src=x onerror=alert(1)> world'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  }, 15_000);
});
