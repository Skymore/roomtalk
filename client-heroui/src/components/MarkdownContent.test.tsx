// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

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
    render(<MarkdownContent content={'$x$'} />);

    await waitFor(() => expect(katexRenderMock).toHaveBeenCalled());
    const options = katexRenderMock.mock.calls[0][2];
    expect(options.trust).toBe(false);
  }, 15_000);

  it('renders raw HTML as text instead of creating DOM elements', async () => {
    const { container } = render(<MarkdownContent content={'hello <img src=x onerror=alert(1)> world'} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  }, 15_000);

  it('reports T3-style markdown task marker offsets when checkboxes change', () => {
    const onTaskListChange = vi.fn();
    const { getAllByRole } = render(
      <MarkdownContent
        content={'- [ ] First\n- [x] Second\n'}
        onTaskListChange={onTaskListChange}
      />,
    );

    const checkboxes = getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(false);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    expect(onTaskListChange).toHaveBeenNthCalledWith(1, { markerOffset: 2, checked: true });
    expect(onTaskListChange).toHaveBeenNthCalledWith(2, { markerOffset: 14, checked: false });
  });
});
