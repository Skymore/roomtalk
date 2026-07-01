// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentFilePreviewHeader } from './CodeAgentFilePreviewHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const defaultProps = {
  projectName: 'Coco',
  relativePath: 'docs/Guide.md',
  renderPreview: false,
  wordWrap: false,
  explorerOpen: true,
  browserPreviewPending: false,
  canToggleFileWordWrap: true,
  canOpenInBrowserPreview: true,
  supportsPreview: true,
  refreshCurrentFilePending: false,
  onRefreshCurrentFile: vi.fn(),
  onDownloadFile: vi.fn(),
  onToggleWordWrap: vi.fn(),
  onOpenInBrowserPreview: vi.fn(),
  onTogglePreviewView: vi.fn(),
  onToggleExplorer: vi.fn(),
};

describe('CodeAgentFilePreviewHeader', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the T3-style file preview subheader breadcrumbs and actions', () => {
    render(<CodeAgentFilePreviewHeader {...defaultProps} />);

    const breadcrumbs = screen.getByTestId('code-agent-file-breadcrumbs');
    expect(within(breadcrumbs).getByText('Coco')).toBeTruthy();
    expect(within(breadcrumbs).getByText('docs')).toBeTruthy();
    expect(within(breadcrumbs).getByText('Guide.md')).toBeTruthy();
    expect(breadcrumbs.querySelector('[data-current-file-crumb="true"]')?.textContent).toContain('Guide.md');
    const subheader = breadcrumbs.closest('[data-surface-subheader]');
    expect(subheader).toBeTruthy();
    expect(subheader?.className).toContain('surface-subheader');
    expect(subheader?.className).toContain('h-9');
    expect(subheader?.className).toContain('border-b');
    expect(screen.getByLabelText('codeAgentDownloadFile').getAttribute('title')).toBe('codeAgentDownloadFile');
    expect(screen.getByLabelText('codeAgentOpenFileInPreview').getAttribute('title')).toBe('codeAgentOpenFileInPreview');
    expect(screen.getByLabelText('codeAgentShowRenderedMarkdown').getAttribute('title')).toBe('codeAgentShowRenderedMarkdown');
    expect(screen.getByLabelText('codeAgentHideFileExplorer').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('codeAgentHideFileExplorer').className).toContain('text-[#9f462c]');

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspaceFile'));
    fireEvent.click(screen.getByLabelText('codeAgentDownloadFile'));
    fireEvent.click(screen.getByLabelText('codeAgentEnableFileLineWrapping'));
    fireEvent.click(screen.getByLabelText('codeAgentOpenFileInPreview'));
    fireEvent.click(screen.getByLabelText('codeAgentShowRenderedMarkdown'));
    fireEvent.click(screen.getByLabelText('codeAgentHideFileExplorer'));

    expect(defaultProps.onRefreshCurrentFile).toHaveBeenCalledTimes(1);
    expect(defaultProps.onDownloadFile).toHaveBeenCalledTimes(1);
    expect(defaultProps.onToggleWordWrap).toHaveBeenCalledTimes(1);
    expect(defaultProps.onOpenInBrowserPreview).toHaveBeenCalledTimes(1);
    expect(defaultProps.onTogglePreviewView).toHaveBeenCalledTimes(1);
    expect(defaultProps.onToggleExplorer).toHaveBeenCalledTimes(1);
  });

  it('keeps the cloud preview action disabled while a browser preview is opening', () => {
    render(
      <CodeAgentFilePreviewHeader
        {...defaultProps}
        browserPreviewPending
        renderPreview
        wordWrap
        explorerOpen={false}
      />,
    );

    expect((screen.getByLabelText('codeAgentOpenFileInPreview') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('codeAgentShowMarkdownSource').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('codeAgentDisableFileLineWrapping').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('codeAgentShowFileExplorer').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByLabelText('codeAgentShowFileExplorer').getAttribute('title')).toBe('codeAgentShowFileExplorer');
  });

  it('omits optional actions when no file is selected or preview controls are unavailable', () => {
    const { rerender } = render(<CodeAgentFilePreviewHeader {...defaultProps} relativePath={null} />);

    expect(screen.queryByTestId('code-agent-file-breadcrumbs')).toBeNull();

    rerender(
      <CodeAgentFilePreviewHeader
        {...defaultProps}
        relativePath="src/App.tsx"
        onDownloadFile={undefined}
        canToggleFileWordWrap={false}
        canOpenInBrowserPreview={false}
        supportsPreview={false}
      />,
    );

    expect(screen.queryByLabelText('codeAgentDownloadFile')).toBeNull();
    expect(screen.queryByLabelText('codeAgentEnableFileLineWrapping')).toBeNull();
    expect(screen.queryByLabelText('codeAgentOpenFileInPreview')).toBeNull();
    expect(screen.queryByLabelText('codeAgentShowPreview')).toBeNull();
  });
});
