import { useSyncExternalStore } from 'react';
import {
  compactCodeAgentPreviewAnnotation,
  isCodeAgentPreviewAnnotationContext,
  type CodeAgentPreviewAnnotationContext,
} from './codeAgentPreviewAnnotations';

const PREVIEW_ANNOTATION_DRAFT_STORAGE_PREFIX = 'roomtalk.codeAgent.previewAnnotations.';
const EMPTY_PREVIEW_ANNOTATIONS: readonly CodeAgentPreviewAnnotationContext[] = [];

type DraftSnapshot = {
  rawValue: string | null;
  annotations: readonly CodeAgentPreviewAnnotationContext[];
};

const listeners = new Set<() => void>();
const snapshotsByRoomId = new Map<string, DraftSnapshot>();

function normalizeRoomId(roomId: string): string {
  return roomId.trim();
}

function previewAnnotationDraftStorageKey(roomId: string): string {
  return `${PREVIEW_ANNOTATION_DRAFT_STORAGE_PREFIX}${encodeURIComponent(roomId)}`;
}

function parseStoredPreviewAnnotations(rawValue: string | null): readonly CodeAgentPreviewAnnotationContext[] {
  if (!rawValue) {
    return EMPTY_PREVIEW_ANNOTATIONS;
  }
  try {
    const parsed = JSON.parse(rawValue);
    const annotations = Array.isArray(parsed)
      ? parsed.filter(isCodeAgentPreviewAnnotationContext)
      : [];
    return annotations.length > 0 ? annotations : EMPTY_PREVIEW_ANNOTATIONS;
  } catch {
    return EMPTY_PREVIEW_ANNOTATIONS;
  }
}

function readRawDraft(roomId: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(previewAnnotationDraftStorageKey(roomId));
  } catch {
    return null;
  }
}

function writeRawDraft(roomId: string, annotations: readonly CodeAgentPreviewAnnotationContext[]): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const storageKey = previewAnnotationDraftStorageKey(roomId);
  try {
    if (annotations.length === 0) {
      window.localStorage.removeItem(storageKey);
    } else {
      window.localStorage.setItem(storageKey, JSON.stringify(annotations.map(compactCodeAgentPreviewAnnotation)));
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

export function readCodeAgentPreviewAnnotationDraft(
  roomId: string,
): readonly CodeAgentPreviewAnnotationContext[] {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return EMPTY_PREVIEW_ANNOTATIONS;
  }

  const rawValue = readRawDraft(normalizedRoomId);
  const cached = snapshotsByRoomId.get(normalizedRoomId);
  if (cached?.rawValue === rawValue) {
    return cached.annotations;
  }

  const annotations = parseStoredPreviewAnnotations(rawValue);
  snapshotsByRoomId.set(normalizedRoomId, { rawValue, annotations });
  return annotations;
}

export function updateCodeAgentPreviewAnnotationDraft(
  roomId: string,
  updater: (
    annotations: readonly CodeAgentPreviewAnnotationContext[],
  ) => readonly CodeAgentPreviewAnnotationContext[],
): readonly CodeAgentPreviewAnnotationContext[] {
  const normalizedRoomId = normalizeRoomId(roomId);
  if (!normalizedRoomId) {
    return EMPTY_PREVIEW_ANNOTATIONS;
  }

  const currentAnnotations = readCodeAgentPreviewAnnotationDraft(normalizedRoomId);
  const nextAnnotations = updater(currentAnnotations);
  const annotations = nextAnnotations.length > 0 ? [...nextAnnotations] : EMPTY_PREVIEW_ANNOTATIONS;
  const rawValue = writeRawDraft(normalizedRoomId, annotations);
  snapshotsByRoomId.set(normalizedRoomId, { rawValue, annotations });
  emit();
  return annotations;
}

export function addCodeAgentPreviewAnnotationDraft(
  roomId: string,
  annotation: CodeAgentPreviewAnnotationContext,
) {
  updateCodeAgentPreviewAnnotationDraft(roomId, (current) => {
    const withoutSameAnnotation = current.filter((entry) => entry.id !== annotation.id);
    return [...withoutSameAnnotation, annotation];
  });
}

export function removeCodeAgentPreviewAnnotationDraft(roomId: string, annotationId: string) {
  updateCodeAgentPreviewAnnotationDraft(
    roomId,
    (current) => current.filter((entry) => entry.id !== annotationId),
  );
}

export function clearCodeAgentPreviewAnnotationDraft(roomId: string) {
  updateCodeAgentPreviewAnnotationDraft(roomId, () => EMPTY_PREVIEW_ANNOTATIONS);
}

export function useCodeAgentPreviewAnnotationDraft(
  roomId: string,
): readonly CodeAgentPreviewAnnotationContext[] {
  return useSyncExternalStore(
    subscribe,
    () => readCodeAgentPreviewAnnotationDraft(roomId),
    () => EMPTY_PREVIEW_ANNOTATIONS,
  );
}

export function resetCodeAgentPreviewAnnotationDraftStoreForTests() {
  snapshotsByRoomId.clear();
  listeners.clear();
}
