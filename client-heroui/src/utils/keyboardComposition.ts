export const COMPOSITION_END_GRACE_MS = 80;

export interface CompositionGuardState {
  isComposing: boolean;
  nativeIsComposing?: boolean;
  keyCode?: number;
  lastCompositionEndAt: number;
  now: number;
  graceMs?: number;
}

export const isConfirmingIMEComposition = ({
  isComposing,
  nativeIsComposing,
  keyCode,
  lastCompositionEndAt,
  now,
  graceMs = COMPOSITION_END_GRACE_MS,
}: CompositionGuardState) => {
  return (
    isComposing ||
    !!nativeIsComposing ||
    keyCode === 229 ||
    now - lastCompositionEndAt < graceMs
  );
};

export const getKeyboardCompositionSnapshot = (
  event: React.KeyboardEvent,
  isComposing: boolean,
  lastCompositionEndAt: number,
  now = Date.now()
) => {
  const nativeEvent = event.nativeEvent as KeyboardEvent & {
    isComposing?: boolean;
    keyCode?: number;
  };

  return {
    isComposing,
    nativeIsComposing: nativeEvent.isComposing,
    keyCode: nativeEvent.keyCode,
    lastCompositionEndAt,
    now,
  };
};
