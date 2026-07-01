import { VirtualizedFile } from '@pierre/diffs';
import { File as DiffFile, type FileOptions, Virtualizer } from '@pierre/diffs/react';
import {
  Download,
  LoaderCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  writeCodeWorkspaceFile,
  type CodeWorkspaceFile,
} from '../utils/codeWorkspaceFiles';
import { resolveCodeAgentDiffThemeName } from '../utils/codeAgentDiffRendering';
import {
  appendWorkspaceAssetPreviewRevision,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
} from '../utils/codeWorkspaceFilePreview';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
import { CodeAgentEditableFileSurface } from './CodeAgentEditableFileSurface';
import { CodeAgentFilePreviewHeader } from './CodeAgentFilePreviewHeader';
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from './codeAgentFilePreviewMode';
import {
  confirmCodeAgentProjectFileQueryData,
  getOptimisticCodeAgentProjectFileQueryData,
  setCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';

const MarkdownContent = React.lazy(() =>
  import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })),
);

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type FilePostRender = NonNullable<FileOptions<unknown>['onPostRender']>;

const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_LINK_REVEAL_ATTRIBUTE = 'data-file-link-reveal';
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function updateWorkspaceFileContents(
  current: CodeWorkspaceFile | null,
  path: string,
  contents: string,
): CodeWorkspaceFile | null {
  if (!current || normalizeWorkspacePath(current.path) !== normalizeWorkspacePath(path)) {
    return current;
  }
  return {
    ...current,
    content: contents,
    byteSize: new TextEncoder().encode(contents).byteLength,
    truncated: false,
    encoding: 'utf-8',
  };
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) {
    return;
  }

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '');
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, '');
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const handledRequestIdsByPathRef = useRef(new Map<string, number>());
  const latestRequestIdsByPathRef = useRef(new Map<string, number>());
  const pendingFramesByPathRef = useRef(new Map<string, number>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const pendingFramesByPath = pendingFramesByPathRef.current;
      const latestRequestIdsByPath = latestRequestIdsByPathRef.current;
      const handledRequestIdsByPath = handledRequestIdsByPathRef.current;
      const cancelPendingReveal = () => {
        const frameId = pendingFramesByPath.get(relativePath);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          pendingFramesByPath.delete(relativePath);
        }
      };

      if (phase === 'unmount') {
        cancelPendingReveal();
        return;
      }

      const targetLine = revealLine === null ? null : clampFileLine(instance.file?.contents ?? '', revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId) {
        cancelPendingReveal();
        latestRequestIdsByPath.set(relativePath, revealRequestId);
      }

      if (targetLine === null) {
        fileContainer.style.minHeight = '';
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>('.file-preview-virtualizer');
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(Math.max(instance.height, scrollContainer.clientHeight))}px`;

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      ) {
        return;
      }

      const reveal = () => {
        pendingFramesByPath.delete(relativePath);
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        ) {
          return;
        }

        const linePosition = instance.getLinePosition(targetLine);
        if (!linePosition) return;

        const fileTop = scrollContainer.scrollTop
          + fileContainer.getBoundingClientRect().top
          - scrollContainer.getBoundingClientRect().top;
        const centeredTop = Math.max(
          0,
          fileTop + linePosition.top - Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        );
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop);
        handledRequestIdsByPath.set(relativePath, revealRequestId);
      };

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal));
    },
    [relativePath, revealLine, revealRequestId],
  );
}

function decodeWorkspaceFile(file: CodeWorkspaceFile): BlobPart {
  if (file.encoding === 'utf-8') {
    return file.content;
  }

  const binary = window.atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function inferMimeType(path: string, encoding: CodeWorkspaceFile['encoding']) {
  if (/\.(png)$/i.test(path)) return 'image/png';
  if (/\.(jpe?g)$/i.test(path)) return 'image/jpeg';
  if (/\.(gif)$/i.test(path)) return 'image/gif';
  if (/\.(webp)$/i.test(path)) return 'image/webp';
  if (/\.(svg)$/i.test(path)) return 'image/svg+xml';
  if (/\.(pdf)$/i.test(path)) return 'application/pdf';
  if (encoding === 'base64') return 'application/octet-stream';
  if (/\.(html?)$/i.test(path)) return 'text/html;charset=utf-8';
  if (/\.(json)$/i.test(path)) return 'application/json;charset=utf-8';
  if (/\.(css)$/i.test(path)) return 'text/css;charset=utf-8';
  if (/\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(path)) return 'text/javascript;charset=utf-8';
  if (/\.(md|markdown)$/i.test(path)) return 'text/markdown;charset=utf-8';
  return 'text/plain;charset=utf-8';
}

function createDownload(file: CodeWorkspaceFile) {
  const blob = new Blob([decodeWorkspaceFile(file)], {
    type: inferMimeType(file.path, file.encoding),
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.path.split('/').pop() || 'workspace-file';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function previewedByteSize(file: CodeWorkspaceFile): number {
  if (file.encoding === 'utf-8') {
    return new TextEncoder().encode(file.content).byteLength;
  }
  return Math.min(file.byteSize, Math.floor((file.content.length * 3) / 4));
}

interface ReadOnlyFileSurfaceProps {
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  wordWrap: boolean;
  onPostRender: FilePostRender;
}

function ReadOnlyFileSurface({
  file,
  resolvedTheme,
  wordWrap,
  onPostRender,
}: ReadOnlyFileSurfaceProps) {
  return (
    <div className="flex min-h-0 flex-1">
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{
          overscrollSize: 600,
          intersectionObserverMargin: 1200,
        }}
      >
        <DiffFile
          file={{
            name: file.path,
            contents: file.content,
            cacheKey: projectFileCacheKey('', file.path, file.content),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? 'wrap' : 'scroll',
            theme: resolveCodeAgentDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </div>
  );
}

interface RenderedMarkdownSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
}

function RenderedMarkdownSurface({
  roomId,
  file,
  onFileChange,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onOpenWorkspaceFile,
}: RenderedMarkdownSurfaceProps) {
  const filePath = file.path;
  const fileRef = useRef(file);
  const latestFilePathRef = useRef(filePath);
  const latestDraftContentsRef = useRef(file.content);

  useEffect(() => {
    fileRef.current = file;
    if (latestFilePathRef.current !== filePath) {
      latestFilePathRef.current = filePath;
      latestDraftContentsRef.current = file.content;
    }
  }, [file, filePath]);

  const setDraftFileContents = useCallback((contents: string) => {
    latestDraftContentsRef.current = contents;
    setCodeAgentProjectFileQueryData(roomId, filePath, contents);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const confirmFileContents = useCallback((contents: string) => {
    if (latestDraftContentsRef.current !== contents) {
      return;
    }
    confirmCodeAgentProjectFileQueryData(roomId, filePath, contents, fileRef.current);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId]);

  const handlePendingChange = useCallback((pending: boolean) => {
    onSaveStateChange(filePath, pending ? 'pending' : 'saved', null);
    onFileSavePendingChange?.(filePath, pending);
  }, [filePath, onFileSavePendingChange, onSaveStateChange]);

  const saveCoordinator = useMemo(
    () => new FileSaveCoordinator({
      debounceMs: FILE_SAVE_DEBOUNCE_MS,
      onPendingChange: handlePendingChange,
      persist: async (contents) => {
        onSaveStateChange(filePath, 'saving', null);
        try {
          await writeCodeWorkspaceFile(roomId, filePath, contents, 'utf-8');
          onEntriesChanged();
          return { _tag: 'Success' };
        } catch (error) {
          onSaveStateChange(filePath, 'error', error instanceof Error ? error.message : 'File save failed.');
          return { _tag: 'Failure' };
        }
      },
      onConfirmed: (contents) => {
        confirmFileContents(contents);
      },
    }),
    [confirmFileContents, filePath, handlePendingChange, onEntriesChanged, onSaveStateChange, roomId],
  );

  useEffect(() => () => saveCoordinator.dispose(), [saveCoordinator]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-5 text-[#141413] dark:text-[#faf9f5]">
        <React.Suspense fallback={<LoaderCircle className="h-5 w-5 animate-spin text-[#87867f] dark:text-[#8f8d86]" />}>
          <MarkdownContent
            content={file.content}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onTaskListChange={({ markerOffset, checked }) => {
              const currentContents = getOptimisticCodeAgentProjectFileQueryData(roomId, filePath)?.content
                ?? fileRef.current.content;
              const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
              if (nextContents === currentContents) return;
              fileRef.current = {
                ...fileRef.current,
                content: nextContents,
                byteSize: new TextEncoder().encode(nextContents).byteLength,
                truncated: false,
                encoding: 'utf-8',
              };
              setDraftFileContents(nextContents);
              saveCoordinator.change(nextContents);
            }}
          />
        </React.Suspense>
      </div>
    </div>
  );
}

interface FilePreviewSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile | null;
  relativePath: string | null;
  fileError: string | null;
  filePending: boolean;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  assetPreviewError: string | null;
  assetPreviewPending: boolean;
  assetPreviewResolvedUrl: string | null;
  assetPreviewRevision: number;
  resolvedTheme: 'light' | 'dark';
  renderPreview: boolean;
  wordWrap: boolean;
  revealLine: number | null;
  revealRequestId: number;
  saveState: SaveState;
  saveError: string | null;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onAssetPreviewChanged: (relativePath: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

function FilePreviewSurface({
  roomId,
  file,
  relativePath,
  fileError,
  filePending,
  onFileChange,
  assetPreviewError,
  assetPreviewPending,
  assetPreviewResolvedUrl,
  assetPreviewRevision,
  resolvedTheme,
  renderPreview,
  wordWrap,
  revealLine,
  revealRequestId,
  saveState,
  saveError,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onAssetPreviewChanged,
  onOpenWorkspaceFile,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: FilePreviewSurfaceProps) {
  const { t } = useTranslation();
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  const handleEntriesChanged = useCallback(() => {
    onEntriesChanged();
    if (relativePath && isWorkspacePreviewEntryPath(relativePath)) {
      onAssetPreviewChanged(relativePath);
    }
  }, [onAssetPreviewChanged, onEntriesChanged, relativePath]);

  useEffect(() => {
    if (relativePath) {
      onSaveStateChange(relativePath, 'idle', null);
    }
  }, [onSaveStateChange, relativePath]);

  if (!relativePath) {
    return null;
  }

  const renderBrowserAssetPreview = renderPreview && isWorkspaceBrowserPreviewPath(relativePath);
  const renderImageAssetPreview = renderPreview && isWorkspaceImagePreviewPath(relativePath);
  if (renderBrowserAssetPreview || renderImageAssetPreview) {
    if (assetPreviewError) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
          {assetPreviewError}
        </div>
      );
    }

    if (assetPreviewPending || !assetPreviewResolvedUrl) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[#87867f] dark:text-[#8f8d86]">
          <LoaderCircle className="h-5 w-5 animate-spin" />
        </div>
      );
    }

    const resolvedPreviewUrl = appendWorkspaceAssetPreviewRevision(assetPreviewResolvedUrl, assetPreviewRevision);

    return renderImageAssetPreview ? (
      <div className="min-h-0 flex-1 overflow-auto bg-[#f0eee6] p-4 dark:bg-[#141413]">
        <img src={resolvedPreviewUrl} alt={relativePath} className="mx-auto max-h-full max-w-full object-contain" />
      </div>
    ) : (
      <iframe src={resolvedPreviewUrl} title={relativePath} className="min-h-0 flex-1 border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    );
  }

  if (fileError && file === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
        {fileError}
      </div>
    );
  }

  if (filePending || !file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[#87867f] dark:text-[#8f8d86]">
        <LoaderCircle className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {fileError ? (
        <div className="shrink-0 border-b border-[#f0b49b]/50 bg-[#fff2ec] px-3 py-1.5 text-[11px] text-[#9f462c] dark:border-[#7a321f]/60 dark:bg-[#2a211d] dark:text-[#ff9b78]">
          {fileError}
        </div>
      ) : null}
      {saveState !== 'idle' && saveState !== 'saved' ? (
        <div className="shrink-0 border-b border-[#dedbd0] px-3 py-1.5 text-[11px] text-[#87867f] dark:border-[#30302e] dark:text-[#8f8d86]">
          {saveState === 'pending' ? t('codeAgentSavePending') : saveState === 'saving' ? t('codeAgentSaving') : saveError || 'File save failed.'}
        </div>
      ) : null}
      {file.encoding === 'base64' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-[#87867f] dark:text-[#8f8d86]">
          <div>{t('codeAgentBinaryPreviewUnavailable')}</div>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-[#dedbd0] px-2 py-1 text-[#141413] hover:bg-[#f0eee6] dark:border-[#30302e] dark:text-[#faf9f5] dark:hover:bg-[#30302e]" onClick={() => createDownload(file)}>
            <Download className="h-3.5 w-3.5" />
            {t('codeAgentDownloadFile')}
          </button>
        </div>
      ) : renderPreview && isMarkdownPreviewFile(file.path) ? (
        <RenderedMarkdownSurface
          roomId={roomId}
          file={file}
          onFileChange={onFileChange}
          onSaveStateChange={onSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={handleEntriesChanged}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      ) : file.truncated ? (
        <ReadOnlyFileSurface
          key={`${file.path}:${resolvedTheme}:${file.byteSize}`}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          onPostRender={onFilePostRender}
        />
      ) : (
        <CodeAgentEditableFileSurface
          key={`${file.path}:${resolvedTheme}`}
          roomId={roomId}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          onPostRender={onFilePostRender}
          revealRequestId={revealRequestId}
          onFileChange={onFileChange}
          onSaveStateChange={onSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={handleEntriesChanged}
          reviewComments={reviewComments}
          onAddReviewComment={onAddReviewComment}
          onRemoveReviewComment={onRemoveReviewComment}
          fileLinkRevealUnsafeCss={FILE_LINK_REVEAL_UNSAFE_CSS}
        />
      )}
    </div>
  );
}

interface CodeAgentFilePreviewPanelProps {
  roomId: string;
  projectName: string;
  relativePath: string | null;
  file: CodeWorkspaceFile | null;
  fileError: string | null;
  filePending: boolean;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  assetPreviewError: string | null;
  assetPreviewPending: boolean;
  assetPreviewResolvedUrl: string | null;
  assetPreviewRevision: number;
  resolvedTheme: 'light' | 'dark';
  renderPreview: boolean;
  wordWrap: boolean;
  revealLine: number | null;
  revealRequestId: number;
  saveState: SaveState;
  saveError: string | null;
  explorerOpen: boolean;
  explorer: React.ReactNode;
  browserPreviewPending: boolean;
  canToggleFileWordWrap: boolean;
  canOpenInBrowserPreview: boolean;
  supportsPreview: boolean;
  refreshCurrentFilePending: boolean;
  onRefreshCurrentFile: () => void;
  onToggleWordWrap: () => void;
  onOpenInBrowserPreview: () => void;
  onTogglePreviewView: () => void;
  onToggleExplorer: () => void;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onAssetPreviewChanged: (relativePath: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

export function CodeAgentFilePreviewPanel({
  roomId,
  projectName,
  relativePath,
  file,
  fileError,
  filePending,
  onFileChange,
  assetPreviewError,
  assetPreviewPending,
  assetPreviewResolvedUrl,
  assetPreviewRevision,
  resolvedTheme,
  renderPreview,
  wordWrap,
  revealLine,
  revealRequestId,
  saveState,
  saveError,
  explorerOpen,
  explorer,
  browserPreviewPending,
  canToggleFileWordWrap,
  canOpenInBrowserPreview,
  supportsPreview,
  refreshCurrentFilePending,
  onRefreshCurrentFile,
  onToggleWordWrap,
  onOpenInBrowserPreview,
  onTogglePreviewView,
  onToggleExplorer,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onAssetPreviewChanged,
  onOpenWorkspaceFile,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: CodeAgentFilePreviewPanelProps) {
  const { t } = useTranslation();
  const showTruncatedBanner = Boolean(relativePath && file?.truncated);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CodeAgentFilePreviewHeader
        projectName={projectName}
        relativePath={relativePath}
        renderPreview={renderPreview}
        wordWrap={wordWrap}
        explorerOpen={explorerOpen}
        browserPreviewPending={browserPreviewPending}
        canToggleFileWordWrap={canToggleFileWordWrap}
        canOpenInBrowserPreview={canOpenInBrowserPreview}
        supportsPreview={supportsPreview}
        refreshCurrentFilePending={refreshCurrentFilePending}
        onRefreshCurrentFile={onRefreshCurrentFile}
        onDownloadFile={file ? () => createDownload(file) : undefined}
        onToggleWordWrap={onToggleWordWrap}
        onOpenInBrowserPreview={onOpenInBrowserPreview}
        onTogglePreviewView={onTogglePreviewView}
        onToggleExplorer={onToggleExplorer}
      />
      {showTruncatedBanner && file ? (
        <div
          className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
          data-testid="code-agent-file-preview-truncated"
        >
          {t('codeAgentFilePreviewTruncated', {
            shown: previewedByteSize(file).toLocaleString(),
            total: file.byteSize.toLocaleString(),
          })}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="code-agent-file-preview-body">
        <div className={`${relativePath ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col overflow-hidden`}>
          <FilePreviewSurface
            roomId={roomId}
            file={file}
            relativePath={relativePath}
            fileError={fileError}
            filePending={filePending}
            onFileChange={onFileChange}
            assetPreviewError={assetPreviewError}
            assetPreviewPending={assetPreviewPending}
            assetPreviewResolvedUrl={assetPreviewResolvedUrl}
            assetPreviewRevision={assetPreviewRevision}
            resolvedTheme={resolvedTheme}
            renderPreview={renderPreview}
            wordWrap={wordWrap}
            revealLine={revealLine}
            revealRequestId={revealRequestId}
            saveState={saveState}
            saveError={saveError}
            onSaveStateChange={onSaveStateChange}
            onFileSavePendingChange={onFileSavePendingChange}
            onEntriesChanged={onEntriesChanged}
            onAssetPreviewChanged={onAssetPreviewChanged}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
          />
        </div>
        {explorer}
      </div>
    </div>
  );
}
