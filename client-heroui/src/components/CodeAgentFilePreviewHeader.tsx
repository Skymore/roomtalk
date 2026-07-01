import {
  ChevronRight,
  Code2,
  Download,
  Eye,
  FolderTree,
  Globe2,
  LoaderCircle,
  RefreshCw,
  WrapText,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { fileBreadcrumbs } from './codeAgentFilePath';
import { isMarkdownPreviewFile } from './codeAgentFilePreviewMode';

interface CodeAgentFilePreviewHeaderProps {
  projectName: string;
  relativePath: string | null;
  renderPreview: boolean;
  wordWrap: boolean;
  explorerOpen: boolean;
  browserPreviewPending: boolean;
  canToggleFileWordWrap: boolean;
  canOpenInBrowserPreview: boolean;
  supportsPreview: boolean;
  refreshCurrentFilePending: boolean;
  onRefreshCurrentFile: () => void;
  onDownloadFile?: () => void;
  onToggleWordWrap: () => void;
  onOpenInBrowserPreview: () => void;
  onTogglePreviewView: () => void;
  onToggleExplorer: () => void;
}

export function CodeAgentFilePreviewHeader({
  projectName,
  relativePath,
  renderPreview,
  wordWrap,
  explorerOpen,
  browserPreviewPending,
  canToggleFileWordWrap,
  canOpenInBrowserPreview,
  supportsPreview,
  refreshCurrentFilePending,
  onRefreshCurrentFile,
  onDownloadFile,
  onToggleWordWrap,
  onOpenInBrowserPreview,
  onTogglePreviewView,
  onToggleExplorer,
}: CodeAgentFilePreviewHeaderProps) {
  const { t } = useTranslation();
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const wordWrapLabel = wordWrap
    ? t('codeAgentDisableFileLineWrapping')
    : t('codeAgentEnableFileLineWrapping');
  const previewToggleLabel = isMarkdown
    ? (renderPreview ? t('codeAgentShowMarkdownSource') : t('codeAgentShowRenderedMarkdown'))
    : (renderPreview ? t('codeAgentShowSource') : t('codeAgentShowPreview'));
  const refreshCurrentFileLabel = t('codeAgentRefreshWorkspaceFile');

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      '[data-current-file-crumb="true"]',
    );
    currentCrumb?.scrollIntoView?.({ block: 'nearest', inline: 'end' });
  }, [relativePath]);

  if (!relativePath) {
    return null;
  }

  return (
    <div className="surface-subheader flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]" data-surface-subheader>
      <div
        ref={breadcrumbRef}
        className="min-w-0 flex-1 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-file-breadcrumbs="true"
        data-testid="code-agent-file-breadcrumbs"
      >
        <div className="flex h-full w-max min-w-full items-center">
          {breadcrumbs.map((crumb, index) => (
            <div
              key={crumb.path || 'project'}
              className="flex min-w-0 shrink-0 items-center"
              data-current-file-crumb={crumb.kind === 'file'}
            >
              {index > 0 ? <ChevronRight className="mx-1 h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" /> : null}
              <span
                className={`max-w-40 truncate ${crumb.kind === 'file' ? 'font-medium text-[#141413] dark:text-[#faf9f5]' : 'text-[#87867f] dark:text-[#8f8d86]'}`}
                title={crumb.path || projectName}
              >
                {crumb.label}
              </span>
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
        aria-label={refreshCurrentFileLabel}
        title={refreshCurrentFileLabel}
        disabled={refreshCurrentFilePending}
        onClick={onRefreshCurrentFile}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshCurrentFilePending ? 'animate-spin' : ''}`} />
      </button>
      {onDownloadFile ? (
        <button
          type="button"
          className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          aria-label={t('codeAgentDownloadFile')}
          title={t('codeAgentDownloadFile')}
          onClick={onDownloadFile}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {canToggleFileWordWrap ? (
        <button
          type="button"
          className={`rounded-md p-1.5 transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
            wordWrap
              ? 'text-[#9f462c] dark:text-[#ffb197]'
              : 'text-[#87867f] dark:text-[#8f8d86]'
          }`}
          aria-label={wordWrapLabel}
          aria-pressed={wordWrap}
          title={wordWrapLabel}
          onClick={onToggleWordWrap}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {canOpenInBrowserPreview ? (
        <button
          type="button"
          className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          aria-label={t('codeAgentOpenFileInPreview')}
          title={t('codeAgentOpenFileInPreview')}
          disabled={browserPreviewPending}
          onClick={onOpenInBrowserPreview}
        >
          {browserPreviewPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      {supportsPreview ? (
        <button
          type="button"
          className="rounded-md p-1.5 text-[#87867f] hover:bg-[#f0eee6] hover:text-[#141413] dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
          aria-label={previewToggleLabel}
          aria-pressed={renderPreview}
          title={previewToggleLabel}
          onClick={onTogglePreviewView}
        >
          {renderPreview ? <Code2 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      ) : null}
      <button
        type="button"
        className={`rounded-md p-1.5 transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
          explorerOpen
            ? 'text-[#9f462c] dark:text-[#ffb197]'
            : 'text-[#87867f] dark:text-[#8f8d86]'
        }`}
        aria-label={explorerOpen ? t('codeAgentHideFileExplorer') : t('codeAgentShowFileExplorer')}
        aria-pressed={explorerOpen}
        title={explorerOpen ? t('codeAgentHideFileExplorer') : t('codeAgentShowFileExplorer')}
        onClick={onToggleExplorer}
      >
        <FolderTree className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
