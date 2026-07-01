// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewCommentContext } from './codeAgentReviewComments';
import {
  addCodeAgentReviewCommentDraft,
  clearCodeAgentReviewCommentDraft,
  readCodeAgentReviewCommentDraft,
  removeCodeAgentReviewCommentDraft,
  resetCodeAgentReviewCommentDraftStoreForTests,
  updateCodeAgentReviewCommentDraft,
} from './codeAgentReviewCommentDraftStore';

function reviewComment(overrides: Partial<ReviewCommentContext> = {}): ReviewCommentContext {
  return {
    id: 'comment-1',
    sectionId: 'file:src/App.tsx',
    sectionTitle: 'File comment',
    filePath: 'src/App.tsx',
    startIndex: 0,
    endIndex: 1,
    rangeLabel: 'L1 to L2',
    text: 'Persist this review comment.',
    diff: 'line 1\nline 2',
    fenceLanguage: 'tsx',
    ...overrides,
  };
}

describe('codeAgentReviewCommentDraftStore', () => {
  afterEach(() => {
    localStorage.clear();
    resetCodeAgentReviewCommentDraftStoreForTests();
  });

  it('persists T3-style review comment drafts by room', () => {
    addCodeAgentReviewCommentDraft('room-1', reviewComment());

    expect(readCodeAgentReviewCommentDraft('room-1')).toEqual([reviewComment()]);
    expect(localStorage.getItem('roomtalk.codeAgent.reviewComments.room-1')).toContain('Persist this review comment.');
    expect(readCodeAgentReviewCommentDraft('room-2')).toEqual([]);
  });

  it('replaces comments with the same id like the T3 composer draft store', () => {
    addCodeAgentReviewCommentDraft('room-1', reviewComment({ text: 'First draft.' }));
    addCodeAgentReviewCommentDraft('room-1', reviewComment({ text: 'Updated draft.' }));

    expect(readCodeAgentReviewCommentDraft('room-1')).toEqual([
      reviewComment({ text: 'Updated draft.' }),
    ]);
  });

  it('removes and clears empty room drafts from storage', () => {
    addCodeAgentReviewCommentDraft('room-1', reviewComment());
    addCodeAgentReviewCommentDraft('room-1', reviewComment({ id: 'comment-2', text: 'Second comment.' }));

    removeCodeAgentReviewCommentDraft('room-1', 'comment-1');

    expect(readCodeAgentReviewCommentDraft('room-1')).toEqual([
      reviewComment({ id: 'comment-2', text: 'Second comment.' }),
    ]);
    expect(localStorage.getItem('roomtalk.codeAgent.reviewComments.room-1')).toContain('Second comment.');

    clearCodeAgentReviewCommentDraft('room-1');

    expect(readCodeAgentReviewCommentDraft('room-1')).toEqual([]);
    expect(localStorage.getItem('roomtalk.codeAgent.reviewComments.room-1')).toBeNull();
  });

  it('filters invalid stored comments and keeps snapshot identity stable', () => {
    localStorage.setItem('roomtalk.codeAgent.reviewComments.room-1', JSON.stringify([
      reviewComment(),
      { id: 'broken' },
    ]));

    const firstSnapshot = readCodeAgentReviewCommentDraft('room-1');
    const secondSnapshot = readCodeAgentReviewCommentDraft('room-1');

    expect(firstSnapshot).toEqual([reviewComment()]);
    expect(secondSnapshot).toBe(firstSnapshot);
  });

  it('updates drafts from the current room snapshot', () => {
    addCodeAgentReviewCommentDraft('room-1', reviewComment());

    updateCodeAgentReviewCommentDraft('room-1', (current) => {
      expect(current).toEqual([reviewComment()]);
      return [...current, reviewComment({ id: 'comment-2', text: 'Second comment.' })];
    });

    expect(readCodeAgentReviewCommentDraft('room-1')).toEqual([
      reviewComment(),
      reviewComment({ id: 'comment-2', text: 'Second comment.' }),
    ]);
  });
});
