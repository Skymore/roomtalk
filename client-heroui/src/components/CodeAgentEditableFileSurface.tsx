import { type SelectedLineRange } from '@pierre/diffs';
import { Editor } from '@pierre/diffs/editor';
import { EditorProvider, File as DiffFile, type FileOptions, Virtualizer } from '@pierre/diffs/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveCodeAgentDiffThemeName } from '../utils/codeAgentDiffRendering';
import { writeCodeWorkspaceFile, type CodeWorkspaceFile } from '../utils/codeWorkspaceFiles';
import {
  buildFileReviewComment,
  type ReviewCommentContext,
} from '../utils/codeAgentReviewComments';
import { CodeAgentLocalCommentAnnotation } from './CodeAgentLocalCommentAnnotation';
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  fileReviewCommentAnnotations,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from './codeAgentFileCommentAnnotations';
import { installFileEditorDismissal } from './codeAgentFileEditorDismissal';
import { projectFileCacheKey } from './codeAgentFileContentRevision';
import { FileSaveCoordinator } from './codeAgentFileSaveCoordinator';
import {
  confirmCodeAgentProjectFileQueryData,
  setCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type FilePostRender = NonNullable<FileOptions<unknown>['onPostRender']>;

const FILE_SAVE_DEBOUNCE_MS = 500;

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

interface EditableFileSurfaceProps {
  roomId: string;
  workspaceScopeKey?: string;
  file: CodeWorkspaceFile;
  resolvedTheme: 'light' | 'dark';
  wordWrap: boolean;
  onPostRender: FilePostRender;
  revealRequestId: number;
  onFileChange: React.Dispatch<React.SetStateAction<CodeWorkspaceFile | null>>;
  onSaveStateChange: (path: string, state: SaveState, error?: string | null) => void;
  onFileSavePendingChange?: (relativePath: string, pending: boolean) => void;
  onEntriesChanged: () => void;
  reviewComments: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
  fileLinkRevealUnsafeCss: string;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

export function CodeAgentEditableFileSurface({
  roomId,
  workspaceScopeKey = '',
  file,
  resolvedTheme,
  wordWrap,
  onPostRender,
  revealRequestId,
  onFileChange,
  onSaveStateChange,
  onFileSavePendingChange,
  onEntriesChanged,
  reviewComments,
  onAddReviewComment,
  onRemoveReviewComment,
  fileLinkRevealUnsafeCss,
}: EditableFileSurfaceProps) {
  const filePath = file.path;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const latestDraftContentsRef = useRef(file.content);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const previousPersistedCommentIdsRef = useRef<Set<string>>(new Set());
  const persistedLineAnnotations = useMemo(
    () => fileReviewCommentAnnotations(reviewComments, filePath),
    [filePath, reviewComments],
  );
  const persistedCommentIds = useMemo(() => new Set(
    persistedLineAnnotations.flatMap((annotation) =>
      annotation.metadata.entries.map((entry) => entry.id),
    ),
  ), [persistedLineAnnotations]);
  const persistedLineAnnotationsKey = useMemo(
    () => persistedLineAnnotations
      .flatMap((annotation) => annotation.metadata.entries.map((entry) => (
        `${annotation.lineNumber}:${entry.id}:${entry.startLine}:${entry.endLine}:${entry.text}`
      )))
      .join('\n'),
    [persistedLineAnnotations],
  );
  const selectedRange = selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );

  useEffect(() => {
    onSaveStateChange(filePath, 'idle', null);
    latestDraftContentsRef.current = file.content;
    // Reset persistence state only when a different file surface mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    const previousPersistedCommentIds = previousPersistedCommentIdsRef.current;
    setLineAnnotations((current) => {
      const entriesByLineNumber = new Map<number, FileCommentAnnotationEntry[]>();

      for (const annotation of persistedLineAnnotations) {
        entriesByLineNumber.set(annotation.lineNumber, [...annotation.metadata.entries]);
      }

      for (const annotation of current) {
        const localEntries = annotation.metadata.entries.filter((entry) => (
          entry.kind === 'draft'
          || (!persistedCommentIds.has(entry.id) && !previousPersistedCommentIds.has(entry.id))
        ));
        if (localEntries.length === 0) {
          continue;
        }
        const entries = entriesByLineNumber.get(annotation.lineNumber);
        if (entries) {
          entries.push(...localEntries);
        } else {
          entriesByLineNumber.set(annotation.lineNumber, localEntries);
        }
      }

      const next = [...entriesByLineNumber.entries()]
        .sort(([left], [right]) => left - right)
        .map(([lineNumber, entries]) => ({
          lineNumber,
          metadata: { entries },
        }));
      return next;
    });
    previousPersistedCommentIdsRef.current = persistedCommentIds;
  }, [persistedCommentIds, persistedLineAnnotations, persistedLineAnnotationsKey]);

  const setDraftFileContents = useCallback((contents: string) => {
    latestDraftContentsRef.current = contents;
    setCodeAgentProjectFileQueryData(roomId, filePath, contents, workspaceScopeKey);
    onFileChange((current) => updateWorkspaceFileContents(current, filePath, contents));
  }, [filePath, onFileChange, roomId, workspaceScopeKey]);

  const confirmFileContents = useCallback((contents: string): boolean => {
    if (latestDraftContentsRef.current !== contents) {
      return false;
    }
    const confirmed = confirmCodeAgentProjectFileQueryData(roomId, filePath, contents, null, workspaceScopeKey);
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

  const removeAnnotationEntry = useCallback((entryId: string) => {
    setSelectedRange(null);
    onRemoveReviewComment?.(entryId);
    setLineAnnotations((current) => current.flatMap((annotation) => {
      const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
      return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
    }));
  }, [onRemoveReviewComment, setSelectedRange]);

  const submitAnnotationEntry = useCallback((entryId: string, text: string) => {
    setSelectedRange(null);
    const entry = lineAnnotations
      .flatMap((annotation) => annotation.metadata.entries)
      .find((candidate) => candidate.id === entryId);
    if (entry) {
      onAddReviewComment?.(buildFileReviewComment({
        id: entry.id,
        filePath,
        startLine: entry.startLine,
        endLine: entry.endLine,
        text,
        contents: latestDraftContentsRef.current,
      }));
    }
    setLineAnnotations((current) => current.map((annotation) => ({
      ...annotation,
      metadata: {
        entries: annotation.metadata.entries.map((entry) => (
          entry.id === entryId ? { ...entry, kind: 'comment', text } : entry
        )),
      },
    })));
  }, [filePath, lineAnnotations, onAddReviewComment, setSelectedRange]);

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: 'draft',
      startLine,
      endLine,
      text: '',
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== 'draft');
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex((annotation) => annotation.lineNumber === endLine);
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) => (
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation
      ));
    });
  }, []);

  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === 'draft'),
  );

  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    setSelectedRange(range);
    if (range) {
      beginComment(range);
    }
  }, [beginComment, setSelectedRange]);

  const editor = useMemo(() => {
    return new Editor<FileCommentAnnotationGroup>({
      onChange: (nextFile, nextLineAnnotations) => {
        setDraftFileContents(nextFile.contents);
        saveCoordinator.change(nextFile.contents);
        if (nextLineAnnotations) {
          const remapped = remapFileCommentAnnotations(
            nextLineAnnotations as FileCommentLineAnnotation[],
          );
          setLineAnnotations(remapped);
          for (const annotation of remapped) {
            for (const entry of annotation.metadata.entries) {
              if (entry.kind !== 'comment') continue;
              onAddReviewComment?.(buildFileReviewComment({
                id: entry.id,
                filePath,
                startLine: entry.startLine,
                endLine: entry.endLine,
                text: entry.text,
                contents: nextFile.contents,
              }));
            }
          }
        }
      },
    });
  }, [filePath, onAddReviewComment, saveCoordinator, setDraftFileContents]);

  useEffect(() => () => {
    editor.cleanUp();
  }, [editor]);

  useEffect(() => () => {
    if (selectionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return undefined;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);

  const handlePostRender = useCallback<FilePostRender>((fileContainer, instance, phase) => {
    onPostRender(fileContainer, instance, phase);

    if (selectionFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionFrameRef.current);
      selectionFrameRef.current = null;
    }
    if (phase === 'unmount') {
      return;
    }

    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = null;
      if (!fileContainer.isConnected) {
        return;
      }
      instance.setSelectedLines(selectedRange, { notify: false });
    });
  }, [onPostRender, selectedRange]);

  return (
    <EditorProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <DiffFile<FileCommentAnnotationGroup>
            file={{
              name: file.path,
              contents: file.content,
              cacheKey: projectFileCacheKey(roomId, file.path, file.content),
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? 'wrap' : 'scroll',
              theme: resolveCodeAgentDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: fileLinkRevealUnsafeCss,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <CodeAgentLocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditorProvider>
  );
}
