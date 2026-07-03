import { VirtualizedFile } from '@pierre/diffs';
import { File as DiffFile, type FileOptions, Virtualizer } from '@pierre/diffs/react';
import {
  Download,
  LoaderCircle,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  writeCodeWorkspaceFile,
  type CodeWorkspaceFile,
} from '../utils/codeWorkspaceFiles';
import { resolveCodeAgentDiffThemeName } from '../utils/codeAgentDiffRendering';
import {
  appendWorkspaceAssetPreviewRevision,
} from '../utils/codeWorkspaceFilePreview';
import { preloadWorkspaceImagePreview } from '../utils/codeWorkspaceImagePreviewCache';
import { type ReviewCommentContext } from '../utils/codeAgentReviewComments';
import { CodeAgentEditableFileSurface } from './CodeAgentEditableFileSurface';
import {
  CodeAgentBrowserDeviceToolbar,
  CodeAgentBrowserViewportResizeHandles,
  useCodeAgentBrowserViewportResize,
} from './CodeAgentBrowserViewportControls';
import { CodeAgentFilePreviewHeader } from './CodeAgentFilePreviewHeader';
import { MediaViewerModal } from './MediaViewerModal';
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';
import { setMarkdownTaskChecked } from './codeAgentFilePreviewMode';
import {
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
} from './codeAgentFilePath';
import {
  confirmCodeAgentProjectFileQueryData,
  getOptimisticCodeAgentProjectFileQueryData,
  setCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';
import {
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  type CodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSize,
} from '../utils/codeAgentPreviewViewport';

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

function WorkspaceImageAssetPreview({ roomId, src, alt }: { roomId: string; src: string; alt: string }) {
  const { t } = useTranslation();
  const [imageLoading, setImageLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [fullScreenVisible, setFullScreenVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImageLoading(true);
    setLoadError(false);
    setFullScreenVisible(false);

    void preloadWorkspaceImagePreview(src).then((loaded) => {
      if (cancelled) {
        return;
      }
      setImageLoading(false);
      setLoadError(!loaded);
      if (!loaded) {
        setFullScreenVisible(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (!fullScreenVisible) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullScreenVisible(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullScreenVisible]);

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[#f0eee6] p-4 dark:bg-[#141413]">
      <button
        type="button"
        aria-label={t('codeAgentOpenImagePreviewFullscreen', { path: alt })}
        className="flex min-h-full w-full items-center justify-center disabled:cursor-default"
        disabled={loadError}
        onClick={() => setFullScreenVisible(true)}
      >
        <img
          src={src}
          alt={alt}
          className="mx-auto max-h-full max-w-full object-contain"
          onLoad={() => {
            setImageLoading(false);
            setLoadError(false);
          }}
          onError={() => {
            setImageLoading(false);
            setLoadError(true);
            setFullScreenVisible(false);
          }}
        />
      </button>
      {imageLoading && !loadError ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-[#f0eee6]/80 text-[#87867f] dark:bg-[#141413]/80 dark:text-[#8f8d86]"
          role="status"
          aria-label={t('codeAgentLoadingImagePreview')}
        >
          <LoaderCircle className="h-5 w-5 animate-spin" />
        </div>
      ) : null}
      {loadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#faf9f5] px-6 text-center dark:bg-[#1d1d1b]">
          <div className="max-w-sm">
            <div className="text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">
              {t('codeAgentImagePreviewUnavailable')}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-[#87867f] dark:text-[#8f8d86]">
              {t('codeAgentImagePreviewLoadFailed')}
            </div>
          </div>
        </div>
      ) : null}
      <MediaViewerModal
        isOpen={fullScreenVisible}
        src={src}
        kind="image"
        title={t('codeAgentImagePreviewFullscreen', { path: alt })}
        alt={alt}
        roomId={roomId}
        historyEnabled={false}
        actionsEnabled={false}
        dialogTestId="code-agent-image-fullscreen-preview"
        onClose={() => setFullScreenVisible(false)}
      />
    </div>
  );
}

export type WorkspaceBrowserPreviewStatus =
  | { _tag: 'Success'; renderedViewport?: { width: number; height: number } }
  | { _tag: 'LoadFailed'; code: number; description: string };

type WorkspaceBrowserViewportChangeHandler = (
  viewport: CodeAgentPreviewViewportSetting,
) => unknown;

interface WorkspaceBrowserAssetPreviewProps {
  src: string;
  title: string;
  zoomFactor?: number;
  viewport?: CodeAgentPreviewViewportSetting;
  onViewportChange?: WorkspaceBrowserViewportChangeHandler;
  onViewportContainerSizeChange?: (size: CodeAgentPreviewViewportSize) => void;
  onRenderedViewportChange?: (size: CodeAgentPreviewViewportSize) => void;
  onPreviewStatusChange?: (status: WorkspaceBrowserPreviewStatus) => void;
  onLoadingChange?: (loading: boolean) => void;
}

export function WorkspaceBrowserAssetPreview({
  src,
  title,
  zoomFactor = 1,
  viewport = FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  onViewportChange,
  onViewportContainerSizeChange,
  onRenderedViewportChange,
  onPreviewStatusChange,
  onLoadingChange,
}: WorkspaceBrowserAssetPreviewProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const [viewportContainerSize, setViewportContainerSize] =
    useState<CodeAgentPreviewViewportSize>({ width: 1, height: 1 });
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const fillZoomFrameStyle = {
    width: `${100 / normalizedZoomFactor}%`,
    height: `${100 / normalizedZoomFactor}%`,
    transform: `scale(${normalizedZoomFactor})`,
    transformOrigin: 'top left',
  };
  const viewportAspectRatio = viewport._tag === 'fill' ? null : viewport.width / viewport.height;
  const lockedAspectRatio = aspectRatioLocked && viewportAspectRatio !== null
    ? viewportAspectRatio
    : null;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout,
  } = useCodeAgentBrowserViewportResize({
    viewport,
    zoomFactor,
    containerSize: viewportContainerSize,
    deviceToolbarVisible: viewport._tag !== 'fill',
    aspectRatio: lockedAspectRatio,
    onChange: onViewportChange ?? (() => undefined),
  });
  const fixedZoomFrameStyle = effectiveViewport._tag !== 'fill'
    ? {
      left: layout.viewportX,
      top: layout.viewportY,
      width: effectiveViewport.width,
      height: effectiveViewport.height,
      transform: `scale(${normalizedZoomFactor * layout.viewportScale})`,
      transformOrigin: 'top left',
    }
    : null;
  const renderedViewportWidth = effectiveViewport._tag === 'fill'
    ? viewportContainerSize.width
    : effectiveViewport.width;
  const renderedViewportHeight = effectiveViewport._tag === 'fill'
    ? viewportContainerSize.height
    : effectiveViewport.height;
  const renderedViewport = useMemo<CodeAgentPreviewViewportSize>(() => ({
    width: renderedViewportWidth,
    height: renderedViewportHeight,
  }), [renderedViewportHeight, renderedViewportWidth]);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    onPreviewStatusChange?.({
      _tag: 'Success',
      renderedViewport,
    });
  }, [onPreviewStatusChange, renderedViewport]);

  const handleError = useCallback(() => {
    const description = t('codeAgentBrowserPreviewLoadFailed');
    setIsLoading(false);
    setLoadError(description);
    onPreviewStatusChange?.({ _tag: 'LoadFailed', code: 0, description });
  }, [onPreviewStatusChange, t]);

  useEffect(() => {
    setIsLoading(true);
    setLoadError(null);
  }, [src]);

  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  useEffect(() => {
    onRenderedViewportChange?.(renderedViewport);
  }, [onRenderedViewportChange, renderedViewport]);

  useEffect(() => {
    const element = viewportContainerRef.current;
    if (!element) {
      return undefined;
    }
    const readSize = () => {
      const rect = element.getBoundingClientRect();
      const next = {
        width: Math.max(1, Math.round(rect.width || element.clientWidth || 1)),
        height: Math.max(1, Math.round(rect.height || element.clientHeight || 1)),
      };
      setViewportContainerSize((current) => (
        current.width === next.width && current.height === next.height ? current : next
      ));
      onViewportContainerSizeChange?.(next);
    };
    readSize();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(readSize);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', readSize);
    return () => window.removeEventListener('resize', readSize);
  }, [onViewportContainerSizeChange]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return undefined;
    }
    iframe.addEventListener('load', handleLoad);
    iframe.addEventListener('error', handleError);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      iframe.removeEventListener('error', handleError);
    };
  }, [handleError, handleLoad, src]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white dark:bg-[#141413]">
      {loadError ? (
        <div className="shrink-0 border-b border-[#f0b49b]/50 bg-[#fff2ec] px-4 py-2 dark:border-[#7a321f]/60 dark:bg-[#2a211d]">
          <div className="text-xs font-semibold text-[#9f462c] dark:text-[#ff9b78]">
            {t('codeAgentBrowserPreviewFailed')}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-[#5e5d59] dark:text-[#b0aea5]">
            {loadError}
          </div>
        </div>
      ) : null}
      <div
        ref={viewportContainerRef}
        className="min-h-0 flex-1 overflow-auto bg-white dark:bg-[#141413]"
        data-testid="code-agent-browser-preview-viewport"
      >
        {effectiveViewport._tag === 'fill' ? (
          <div
            className="relative min-h-full"
            data-testid="code-agent-browser-preview-zoom-frame"
            style={fillZoomFrameStyle}
          >
            <iframe
              ref={iframeRef}
              src={src}
              title={title}
              className="h-full min-h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={handleLoad}
              onError={handleError}
            />
          </div>
        ) : (
          <div
            className="relative"
            style={{ width: layout.canvasWidth, height: layout.canvasHeight }}
            data-testid="code-agent-browser-preview-device-canvas"
          >
            <CodeAgentBrowserDeviceToolbar
              setting={effectiveViewport}
              width={Math.max(1, Math.round(viewportContainerSize.width))}
              aspectRatio={lockedAspectRatio}
              onAspectRatioChange={(aspectRatio) => setAspectRatioLocked(aspectRatio !== null)}
              onChange={commitViewportChange}
            />
            <div
              className="absolute overflow-hidden bg-white ring-1 ring-[#dedbd0] shadow-sm dark:ring-[#30302e]"
              data-testid="code-agent-browser-preview-zoom-frame"
              data-preview-viewport-mode={effectiveViewport._tag}
              data-preview-viewport-key={`${effectiveViewport._tag}:${effectiveViewport.width}:${effectiveViewport.height}`}
              style={fixedZoomFrameStyle ?? undefined}
            >
              <iframe
                ref={iframeRef}
                src={src}
                title={title}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                onLoad={handleLoad}
                onError={handleError}
              />
            </div>
            <CodeAgentBrowserViewportResizeHandles
              layout={layout}
              activeDirection={activeDrag?.direction ?? null}
              onPointerDown={handleResizePointerDown}
              onKeyDown={handleResizeKeyDown}
            />
            {activeDrag ? (
              <div
                className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-[#dedbd0] bg-[#faf9f5]/95 px-2 py-1 text-[11px] font-medium tabular-nums text-[#141413] shadow-md backdrop-blur-sm dark:border-[#30302e] dark:bg-[#1d1d1b]/95 dark:text-[#faf9f5]"
                style={{
                  left: layout.viewportX + layout.viewportWidth / 2,
                  top: layout.viewportY + 10,
                }}
                aria-hidden="true"
              >
                {t('codeAgentBrowserViewportSizeLabel', {
                  width: String(activeDrag.width),
                  height: String(activeDrag.height),
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {isLoading ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white/80 text-[#87867f] dark:bg-[#141413]/80 dark:text-[#8f8d86]"
          role="status"
          aria-label={t('codeAgentLoadingBrowserPreview')}
        >
          <LoaderCircle className="h-5 w-5 animate-spin" />
        </div>
      ) : null}
    </div>
  );
}

function previewedByteSize(file: CodeWorkspaceFile): number {
  if (file.encoding === 'utf-8') {
    return new TextEncoder().encode(file.content).byteLength;
  }
  return Math.min(file.byteSize, Math.floor((file.content.length * 3) / 4));
}

interface ReadOnlyFileSurfaceProps {
  roomId: string;
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  wordWrap: boolean;
  onPostRender: FilePostRender;
}

function ReadOnlyFileSurface({
  roomId,
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
            cacheKey: projectFileCacheKey(roomId, file.path, file.content),
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
  workspaceScopeKey?: string;
  file: CodeWorkspaceFile;
  workspaceRoot?: string | null;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenWorkspaceFileInBrowserPreview?: (path: string) => void;
}

function RenderedMarkdownSurface({
  roomId,
  workspaceScopeKey = '',
  file,
  workspaceRoot,
  onFileChange,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onOpenWorkspaceFile,
  onOpenWorkspaceFileInBrowserPreview,
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
    setCodeAgentProjectFileQueryData(roomId, filePath, contents, workspaceScopeKey);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId, workspaceScopeKey]);

  const confirmFileContents = useCallback((contents: string): boolean => {
    if (latestDraftContentsRef.current !== contents) {
      return false;
    }
    const confirmed = confirmCodeAgentProjectFileQueryData(roomId, filePath, contents, fileRef.current, workspaceScopeKey);
    if (!confirmed) {
      return false;
    }
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
    return true;
  }, [filePath, onFileChange, roomId, workspaceScopeKey]);

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
          return { _tag: 'Success' };
        } catch (error) {
          onSaveStateChange(filePath, 'error', error instanceof Error ? error.message : 'File save failed.');
          return { _tag: 'Failure' };
        }
      },
      onConfirmed: (contents) => {
        if (confirmFileContents(contents)) {
          onEntriesChanged();
        }
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
            onOpenWorkspaceFileInBrowserPreview={onOpenWorkspaceFileInBrowserPreview}
            workspaceRoot={workspaceRoot}
            onTaskListChange={({ markerOffset, checked }) => {
              const currentContents = getOptimisticCodeAgentProjectFileQueryData(roomId, filePath, workspaceScopeKey)?.content
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
  workspaceScopeKey?: string;
  file: CodeWorkspaceFile | null;
  relativePath: string | null;
  workspaceRoot?: string | null;
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
  mobileLayout?: boolean;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  onAssetPreviewChanged: (relativePath: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenWorkspaceFileInBrowserPreview?: (path: string) => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

function FilePreviewSurface({
  roomId,
  workspaceScopeKey = '',
  file,
  relativePath,
  workspaceRoot,
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
  mobileLayout = false,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  onAssetPreviewChanged,
  onOpenWorkspaceFile,
  onOpenWorkspaceFileInBrowserPreview,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: FilePreviewSurfaceProps) {
  const { t } = useTranslation();
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  const handleEntriesChanged = useCallback(() => {
    onEntriesChanged();
    if (relativePath && (isBrowserPreviewFile(relativePath) || isImagePreviewFile(relativePath))) {
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

  const renderBrowserAssetPreview = renderPreview && isBrowserPreviewFile(relativePath);
  const renderImageAssetPreview = renderPreview && isImagePreviewFile(relativePath);
  const renderSvgWebPreview = renderImageAssetPreview && isSvgImagePreviewFile(relativePath);
  if (renderBrowserAssetPreview || renderImageAssetPreview) {
    if (assetPreviewError) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-[#9f462c] dark:text-[#ff9b78]">
          {assetPreviewError}
        </div>
      );
    }

    if (assetPreviewPending || !assetPreviewResolvedUrl) {
      const pendingLabel = renderImageAssetPreview
        ? t('codeAgentPreparingImagePreview')
        : t('codeAgentPreparingBrowserPreview');
      return (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[#87867f] dark:text-[#8f8d86]"
          role="status"
          aria-label={pendingLabel}
        >
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <div className="text-sm">{pendingLabel}</div>
        </div>
      );
    }

    const resolvedPreviewUrl = appendWorkspaceAssetPreviewRevision(assetPreviewResolvedUrl, assetPreviewRevision);

    return renderImageAssetPreview && !renderSvgWebPreview ? (
      <WorkspaceImageAssetPreview roomId={roomId} src={resolvedPreviewUrl} alt={relativePath} />
    ) : (
      <WorkspaceBrowserAssetPreview src={resolvedPreviewUrl} title={relativePath} />
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
          workspaceScopeKey={workspaceScopeKey}
          file={file}
          workspaceRoot={workspaceRoot}
          onFileChange={onFileChange}
          onSaveStateChange={onSaveStateChange}
          onFileSavePendingChange={onFileSavePendingChange}
          onEntriesChanged={handleEntriesChanged}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onOpenWorkspaceFileInBrowserPreview={onOpenWorkspaceFileInBrowserPreview}
        />
      ) : file.truncated ? (
        <ReadOnlyFileSurface
          key={`${file.path}:${resolvedTheme}:${file.byteSize}`}
          roomId={roomId}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          onPostRender={onFilePostRender}
        />
      ) : (
        <CodeAgentEditableFileSurface
          key={`${file.path}:${resolvedTheme}`}
          roomId={roomId}
          workspaceScopeKey={workspaceScopeKey}
          file={file}
          resolvedTheme={resolvedTheme}
          wordWrap={wordWrap}
          mobileLayout={mobileLayout}
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
  workspaceScopeKey?: string;
  projectName: string;
  relativePath: string | null;
  workspaceRoot?: string | null;
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
  mobileLayout?: boolean;
  explorerOpen: boolean;
  explorer: React.ReactNode;
  browserPreviewPending: boolean;
  externalPreviewUrl?: string | null;
  externalPreviewPending?: boolean;
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
  onOpenWorkspaceFileInBrowserPreview?: (path: string) => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

export function CodeAgentFilePreviewPanel({
  roomId,
  workspaceScopeKey = '',
  projectName,
  relativePath,
  workspaceRoot,
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
  mobileLayout = false,
  explorerOpen,
  explorer,
  browserPreviewPending,
  externalPreviewUrl,
  externalPreviewPending = false,
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
  onOpenWorkspaceFileInBrowserPreview,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
}: CodeAgentFilePreviewPanelProps) {
  const { t } = useTranslation();
  const showMobileExplorerOnly = mobileLayout && explorer !== null && (explorerOpen || !relativePath);
  const showFilePreview = Boolean(relativePath && !showMobileExplorerOnly);
  const showTruncatedBanner = Boolean(showFilePreview && file?.truncated);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {!showMobileExplorerOnly ? (
        <CodeAgentFilePreviewHeader
          projectName={projectName}
          relativePath={relativePath}
          renderPreview={renderPreview}
          wordWrap={wordWrap}
          explorerOpen={explorerOpen}
          browserPreviewPending={browserPreviewPending}
          externalPreviewUrl={externalPreviewUrl}
          externalPreviewPending={externalPreviewPending}
          canToggleFileWordWrap={canToggleFileWordWrap}
          canOpenInBrowserPreview={canOpenInBrowserPreview}
          supportsPreview={supportsPreview}
          refreshCurrentFilePending={refreshCurrentFilePending}
          mobileLayout={mobileLayout}
          onRefreshCurrentFile={onRefreshCurrentFile}
          onDownloadFile={file ? () => createDownload(file) : undefined}
          onToggleWordWrap={onToggleWordWrap}
          onOpenInBrowserPreview={onOpenInBrowserPreview}
          onTogglePreviewView={onTogglePreviewView}
          onToggleExplorer={onToggleExplorer}
        />
      ) : null}
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
      <div
        className="flex min-h-0 flex-1 overflow-hidden"
        data-testid="code-agent-file-preview-body"
        data-mobile-layout={mobileLayout ? 'true' : undefined}
        data-mobile-view={mobileLayout ? (showMobileExplorerOnly ? 'explorer' : 'preview') : undefined}
      >
        <div
          className={`${showFilePreview ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col overflow-hidden`}
          data-testid="code-agent-file-preview-content"
        >
          <FilePreviewSurface
            roomId={roomId}
            workspaceScopeKey={workspaceScopeKey}
            file={file}
            relativePath={relativePath}
            workspaceRoot={workspaceRoot}
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
            mobileLayout={mobileLayout}
            onSaveStateChange={onSaveStateChange}
            onFileSavePendingChange={onFileSavePendingChange}
            onEntriesChanged={onEntriesChanged}
            onAssetPreviewChanged={onAssetPreviewChanged}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onOpenWorkspaceFileInBrowserPreview={onOpenWorkspaceFileInBrowserPreview}
            reviewComments={reviewComments}
            onAddReviewComment={onAddReviewComment}
            onRemoveReviewComment={onRemoveReviewComment}
          />
        </div>
        {mobileLayout ? (showMobileExplorerOnly ? explorer : null) : explorer}
      </div>
    </div>
  );
}
