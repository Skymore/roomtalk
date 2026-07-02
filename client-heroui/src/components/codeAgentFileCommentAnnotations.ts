import type { LineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

export interface FileCommentAnnotationEntry {
  id: string;
  kind: 'draft' | 'comment';
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

let fileCommentSequence = 0;

export function nextFileCommentId(): string {
  fileCommentSequence += 1;
  return `file-comment-${Date.now()}-${fileCommentSequence}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function formatFileCommentRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}

function clampLineNumber(line: number, lineCount: number | null): number {
  if (lineCount === null) {
    return Math.max(1, line);
  }
  return Math.min(lineCount, Math.max(1, line));
}

export function countFileCommentLines(contents: string): number {
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
  return lineCount;
}

export function fileReviewCommentAnnotations(
  comments: ReadonlyArray<ReviewCommentContext>,
  filePath: string,
  options: { lineCount?: number | null } = {},
): FileCommentLineAnnotation[] {
  const sectionId = `file:${filePath}`;
  const lineCount = options.lineCount === undefined || options.lineCount === null
    ? null
    : Math.max(1, Math.floor(options.lineCount));
  const entriesByLineNumber = new Map<number, FileCommentAnnotationEntry[]>();

  for (const comment of comments) {
    if (comment.sectionId !== sectionId || comment.filePath !== filePath) {
      continue;
    }
    const rawStartLine = Math.floor(comment.startIndex) + 1;
    const rawEndLine = Math.floor(comment.endIndex) + 1;
    if (!Number.isFinite(rawStartLine) || !Number.isFinite(rawEndLine)) {
      continue;
    }

    const normalizedStartLine = Math.max(1, Math.min(rawStartLine, rawEndLine));
    const normalizedEndLine = Math.max(normalizedStartLine, Math.max(rawStartLine, rawEndLine));
    const lineSpan = normalizedEndLine - normalizedStartLine;
    const endLine = clampLineNumber(normalizedEndLine, lineCount);
    const startLine = clampLineNumber(endLine - lineSpan, lineCount);
    const entry: FileCommentAnnotationEntry = {
      id: comment.id,
      kind: 'comment',
      startLine,
      endLine,
      text: comment.text,
    };
    const entries = entriesByLineNumber.get(endLine);
    if (entries) {
      entries.push(entry);
    } else {
      entriesByLineNumber.set(endLine, [entry]);
    }
  }

  return [...entriesByLineNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([lineNumber, entries]) => ({
      lineNumber,
      metadata: {
        entries: [...entries].sort((left, right) => left.id.localeCompare(right.id)),
      },
    }));
}
