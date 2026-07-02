import { describe, expect, it } from 'vitest';
import type { FileDiffMetadata } from '@pierre/diffs';
import {
  appendReviewCommentsToPrompt,
  buildDiffReviewCommentPreviewLines,
  buildDiffReviewComment,
  buildFileReviewCommentPreviewLines,
  buildFileReviewComment,
  buildReviewCommentRenderablePatch,
  formatReviewCommentContext,
  inferReviewCommentFenceLanguage,
  parseReviewCommentMessageSegments,
  restoreDiffReviewCommentRange,
} from './codeAgentReviewComments';

describe('codeAgentReviewComments', () => {
  it('parses T3 review-comment blocks into message segments', () => {
    const segments = parseReviewCommentMessageSegments([
      'Before',
      '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="src/app.ts" startIndex="1" endIndex="2" rangeLabel="+2 to +3">',
      'Keep this configurable.',
      '```diff',
      '@@ -2,1 +2,2 @@',
      '-old',
      '+new',
      '+extra',
      '```',
      '</review_comment>',
      'After',
    ].join('\n'));

    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'review-comment', 'text']);
    expect(segments[1]).toMatchObject({
      kind: 'review-comment',
      comment: {
        sectionId: 'turn:2',
        sectionTitle: 'Turn 2',
        filePath: 'src/app.ts',
        startIndex: 1,
        endIndex: 2,
        rangeLabel: '+2 to +3',
        text: 'Keep this configurable.',
        diff: '@@ -2,1 +2,2 @@\n-old\n+new\n+extra',
        fenceLanguage: 'diff',
      },
    });
  });

  it('keeps invalid review-comment blocks as text', () => {
    const value = '<review_comment filePath="src/app.ts">Broken</review_comment>';
    const segments = parseReviewCommentMessageSegments(value);
    expect(segments).toEqual([{
      kind: 'text',
      id: 'review-comment-invalid:0',
      text: value,
    }]);
  });

  it('formats editable file comments with the T3 review-comment contract', () => {
    const comment = buildFileReviewComment({
      id: 'comment-1',
      filePath: 'src/app.ts',
      startLine: 2,
      endLine: 3,
      text: 'Keep this configurable.',
      contents: ['one', 'two', 'three', 'four'].join('\n'),
    });

    const prompt = appendReviewCommentsToPrompt('Please update this.', [comment]);

    expect(comment).toMatchObject({
      filePath: 'src/app.ts',
      startIndex: 1,
      endIndex: 2,
      rangeLabel: 'L2 to L3',
      text: 'Keep this configurable.',
      diff: 'two\nthree',
      fenceLanguage: 'ts',
    });
    expect(prompt).toContain('<review_comment');
    expect(prompt).toContain('```ts\ntwo\nthree\n```');
  });

  it('builds source preview lines for mobile file review comments', () => {
    expect(buildFileReviewCommentPreviewLines({
      contents: ['one', 'two', 'three', 'four'].join('\n'),
      startLine: 2,
      endLine: 4,
    })).toEqual([
      {
        id: 'source:2',
        change: 'source',
        lineNumberLabel: '2',
        content: 'two',
      },
      {
        id: 'source:3',
        change: 'source',
        lineNumberLabel: '3',
        content: 'three',
      },
      {
        id: 'source:4',
        change: 'source',
        lineNumberLabel: '4',
        content: 'four',
      },
    ]);
  });

  it('infers file review fence languages like T3', () => {
    expect(inferReviewCommentFenceLanguage('docs/plan.md')).toBe('md');
    expect(inferReviewCommentFenceLanguage('src/view.tsx')).toBe('tsx');
    expect(inferReviewCommentFenceLanguage('.env')).toBe('env');
    expect(inferReviewCommentFenceLanguage('Makefile')).toBe('text');
  });

  it('preserves nested markdown fences in source comments like T3', () => {
    const serialized = formatReviewCommentContext({
      id: 'comment-nested-fence',
      sectionId: 'file:docs/plan.md',
      sectionTitle: 'File comment',
      filePath: 'docs/plan.md',
      startIndex: 0,
      endIndex: 2,
      rangeLabel: 'L1 to L3',
      text: 'Update this example.',
      diff: ['# Example', '```ts', 'const value = 1;', '```'].join('\n'),
      fenceLanguage: 'md',
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(serialized).toContain('````md');
    expect(segment).toEqual(expect.objectContaining({
      kind: 'review-comment',
      comment: expect.objectContaining({
        fenceLanguage: 'md',
        diff: ['# Example', '```ts', 'const value = 1;', '```'].join('\n'),
      }),
    }));
  });

  it('round-trips greater-than signs in attributes like T3', () => {
    const serialized = formatReviewCommentContext({
      id: 'comment-attribute-escape',
      sectionId: 'turn:4',
      sectionTitle: 'Changes > 5',
      filePath: 'src/app.ts',
      startIndex: 0,
      endIndex: 0,
      rangeLabel: '+1',
      text: 'Check this.',
      diff: '@@ -0,0 +1,1 @@\n+one',
      fenceLanguage: 'diff',
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(serialized).toContain('sectionTitle="Changes &gt; 5"');
    expect(segment).toEqual(expect.objectContaining({
      kind: 'review-comment',
      comment: expect.objectContaining({ sectionTitle: 'Changes > 5' }),
    }));
  });

  it('keeps fenced examples in comment text separate from the final context fence like T3', () => {
    const text = ['Try this:', '```ts', 'const value = 1;', '```', 'Then retry.'].join('\n');
    const serialized = formatReviewCommentContext({
      id: 'comment-text-fence',
      sectionId: 'turn:5',
      sectionTitle: 'Turn 5',
      filePath: 'src/app.ts',
      startIndex: 0,
      endIndex: 0,
      rangeLabel: '+1',
      text,
      diff: '@@ -0,0 +1,1 @@\n+one',
      fenceLanguage: 'diff',
    });
    const [segment] = parseReviewCommentMessageSegments(serialized);

    expect(segment).toEqual(expect.objectContaining({
      kind: 'review-comment',
      comment: expect.objectContaining({
        text,
        diff: '@@ -0,0 +1,1 @@\n+one',
        fenceLanguage: 'diff',
      }),
    }));
  });

  it('formats mixed diff-side selections with the T3 review-comment contract', () => {
    const fileDiff = {
      name: 'src/app.ts',
      prevName: 'src/app.ts',
      hunks: [{
        deletionStart: 1,
        additionStart: 1,
        deletionLineIndex: 0,
        additionLineIndex: 0,
        hunkContent: [
          { type: 'context', lines: 1 },
          { type: 'change', deletions: 1, additions: 1 },
          { type: 'context', lines: 2 },
        ],
      }],
      deletionLines: ['one', 'two', 'three', 'four'],
      additionLines: ['one', 'TWO', 'three', 'four'],
      type: 'change',
    } as unknown as FileDiffMetadata;

    const comment = buildDiffReviewComment({
      id: 'comment-2',
      sectionId: 'turn:2',
      sectionTitle: 'Turn 2',
      filePath: 'src/app.ts',
      fileDiff,
      range: {
        start: 2,
        side: 'deletions',
        end: 2,
        endSide: 'additions',
      },
      text: 'Keep this compatible.',
    });

    expect(comment).toMatchObject({
      sectionId: 'turn:2',
      sectionTitle: 'Turn 2',
      filePath: 'src/app.ts',
      startIndex: 1,
      endIndex: 2,
      rangeLabel: '2',
      text: 'Keep this compatible.',
      diff: '@@ -2,1 +2,1 @@\n-two\n+TWO',
      fenceLanguage: 'diff',
    });
    expect(formatReviewCommentContext(comment!)).toContain('```diff\n@@ -2,1 +2,1 @@\n-two\n+TWO\n```');
    expect(restoreDiffReviewCommentRange(fileDiff, comment!)).toEqual({
      start: 2,
      side: 'deletions',
      end: 2,
      endSide: 'additions',
    });
  });

  it('builds diff preview lines for mobile diff review comments', () => {
    const fileDiff = {
      name: 'src/app.ts',
      prevName: 'src/app.ts',
      hunks: [{
        deletionStart: 1,
        additionStart: 1,
        deletionLineIndex: 0,
        additionLineIndex: 0,
        hunkContent: [
          { type: 'context', lines: 1 },
          { type: 'change', deletions: 0, additions: 3 },
        ],
      }],
      deletionLines: ['same'],
      additionLines: ['same', 'added 2', 'added 3', 'added 4'],
      type: 'change',
    } as unknown as FileDiffMetadata;

    expect(buildDiffReviewCommentPreviewLines({
      fileDiff,
      range: {
        start: 2,
        side: 'additions',
        end: 4,
        endSide: 'additions',
      },
    })).toEqual([
      {
        id: 'diff:1',
        change: 'add',
        lineNumberLabel: '2',
        content: 'added 2',
      },
      {
        id: 'diff:2',
        change: 'add',
        lineNumberLabel: '3',
        content: 'added 3',
      },
      {
        id: 'diff:3',
        change: 'add',
        lineNumberLabel: '4',
        content: 'added 4',
      },
    ]);
  });

  it('builds a renderable git patch for review comment diffs', () => {
    const patch = buildReviewCommentRenderablePatch({
      id: 'comment-3',
      sectionId: 'turn:2',
      sectionTitle: 'Turn 2',
      filePath: 'src/app.ts',
      startIndex: 0,
      endIndex: 0,
      rangeLabel: '+1',
      text: 'Check this.',
      diff: '@@ -1,1 +1,1 @@\n-old\n+new',
      fenceLanguage: 'diff',
    });

    expect(patch).toBe([
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n'));
  });

  it('does not build a renderable patch for source-code file comments', () => {
    expect(buildReviewCommentRenderablePatch({
      id: 'comment-4',
      sectionId: 'file:docs/plan.md',
      sectionTitle: 'File comment',
      filePath: 'docs/plan.md',
      startIndex: 0,
      endIndex: 1,
      rangeLabel: 'L1 to L2',
      text: 'Clarify this.',
      diff: '# Plan\n- Step one',
      fenceLanguage: 'md',
    })).toBe('');
  });
});
