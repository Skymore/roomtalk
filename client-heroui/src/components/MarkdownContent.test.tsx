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
    document.getElementById('roomtalk-pierre-file-icon-sprite')?.remove();
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

  it('renders T3-style workspace file links as file chips and opens them in the right file viewer', () => {
    const onOpenWorkspaceFile = vi.fn();
    const { getAllByTestId, getByText } = render(
      <MarkdownContent
        content={'Open [App](src/App.tsx#L42) and [server](/workspace/package.json:8).'}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    const fileLinks = getAllByTestId('code-agent-markdown-file-link');
    expect(fileLinks).toHaveLength(2);
    expect(getByText('App.tsx · L42')).toBeTruthy();
    expect(getByText('package.json · L8')).toBeTruthy();
    expect(fileLinks[0].getAttribute('title')).toBe('workspace/src/App.tsx:42');
    expect(fileLinks[1].getAttribute('title')).toBe('workspace/package.json:8');
    expect(fileLinks[1].querySelector('[data-pierre-icon="t3-file-icon-package-json"]')).toBeTruthy();

    fireEvent.click(getByText('App.tsx · L42'));
    fireEvent.click(getByText('package.json · L8'));

    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(1, '/workspace/src/App.tsx:42');
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, '/workspace/package.json:8');
  });

  it('opens T3-style browser preview file links through the preview callback first', () => {
    const onOpenWorkspaceFile = vi.fn();
    const onOpenWorkspaceFileInBrowserPreview = vi.fn();
    const { getByText } = render(
      <MarkdownContent
        content={'Open [report](/workspace/output/report.html#L4) and [guide](docs/Guide.md#L2).'}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onOpenWorkspaceFileInBrowserPreview={onOpenWorkspaceFileInBrowserPreview}
      />,
    );

    fireEvent.click(getByText('report.html · L4'));
    fireEvent.click(getByText('Guide.md · L2'));

    expect(onOpenWorkspaceFileInBrowserPreview).toHaveBeenCalledWith('/workspace/output/report.html');
    expect(onOpenWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/workspace/docs/Guide.md:2');
  });

  it('renders T3-style code fence titles with Pierre file icons', () => {
    const { getByText } = render(
      <MarkdownContent content={'```tsx title="src/App.tsx"\nexport const App = () => null;\n```'} />,
    );

    const title = getByText('src/App.tsx');
    const headerTitle = title.closest('span')?.parentElement;
    expect(headerTitle?.querySelector('[data-pierre-icon]')).toBeTruthy();
  });

  it('normalizes T3-style bare code fence filenames before rendering code headers', () => {
    const { getByText } = render(
      <MarkdownContent content={'```ts src/lib/client.ts\nexport const client = true;\n```'} />,
    );

    expect(getByText('src/lib/client.ts')).toBeTruthy();
  });

  it('normalizes T3-style unquoted filename attributes before rendering code headers', () => {
    const { getByText } = render(
      <MarkdownContent content={'```tsx filename=src/App.tsx\nexport const App = () => null;\n```'} />,
    );

    expect(getByText('src/App.tsx')).toBeTruthy();
  });

  it('renders T3-style language icons for code fences without titles', () => {
    const { getByLabelText } = render(
      <MarkdownContent content={'```tsx\nexport const App = () => null;\n```'} />,
    );

    const languageIcon = getByLabelText('Language: tsx');
    expect(languageIcon.querySelector('[data-pierre-icon]')).toBeTruthy();
  });

  it('adds T3 parent suffixes when markdown file chips have duplicate basenames', () => {
    const onOpenWorkspaceFile = vi.fn();
    const { getAllByTestId, getByText } = render(
      <MarkdownContent
        content={'Compare [primary](src/components/Button.tsx) with [test](src/lib/Button.tsx#L12).'}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    const fileLinks = getAllByTestId('code-agent-markdown-file-link');
    expect(fileLinks).toHaveLength(2);
    expect(getByText('Button.tsx · src/components')).toBeTruthy();
    expect(getByText('Button.tsx · src/lib · L12')).toBeTruthy();
    expect(fileLinks[0].getAttribute('title')).toBe('workspace/src/components/Button.tsx');
    expect(fileLinks[1].getAttribute('title')).toBe('workspace/src/lib/Button.tsx:12');
  });

  it('does not intercept external markdown links for the workspace viewer', () => {
    const onOpenWorkspaceFile = vi.fn();
    const { getByText } = render(
      <MarkdownContent
        content={'Visit [docs](https://example.com/docs).'}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    const link = getByText('docs').closest('a');
    link?.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(getByText('docs'));

    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });
});
