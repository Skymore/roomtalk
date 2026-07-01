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
  diffAnnotationSide,
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
  const [draft, setDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);

  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(() => (
    files.map(({ fileDiff, filePath, fileKey, collapsed }) => {
      const persisted = reviewComments
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
      const annotations = draft?.fileKey === fileKey
        ? [...persisted, draft.annotation]
        : persisted;
      return {
        id: fileKey,
        type: 'diff',
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(`${collapsed ? '1' : '0'}:${annotations
          .flatMap((annotation) => annotation.metadata.entries.map((entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`))
          .join('|')}`),
      };
    })
  ), [draft, files, reviewComments, sectionId]);

  const removeAnnotationEntry = useCallback((entryId: string) => {
    setSelectedLines(null);
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      return;
    }
    onRemoveReviewComment?.(entryId);
  }, [draft, onRemoveReviewComment]);

  const submitAnnotationEntry = useCallback((entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    const file = draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!entry || !file) {
      return;
    }
    const comment = entry && file
      ? buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: entry.range,
        text,
      })
      : null;
    if (comment) {
      onAddReviewComment?.(comment);
    }
    setSelectedLines(null);
    setDraft(null);
  }, [
    draft,
    filesByKey,
    onAddReviewComment,
    sectionId,
    sectionTitle,
  ]);

  const beginComment = useCallback((range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range || context.item.type !== 'diff') {
      return;
    }
    const file = filesByKey.get(context.item.id);
    if (!file) {
      return;
    }

    const id = nextFileCommentId();
    const comment = buildDiffReviewComment({
      id,
      sectionId,
      sectionTitle,
      filePath: file.filePath,
      fileDiff: file.fileDiff,
      range,
      text: '',
    });
    if (!comment) {
      return;
    }
    const entry: DiffCommentAnnotationEntry = {
      id,
      kind: 'draft',
      range,
      rangeLabel: comment.rangeLabel,
      text: '',
    };

    setDraft({
      fileKey: context.item.id,
      annotation: {
        side: diffAnnotationSide(range),
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    });
  }, [filesByKey, sectionId, sectionTitle]);

  const hasOpenCommentForm = draft !== null;

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
