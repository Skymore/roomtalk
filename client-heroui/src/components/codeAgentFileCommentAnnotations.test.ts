import { describe, expect, it } from 'vitest';
import {
  countFileCommentLines,
  fileReviewCommentAnnotations,
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from './codeAgentFileCommentAnnotations';

describe('file comment annotations', () => {
  it('normalizes and formats selected line ranges', () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe('L7');
    expect(formatFileCommentRange(7, 16)).toBe('L7 to L16');
  });

  it('keeps an annotation range attached when Pierre remaps its anchor line', () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: 'comment-1',
                kind: 'comment',
                startLine: 7,
                endLine: 16,
                text: 'Keep this guarded.',
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: 'comment-1',
              kind: 'comment',
              startLine: 11,
              endLine: 20,
              text: 'Keep this guarded.',
            },
          ],
        },
      },
    ]);
  });

  it('restores persisted file review comments as line annotations', () => {
    expect(
      fileReviewCommentAnnotations([
        {
          id: 'comment-1',
          sectionId: 'file:src/App.tsx',
          sectionTitle: 'File comment',
          filePath: 'src/App.tsx',
          startIndex: 1,
          endIndex: 3,
          rangeLabel: 'L2 to L4',
          text: 'Revisit this range.',
          diff: 'line 2\nline 3\nline 4',
          fenceLanguage: 'tsx',
        },
        {
          id: 'comment-other',
          sectionId: 'file:src/Other.tsx',
          sectionTitle: 'File comment',
          filePath: 'src/Other.tsx',
          startIndex: 0,
          endIndex: 0,
          rangeLabel: 'L1',
          text: 'Ignore me.',
          diff: 'other',
          fenceLanguage: 'tsx',
        },
      ], 'src/App.tsx'),
    ).toEqual([
      {
        lineNumber: 4,
        metadata: {
          entries: [
            {
              id: 'comment-1',
              kind: 'comment',
              startLine: 2,
              endLine: 4,
              text: 'Revisit this range.',
            },
          ],
        },
      },
    ]);
  });

  it('clamps restored file review comments to the current file length', () => {
    expect(countFileCommentLines('one\r\ntwo\nthree')).toBe(3);
    expect(
      fileReviewCommentAnnotations([
        {
          id: 'comment-1',
          sectionId: 'file:src/App.tsx',
          sectionTitle: 'File comment',
          filePath: 'src/App.tsx',
          startIndex: 5,
          endIndex: 7,
          rangeLabel: 'L6 to L8',
          text: 'Moved after truncation.',
          diff: 'old',
          fenceLanguage: 'tsx',
        },
      ], 'src/App.tsx', { lineCount: 3 }),
    ).toEqual([
      {
        lineNumber: 3,
        metadata: {
          entries: [
            {
              id: 'comment-1',
              kind: 'comment',
              startLine: 1,
              endLine: 3,
              text: 'Moved after truncation.',
            },
          ],
        },
      },
    ]);
  });
});
