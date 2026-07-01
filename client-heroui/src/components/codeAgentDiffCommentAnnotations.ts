import type {
  AnnotationSide,
  DiffLineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs';

export interface DiffCommentAnnotationEntry {
  id: string;
  kind: 'draft' | 'comment';
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

export interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

export type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;

export function diffAnnotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === 'deletions' ? 'deletions' : 'additions';
}

export function appendDiffCommentAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = diffAnnotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );

  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }

  return annotations.map((annotation, index) => (
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation
  ));
}
