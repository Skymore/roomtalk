import {
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FolderTree,
  Globe2,
  LoaderCircle,
  RefreshCw,
  WrapText,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileBreadcrumbs, isMarkdownPreviewFile } from './codeAgentFilePath';

const COPY_FEEDBACK_DURATION_MS = 1200;

interface CodeAgentFilePreviewHeaderProps {
  projectName: string;
  relativePath: string | null;
  renderPreview: boolean;
  wordWrap: boolean;
  explorerOpen: boolean;
  browserPreviewPending: boolean;
  externalPreviewUrl?: string | null;
  externalPreviewPending?: boolean;
  canToggleFileWordWrap: boolean;
  canOpenInBrowserPreview: boolean;
  supportsPreview: boolean;
  refreshCurrentFilePending: boolean;
  mobileLayout?: boolean;
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
  externalPreviewUrl,
  externalPreviewPending = false,
  canToggleFileWordWrap,
  canOpenInBrowserPreview,
  supportsPreview,
  refreshCurrentFilePending,
  mobileLayout = false,
  onRefreshCurrentFile,
  onDownloadFile,
  onToggleWordWrap,
  onOpenInBrowserPreview,
  onTogglePreviewView,
  onToggleExplorer,
}: CodeAgentFilePreviewHeaderProps) {
  const { t } = useTranslation();
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [breadcrumbFade, setBreadcrumbFade] = useState({ left: false, right: false });
  const [copiedPath, setCopiedPath] = useState(false);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const breadcrumbs = useMemo(() => {
    if (!relativePath) {
      return [];
    }
    const nextBreadcrumbs = fileBreadcrumbs(projectName, relativePath);
    return mobileLayout
      ? nextBreadcrumbs.filter((crumb) => crumb.kind !== 'project')
      : nextBreadcrumbs;
  }, [mobileLayout, projectName, relativePath]);
  const wordWrapLabel = wordWrap
    ? t('codeAgentDisableFileLineWrapping')
    : t('codeAgentEnableFileLineWrapping');
  const previewToggleLabel = isMarkdown
    ? (renderPreview ? t('codeAgentShowMarkdownSource') : t('codeAgentShowRenderedMarkdown'))
    : (renderPreview ? t('codeAgentShowSource') : t('codeAgentShowPreview'));
  const refreshCurrentFileLabel = t('codeAgentRefreshWorkspaceFile');
  const copyFilePathLabel = copiedPath ? t('copied') : t('codeAgentCopyFilePath');
  const openExternalPreviewLabel = t('codeAgentOpenBrowserPreviewExternally');

  const clearCopyFeedbackTimer = useCallback(() => {
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
  }, []);

  const updateBreadcrumbFade = useCallback(() => {
    const element = breadcrumbRef.current;
    if (!element) {
      return;
    }
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const next = {
      left: maxScrollLeft > 1 && element.scrollLeft > 1,
      right: maxScrollLeft > 1 && element.scrollLeft < maxScrollLeft - 1,
    };
    setBreadcrumbFade((current) => (
      current.left === next.left && current.right === next.right ? current : next
    ));
  }, []);

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      '[data-current-file-crumb="true"]',
    );
    currentCrumb?.scrollIntoView?.({ block: 'nearest', inline: 'end' });
    const frameId = window.requestAnimationFrame(updateBreadcrumbFade);
    return () => window.cancelAnimationFrame(frameId);
  }, [relativePath, updateBreadcrumbFade]);

  useEffect(() => {
    const element = breadcrumbRef.current;
    if (!element) {
      return undefined;
    }

    updateBreadcrumbFade();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateBreadcrumbFade);
      return () => window.removeEventListener('resize', updateBreadcrumbFade);
    }

    const observer = new ResizeObserver(updateBreadcrumbFade);
    observer.observe(element);
    if (element.firstElementChild) {
      observer.observe(element.firstElementChild);
    }
    return () => observer.disconnect();
  }, [breadcrumbs, updateBreadcrumbFade]);

  useEffect(() => () => {
    clearCopyFeedbackTimer();
  }, [clearCopyFeedbackTimer]);

  useEffect(() => {
    clearCopyFeedbackTimer();
    setCopiedPath(false);
  }, [clearCopyFeedbackTimer, relativePath]);

  const handleCopyFilePath = useCallback(() => {
    if (!relativePath || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        setCopiedPath(true);
        clearCopyFeedbackTimer();
        copyFeedbackTimerRef.current = setTimeout(() => {
          setCopiedPath(false);
          copyFeedbackTimerRef.current = null;
        }, COPY_FEEDBACK_DURATION_MS);
      },
      () => {
        setCopiedPath(false);
      },
    );
  }, [clearCopyFeedbackTimer, relativePath]);

  const handleOpenExternalPreview = useCallback(() => {
    if (!externalPreviewUrl) {
      return;
    }
    window.open(externalPreviewUrl, '_blank', 'noopener,noreferrer');
  }, [externalPreviewUrl]);

  if (!relativePath) {
    return null;
  }

  const breadcrumbStrip = (
    <div className="relative min-w-0 flex-1" data-file-breadcrumb-fades="true">
      <div
        ref={breadcrumbRef}
        className="min-w-0 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-file-breadcrumbs="true"
        data-testid="code-agent-file-breadcrumbs"
        onScroll={updateBreadcrumbFade}
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
      {breadcrumbFade.left ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-5 bg-gradient-to-r from-[#faf9f5] to-transparent dark:from-[#1d1d1b]"
          data-testid="code-agent-file-breadcrumb-fade-left"
        />
      ) : null}
      {breadcrumbFade.right ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-[#faf9f5] to-transparent dark:from-[#1d1d1b]"
          data-testid="code-agent-file-breadcrumb-fade-right"
        />
      ) : null}
    </div>
  );

  const copyButtonClassName = `${mobileLayout
    ? 'inline-flex h-8 w-8 items-center justify-center rounded-md'
    : 'rounded-md p-1.5'
  } shrink-0 transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5] ${
    copiedPath
      ? 'text-[#9f462c] dark:text-[#ffb197]'
      : 'text-[#87867f] dark:text-[#8f8d86]'
  }`;

  const copyButton = (
    <button
      type="button"
      className={copyButtonClassName}
      aria-label={copyFilePathLabel}
      title={copyFilePathLabel}
      data-testid="code-agent-file-copy-path-button"
      onClick={handleCopyFilePath}
    >
      {copiedPath ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );

  if (mobileLayout) {
    const mobileIconButtonClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#87867f] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] disabled:cursor-wait disabled:opacity-60 dark:text-[#8f8d86] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]';
    const mobileActiveIconButtonClass = `${mobileIconButtonClass} text-[#9f462c] dark:text-[#ffb197]`;

    return (
      <div
        className="surface-subheader flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#dedbd0] px-2 py-1 [scrollbar-width:none] dark:border-[#30302e] [&::-webkit-scrollbar]:hidden"
        data-mobile-file-preview-header="true"
        data-surface-subheader
        data-testid="code-agent-mobile-file-preview-header"
      >
        <div className="min-w-[7rem] flex-1" data-testid="code-agent-mobile-file-preview-breadcrumb-row">
          {breadcrumbStrip}
        </div>
        <div className="flex min-w-max shrink-0 items-center gap-1" data-testid="code-agent-mobile-file-preview-action-row">
          {copyButton}
          {supportsPreview ? (
            <button
              type="button"
              className={renderPreview ? mobileActiveIconButtonClass : mobileIconButtonClass}
              aria-label={previewToggleLabel}
              aria-pressed={renderPreview}
              title={previewToggleLabel}
              onClick={onTogglePreviewView}
            >
              {renderPreview ? <Code2 className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={mobileIconButtonClass}
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
                className={mobileIconButtonClass}
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
                className={`${mobileIconButtonClass} ${wordWrap ? 'text-[#9f462c] dark:text-[#ffb197]' : ''}`}
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
                className={mobileIconButtonClass}
                aria-label={t('codeAgentOpenFileInPreview')}
                title={t('codeAgentOpenFileInPreview')}
                disabled={browserPreviewPending}
                onClick={onOpenInBrowserPreview}
              >
                {browserPreviewPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            {externalPreviewUrl !== undefined ? (
              <button
                type="button"
                className={mobileIconButtonClass}
                aria-label={openExternalPreviewLabel}
                title={openExternalPreviewLabel}
                disabled={externalPreviewPending || externalPreviewUrl === null}
                onClick={handleOpenExternalPreview}
              >
                {externalPreviewPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            <button
              type="button"
              className={`${mobileIconButtonClass} ${explorerOpen ? 'text-[#9f462c] dark:text-[#ffb197]' : ''}`}
              aria-label={explorerOpen ? t('codeAgentHideFileExplorer') : t('codeAgentShowFileExplorer')}
              aria-pressed={explorerOpen}
              title={explorerOpen ? t('codeAgentHideFileExplorer') : t('codeAgentShowFileExplorer')}
              onClick={onToggleExplorer}
            >
              <FolderTree className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="surface-subheader flex h-9 shrink-0 items-center gap-2 border-b border-[#dedbd0] px-3 dark:border-[#30302e]" data-surface-subheader>
      {breadcrumbStrip}
      {copyButton}
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
