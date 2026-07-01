import { useSyncExternalStore } from 'react';
import type { ReviewCommentContext } from './codeAgentReviewComments';

const REVIEW_COMMENT_DRAFT_STORAGE_PREFIX = 'roomtalk.codeAgent.reviewComments.';
const EMPTY_REVIEW_COMMENTS: readonly ReviewCommentContext[] = [];

type DraftSnapshot = {
  rawValue: string | null;
  comments: readonly ReviewCommentContext[];
};

const listeners = new Set<() => void>();
const snapshotsByRoomId = new Map<string, DraftSnapshot>();

function normalizeRoomId(roomId: string): string {
  return roomId.trim();
}

function reviewCommentDraftStorageKey(roomId: string): string {
  return `${REVIEW_COMMENT_DRAFT_STORAGE_PREFIX}${encodeURIComponent(roomId)}`;
}

function isStoredReviewComment(value: unknown): value is ReviewCommentContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const comment = value as Partial<ReviewCommentContext>;
  return typeof comment.id === 'string'
    && typeof comment.sectionId === 'string'
    && typeof comment.sectionTitle === 'string'
    && typeof comment.filePath === 'string'
    && typeof comment.startIndex === 'number'
    && Number.isFinite(comment.startIndex)
    && typeof comment.endIndex === 'number'
    && Number.isFinite(comment.endIndex)
    && typeof comment.rangeLabel === 'string'
    && typeof comment.text === 'string'
    && typeof comment.diff === 'string'
    && (comment.fenceLanguage === undefined || typeof comment.fenceLanguage === 'string');
}

function parseStoredReviewComments(rawValue: string | null): readonly ReviewCommentContext[] {
  if (!rawValue) {
    return EMPTY_REVIEW_COMMENTS;
  }
  try {
    const parsed = JSON.parse(rawValue);
    const comments = Array.isArray(parsed) ? parsed.filter(isStoredReviewComment) : [];
    return comments.length > 0 ? comments : EMPTY_REVIEW_COMMENTS;
  } catch {
    return EMPTY_REVIEW_COMMENTS;
  }
}

function readRawDraft(roomId: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(reviewCommentDraftStorageKey(roomId));
  } catch {
    return null;
  }
}

function writeRawDraft(roomId: string, comments: readonly ReviewCommentContext[]): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const storageKey = reviewCommentDraftStorageKey(roomId);
  try {
    if (comments.length === 0) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, JSON.stringify(comments));
    }
  } catch {
    // Persistence is best-effort; the live draft snapshot remains available in memory.
  }
  return readRawDraft(roomId);
}

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readCodeAgentReviewCommentDraft(roomId: string): readonly ReviewCommentContext[] {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return EMPTY_REVIEW_COMMENTS;
  }

  const rawValue = readRawDraft(normalizedRoomId);
  const cached = snapshotsByRoomId.get(normalizedRoomId);
  if (cached?.rawValue === rawValue) {
    return cached.comments;
  }

  const comments = parseStoredReviewComments(rawValue);
  snapshotsByRoomId.set(normalizedRoomId, { rawValue, comments });
  return comments;
}

export function updateCodeAgentReviewCommentDraft(
  roomId: string,
  updater: (comments: readonly ReviewCommentContext[]) => readonly ReviewCommentContext[],
): readonly ReviewCommentContext[] {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return EMPTY_REVIEW_COMMENTS;
  }

  const currentComments = readCodeAgentReviewCommentDraft(normalizedRoomId);
  const nextComments = updater(currentComments);
  const comments = nextComments.length > 0 ? [...nextComments] : EMPTY_REVIEW_COMMENTS;
  const rawValue = writeRawDraft(normalizedRoomId, comments);
  snapshotsByRoomId.set(normalizedRoomId, { rawValue, comments });
  emit();
  return comments;
}

export function addCodeAgentReviewCommentDraft(roomId: string, comment: ReviewCommentContext) {
  updateCodeAgentReviewCommentDraft(roomId, (current) => {
    const withoutSameComment = current.filter((entry) => entry.id !== comment.id);
    return [...withoutSameComment, comment];
  });
}

export function removeCodeAgentReviewCommentDraft(roomId: string, commentId: string) {
  updateCodeAgentReviewCommentDraft(roomId, (current) => current.filter((entry) => entry.id !== commentId));
}

export function clearCodeAgentReviewCommentDraft(roomId: string) {
  updateCodeAgentReviewCommentDraft(roomId, () => EMPTY_REVIEW_COMMENTS);
}

export function useCodeAgentReviewCommentDraft(roomId: string): readonly ReviewCommentContext[] {
  return useSyncExternalStore(
    subscribe,
    () => readCodeAgentReviewCommentDraft(roomId),
    () => EMPTY_REVIEW_COMMENTS,
  );
}

export function resetCodeAgentReviewCommentDraftStoreForTests() {
  snapshotsByRoomId.clear();
  listeners.clear();
}
