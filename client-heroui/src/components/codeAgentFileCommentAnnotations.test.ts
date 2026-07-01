import { describe, expect, it } from 'vitest';
import {
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
});
