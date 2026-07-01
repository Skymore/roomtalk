import type {
  CodeViewDiffItem,
  CodeViewItem,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewProps } from '@pierre/diffs/react';
import { useCallback, useMemo, useState, type ReactNode, type Ref } from 'react';
import { fnv1a32 } from '../utils/codeAgentDiffRendering';
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from '../utils/codeAgentReviewComments';
import { CodeAgentLocalCommentAnnotation } from './CodeAgentLocalCommentAnnotation';
import {
  type DiffCommentAnnotationEntry,
  type DiffCommentAnnotationGroup,
  type DiffCommentLineAnnotation,
  appendDiffCommentAnnotationEntry,
  formatDiffCommentRange,
} from './codeAgentDiffCommentAnnotations';
import { nextFileCommentId } from './codeAgentFileCommentAnnotations';

export type CodeAgentAnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup>;

interface CodeAgentAnnotatableCodeViewFile {
  fileDiff: FileDiffMetadata;
  filePath: string;
  fileKey: string;
  collapsed: boolean;
}

interface CodeAgentAnnotatableCodeViewProps {
  files: ReadonlyArray<CodeAgentAnnotatableCodeViewFile>;
  sectionId: string;
  sectionTitle: string;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
  options: NonNullable<CodeViewProps<DiffCommentAnnotationGroup>['options']>;
  viewerRef?: Ref<CodeAgentAnnotatableCodeViewHandle>;
  className?: string;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function CodeAgentAnnotatableCodeView({
  files,
  sectionId,
  sectionTitle,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
  options,
  viewerRef,
  className,
  renderHeaderPrefix,
}: CodeAgentAnnotatableCodeViewProps) {
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [diffAnnotations, setDiffAnnotations] = useState<Record<string, DiffCommentLineAnnotation[]>>({});
  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);

  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(() => (
    files.map(({ fileDiff, filePath, fileKey, collapsed }) => {
      const persistedAnnotations = reviewComments
        .filter((comment) => (
          comment.sectionId === sectionId &&
          comment.filePath === filePath &&
          (comment.fenceLanguage ?? 'diff') === 'diff'
        ))
        .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
          const range = restoreDiffReviewCommentRange(fileDiff, comment);
          if (!range) return annotations;
          return appendDiffCommentAnnotationEntry(annotations, range, {
            id: comment.id,
            kind: 'comment',
            range,
            rangeLabel: comment.rangeLabel,
            text: comment.text,
          });
        }, []);
      const persistedEntryIds = new Set(
        persistedAnnotations.flatMap((annotation) => annotation.metadata.entries.map((entry) => entry.id)),
      );
      const localAnnotations = (diffAnnotations[fileKey] || []).flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => !persistedEntryIds.has(entry.id));
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const annotations = [...persistedAnnotations, ...localAnnotations];
      return {
        id: fileKey,
        type: 'diff',
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(`${collapsed ? '1' : '0'}:${annotations
          .flatMap((annotation) => annotation.metadata.entries.map((entry) => `${entry.id}:${entry.kind}:${entry.rangeLabel}:${entry.text}`))
          .join('|')}`),
      };
    })
  ), [diffAnnotations, files, reviewComments, sectionId]);

  const removeDraftDiffAnnotations = useCallback((
    current: Record<string, DiffCommentLineAnnotation[]>,
  ): Record<string, DiffCommentLineAnnotation[]> => {
    const next: Record<string, DiffCommentLineAnnotation[]> = {};
    for (const [fileKey, annotations] of Object.entries(current)) {
      const filteredAnnotations = annotations.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== 'draft');
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      if (filteredAnnotations.length > 0) {
        next[fileKey] = filteredAnnotations;
      }
    }
    return next;
  }, []);

  const removeLocalAnnotationEntry = useCallback((entryId: string) => {
    setDiffAnnotations((current) => {
      const next: Record<string, DiffCommentLineAnnotation[]> = {};
      for (const [fileKey, annotations] of Object.entries(current)) {
        const filteredAnnotations = annotations.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
        if (filteredAnnotations.length > 0) {
          next[fileKey] = filteredAnnotations;
        }
      }
      return next;
    });
  }, []);

  const removeAnnotationEntry = useCallback((entryId: string) => {
    setSelectedLines(null);
    onRemoveReviewComment?.(entryId);
    removeLocalAnnotationEntry(entryId);
  }, [onRemoveReviewComment, removeLocalAnnotationEntry]);

  const submitAnnotationEntry = useCallback((entryId: string, text: string) => {
    setSelectedLines(null);
    const submitted = Object.entries(diffAnnotations).flatMap(([fileKey, annotations]) => (
      annotations.flatMap((annotation) => (
        annotation.metadata.entries.map((entry) => ({ fileKey, entry }))
      ))
    )).find(({ entry }) => entry.id === entryId);
    const file = submitted ? filesByKey.get(submitted.fileKey) : undefined;
    const comment = submitted && file
      ? buildDiffReviewComment({
        id: submitted.entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: submitted.entry.range,
        text,
      })
      : null;
    if (comment && onAddReviewComment) {
      onAddReviewComment(comment);
      removeLocalAnnotationEntry(entryId);
      return;
    }
    setDiffAnnotations((current) => {
      const next: Record<string, DiffCommentLineAnnotation[]> = {};
      for (const [fileKey, annotations] of Object.entries(current)) {
        next[fileKey] = annotations.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((entry) => (
              entry.id === entryId ? { ...entry, kind: 'comment', text } : entry
            )),
          },
        }));
      }
      return next;
    });
  }, [
    diffAnnotations,
    filesByKey,
    onAddReviewComment,
    removeLocalAnnotationEntry,
    sectionId,
    sectionTitle,
  ]);

  const beginComment = useCallback((range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range || context.item.type !== 'diff') {
      return;
    }

    const entry: DiffCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: 'draft',
      range,
      rangeLabel: formatDiffCommentRange(context.item.fileDiff, range),
      text: '',
    };

    setSelectedLines({ id: context.item.id, range });
    setDiffAnnotations((current) => {
      const withoutDraft = removeDraftDiffAnnotations(current);
      return {
        ...withoutDraft,
        [context.item.id]: appendDiffCommentAnnotationEntry(
          withoutDraft[context.item.id] || [],
          range,
          entry,
        ),
      };
    });
  }, [removeDraftDiffAnnotations]);

  const hasOpenCommentForm = Object.values(diffAnnotations).some((annotations) =>
    annotations.some((annotation) => annotation.metadata.entries.some((entry) => entry.kind === 'draft')),
  );

  return (
    <CodeView<DiffCommentAnnotationGroup>
      {...(viewerRef ? { ref: viewerRef } : {})}
      {...(className ? { className } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      renderHeaderPrefix={(item) =>
        item.type === 'diff'
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      options={{
        ...options,
        enableGutterUtility: !hasOpenCommentForm,
        enableLineSelection: !hasOpenCommentForm,
        onLineSelectionEnd: beginComment,
      }}
      renderAnnotation={(annotation) => (
        <div className="py-1">
          {annotation.metadata.entries.map((entry) => (
            <CodeAgentLocalCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.text}
              onCancel={() => removeAnnotationEntry(entry.id)}
              onComment={(text) => submitAnnotationEntry(entry.id, text)}
              onDelete={() => removeAnnotationEntry(entry.id)}
            />
          ))}
        </div>
      )}
    />
  );
}
