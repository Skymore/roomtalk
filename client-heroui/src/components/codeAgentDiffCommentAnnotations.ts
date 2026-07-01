import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
  SelectionSide,
} from '@pierre/diffs';

interface DiffCommentLine {
  change: 'context' | 'add' | 'delete';
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

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

function buildDiffCommentLines(fileDiff: FileDiffMetadata): DiffCommentLine[] {
  const rows: DiffCommentLine[] = [];

  for (const hunk of fileDiff.hunks) {
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;

    for (const segment of hunk.hunkContent) {
      if (segment.type === 'context') {
        for (let index = 0; index < segment.lines; index += 1) {
          rows.push({
            change: 'context',
            oldLineNumber,
            newLineNumber,
          });
          oldLineNumber += 1;
          newLineNumber += 1;
        }
        continue;
      }

      for (let index = 0; index < segment.deletions; index += 1) {
        rows.push({
          change: 'delete',
          oldLineNumber,
          newLineNumber: null,
        });
        oldLineNumber += 1;
      }

      for (let index = 0; index < segment.additions; index += 1) {
        rows.push({
          change: 'add',
          oldLineNumber: null,
          newLineNumber,
        });
        newLineNumber += 1;
      }
    }
  }

  return rows;
}

function findDiffCommentLineIndex(
  lines: ReadonlyArray<DiffCommentLine>,
  lineNumber: number,
  side: SelectionSide | undefined,
): number {
  const preferredKey = side === 'deletions' ? 'oldLineNumber' : 'newLineNumber';
  const preferredIndex = lines.findIndex((line) => line[preferredKey] === lineNumber);
  if (preferredIndex >= 0) return preferredIndex;
  const fallbackKey = preferredKey === 'oldLineNumber' ? 'newLineNumber' : 'oldLineNumber';
  return lines.findIndex((line) => line[fallbackKey] === lineNumber);
}

function getDiffCommentChangeMarker(change: DiffCommentLine['change']): string {
  if (change === 'add') return '+';
  if (change === 'delete') return '-';
  return '';
}

function formatDiffCommentRangeLabel(lines: ReadonlyArray<DiffCommentLine>): string | null {
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (!firstLine || !lastLine) return null;

  const firstNumber = firstLine.newLineNumber ?? firstLine.oldLineNumber;
  const lastNumber = lastLine.newLineNumber ?? lastLine.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? 'line' : `${lines.length} lines`;
  }

  const firstMarker = getDiffCommentChangeMarker(firstLine.change);
  const marker = firstMarker && lines.every((line) => line.change === firstLine.change)
    ? firstMarker
    : '';
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} to ${marker}${lastNumber}`;
}

export function formatDiffCommentRange(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): string {
  const lines = buildDiffCommentLines(fileDiff);
  const startIndex = findDiffCommentLineIndex(lines, range.start, range.side);
  const endIndex = findDiffCommentLineIndex(lines, range.end, range.endSide ?? range.side);

  if (startIndex < 0 || endIndex < 0) {
    const marker = diffAnnotationSide(range) === 'deletions' ? '-' : '+';
    return range.start === range.end
      ? `${marker}${range.start}`
      : `${marker}${Math.min(range.start, range.end)} to ${marker}${Math.max(range.start, range.end)}`;
  }

  const normalizedStartIndex = Math.min(startIndex, endIndex);
  const normalizedEndIndex = Math.max(startIndex, endIndex);
  return formatDiffCommentRangeLabel(lines.slice(normalizedStartIndex, normalizedEndIndex + 1)) || 'line';
}
