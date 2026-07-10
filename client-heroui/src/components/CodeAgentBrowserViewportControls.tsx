import {
  Link2,
  RotateCw,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA,
  CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION,
  CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION,
  CODE_AGENT_PREVIEW_VIEWPORT_PRESETS,
  FILL_CODE_AGENT_PREVIEW_VIEWPORT,
  resolveCodeAgentPreviewViewport,
  type CodeAgentPreviewViewportSetting,
  type CodeAgentPreviewViewportSize,
} from '../utils/codeAgentPreviewViewport';
import {
  CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT,
  CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE,
  codeAgentBrowserViewportSettingKey,
  resizeCodeAgentBrowserViewportFromRail,
  resizeCodeAgentFreeformViewport,
  resolveCodeAgentBrowserDeviceViewportArea,
  resolveCodeAgentBrowserDeviceViewportLayout,
  resolveCodeAgentBrowserViewportLayout,
  type CodeAgentBrowserViewportLayout,
  type CodeAgentBrowserViewportResizeDirection,
} from '../utils/codeAgentBrowserViewportLayout';

const RESPONSIVE_VALUE = 'responsive';
const KEYBOARD_RESIZE_COMMIT_DELAY_MS = 150;

type ViewportDrag = CodeAgentPreviewViewportSize & {
  readonly sourceKey: string;
  readonly direction: CodeAgentBrowserViewportResizeDirection;
};

type CodeAgentBrowserViewportChangeHandler = (
  setting: CodeAgentPreviewViewportSetting,
) => unknown;

interface CodeAgentBrowserDeviceToolbarProps {
  setting: Exclude<CodeAgentPreviewViewportSetting, { readonly _tag: 'fill' }>;
  width: number;
  aspectRatio: number | null;
  onAspectRatioChange: (aspectRatio: number | null) => void;
  onChange: CodeAgentBrowserViewportChangeHandler;
}

interface CodeAgentBrowserViewportResizeOptions {
  readonly viewport: CodeAgentPreviewViewportSetting;
  readonly zoomFactor: number;
  readonly containerSize: CodeAgentPreviewViewportSize;
  readonly deviceToolbarVisible: boolean;
  readonly aspectRatio: number | null;
  readonly onChange: CodeAgentBrowserViewportChangeHandler;
}

export function CodeAgentBrowserDeviceToolbar({
  setting,
  width,
  aspectRatio,
  onAspectRatioChange,
  onChange,
}: CodeAgentBrowserDeviceToolbarProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [customSize, setCustomSize] = useState<{
    readonly width: string;
    readonly height: string;
  } | null>(null);
  const presentedSize = customSize ?? {
    width: String(setting.width),
    height: String(setting.height),
  };
  const selectedValue = setting._tag === 'preset'
    && CODE_AGENT_PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === setting.presetId)
    ? setting.presetId
    : RESPONSIVE_VALUE;
  const customWidth = Number(presentedSize.width);
  const customHeight = Number(presentedSize.height);
  const customValid = Number.isInteger(customWidth)
    && Number.isInteger(customHeight)
    && customWidth >= CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION
    && customWidth <= CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION
    && customHeight >= CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION
    && customHeight <= CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION
    && customWidth * customHeight <= CODE_AGENT_PREVIEW_VIEWPORT_MAX_AREA;

  const apply = useCallback((
    next: CodeAgentPreviewViewportSetting,
    nextAspectRatio = aspectRatio,
  ) => {
    setPending(true);
    void Promise.resolve(onChange(next)).then(
      () => {
        onAspectRatioChange(nextAspectRatio);
        setPending(false);
        setCustomSize(null);
      },
      () => setPending(false),
    );
  }, [aspectRatio, onAspectRatioChange, onChange]);

  const applyCustomSize = useCallback(() => {
    if (!customValid || (customWidth === setting.width && customHeight === setting.height)) {
      setCustomSize(null);
      return;
    }
    apply({ _tag: 'freeform', width: customWidth, height: customHeight });
  }, [apply, customHeight, customValid, customWidth, setting.height, setting.width]);

  const updateCustomDimension = useCallback((axis: 'width' | 'height', value: string) => {
    setCustomSize((current) => {
      const next = {
        width: axis === 'width' ? value : (current?.width ?? String(setting.width)),
        height: axis === 'height' ? value : (current?.height ?? String(setting.height)),
      };
      const numeric = Number(value);
      if (
        aspectRatio === null
        || !Number.isInteger(numeric)
        || numeric < CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION
        || numeric > CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION
      ) {
        return next;
      }
      const resized = resizeCodeAgentFreeformViewport(
        setting,
        axis === 'width'
          ? { x: numeric - setting.width, y: 0 }
          : { x: 0, y: numeric - setting.height },
        1,
        axis === 'width' ? 'east' : 'south',
        aspectRatio,
      );
      return { width: String(resized.width), height: String(resized.height) };
    });
  }, [aspectRatio, setting]);

  const selectViewport = useCallback((value: string) => {
    if (!value) return;
    if (value === RESPONSIVE_VALUE) {
      if (setting._tag === 'freeform') return;
      apply({ _tag: 'freeform', width: setting.width, height: setting.height });
      return;
    }
    const preset = CODE_AGENT_PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    apply(
      resolveCodeAgentPreviewViewport({ mode: 'preset', preset: preset.id }),
      aspectRatio === null ? null : preset.width / preset.height,
    );
  }, [apply, aspectRatio, setting]);

  const rotate = useCallback(() => {
    const hasCustomSize = customValid
      && (customWidth !== setting.width || customHeight !== setting.height);
    const source = hasCustomSize
      ? ({ _tag: 'freeform', width: customWidth, height: customHeight } as const)
      : setting;
    apply(
      { ...source, width: source.height, height: source.width },
      aspectRatio === null ? null : 1 / aspectRatio,
    );
  }, [apply, aspectRatio, customHeight, customValid, customWidth, setting]);

  return (
    <div
      className="sticky left-0 top-0 z-50 flex items-center gap-0.5 overflow-x-auto border-b border-[#dedbd0] bg-[#faf9f5]/95 px-1.5 shadow-sm backdrop-blur-md [scrollbar-width:none] dark:border-[#30302e] dark:bg-[#1d1d1b]/95 [&::-webkit-scrollbar]:hidden"
      style={{ width, height: CODE_AGENT_BROWSER_DEVICE_TOOLBAR_HEIGHT }}
      role="toolbar"
      aria-label={t('codeAgentBrowserDeviceToolbar')}
      data-testid="code-agent-browser-device-toolbar"
    >
      {width >= 560 ? (
        <span className="mr-0.5 shrink-0 text-[11px] font-medium text-[#5e5d59] dark:text-[#8f8d86]">
          {t('codeAgentBrowserDimensions')}
        </span>
      ) : null}
      <select
        value={selectedValue}
        disabled={pending}
        aria-label={t('codeAgentBrowserDevicePreset')}
        className={`h-6 shrink-0 rounded-md border border-transparent bg-transparent px-1.5 text-xs font-medium text-[#141413] outline-none hover:bg-[#f0eee6] focus:border-[#c96442]/70 dark:text-[#faf9f5] dark:hover:bg-[#30302e] ${
          width >= 440 ? 'w-36' : 'w-24'
        }`}
        onChange={(event) => selectViewport(event.target.value)}
      >
        <option value={RESPONSIVE_VALUE}>{t('codeAgentBrowserResponsive')}</option>
        {CODE_AGENT_PREVIEW_VIEWPORT_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label} ({preset.detail})
          </option>
        ))}
      </select>

      <form
        className="m-0 flex min-w-0 shrink-0 items-center gap-0.5 border-0 p-0"
        aria-label={t('codeAgentBrowserViewportDimensions')}
        onSubmit={(event) => {
          event.preventDefault();
          applyCustomSize();
        }}
      >
        <input
          type="number"
          inputMode="numeric"
          min={CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.width}
          disabled={pending}
          aria-label={t('codeAgentBrowserViewportWidth')}
          aria-invalid={!customValid}
          className={`h-6 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-1 text-center text-xs tabular-nums text-[#141413] outline-none [appearance:textfield] focus:border-[#c96442]/70 disabled:opacity-50 dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] [&::-webkit-inner-spin-button]:appearance-none ${
            width >= 360 ? 'w-14' : 'w-11'
          }`}
          onFocus={() => setCustomSize((current) => current ?? {
            width: String(setting.width),
            height: String(setting.height),
          })}
          onChange={(event) => updateCustomDimension('width', event.target.value)}
          onBlur={applyCustomSize}
        />
        <span className="text-xs text-[#5e5d59] dark:text-[#8f8d86]" aria-hidden="true">
          {'×'}
        </span>
        <input
          type="number"
          inputMode="numeric"
          min={CODE_AGENT_PREVIEW_VIEWPORT_MIN_DIMENSION}
          max={CODE_AGENT_PREVIEW_VIEWPORT_MAX_DIMENSION}
          value={presentedSize.height}
          disabled={pending}
          aria-label={t('codeAgentBrowserViewportHeight')}
          aria-invalid={!customValid}
          className={`h-6 rounded-md border border-[#dedbd0] bg-[#faf9f5] px-1 text-center text-xs tabular-nums text-[#141413] outline-none [appearance:textfield] focus:border-[#c96442]/70 disabled:opacity-50 dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5] [&::-webkit-inner-spin-button]:appearance-none ${
            width >= 360 ? 'w-14' : 'w-11'
          }`}
          onFocus={() => setCustomSize((current) => current ?? {
            width: String(setting.width),
            height: String(setting.height),
          })}
          onChange={(event) => updateCustomDimension('height', event.target.value)}
          onBlur={applyCustomSize}
        />
      </form>

      <button
        type="button"
        aria-label={
          aspectRatio === null
            ? t('codeAgentBrowserLockAspectRatio')
            : t('codeAgentBrowserUnlockAspectRatio')
        }
        aria-pressed={aspectRatio !== null}
        title={
          aspectRatio === null
            ? t('codeAgentBrowserLockAspectRatio')
            : t('codeAgentBrowserUnlockAspectRatio')
        }
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#b0aea5] dark:hover:bg-[#30302e] ${
          aspectRatio !== null ? 'bg-[#f0eee6] text-[#141413] dark:bg-[#30302e] dark:text-[#faf9f5]' : ''
        }`}
        disabled={pending || !customValid}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onAspectRatioChange(aspectRatio === null ? customWidth / customHeight : null)}
      >
        <Link2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('codeAgentBrowserRotateViewport')}
        title={t('codeAgentBrowserRotateViewport')}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
        disabled={pending}
        onClick={rotate}
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={t('codeAgentBrowserCloseDeviceToolbar')}
        title={t('codeAgentBrowserCloseDeviceToolbar')}
        className="sticky right-0 ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#faf9f5]/95 text-[#5e5d59] hover:bg-[#f0eee6] disabled:cursor-not-allowed disabled:opacity-45 dark:bg-[#1d1d1b]/95 dark:text-[#b0aea5] dark:hover:bg-[#30302e]"
        disabled={pending}
        onClick={() => apply(FILL_CODE_AGENT_PREVIEW_VIEWPORT, null)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function CodeAgentBrowserViewportResizeHandles({
  layout,
  activeDirection,
  onPointerDown,
  onKeyDown,
}: {
  layout: CodeAgentBrowserViewportLayout;
  activeDirection: CodeAgentBrowserViewportResizeDirection | null;
  onPointerDown: (
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onKeyDown: (
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}) {
  const { t } = useTranslation();
  const left = layout.viewportX;
  const top = layout.viewportY;
  const right = left + layout.viewportWidth;
  const bottom = top + layout.viewportHeight;
  const railSize = CODE_AGENT_BROWSER_VIEWPORT_RESIZE_RAIL_SIZE;
  const shared = { activeDirection, onPointerDown, onKeyDown };

  return (
    <>
      <ResizeHandle
        direction="west"
        label={t('codeAgentBrowserResizeViewportFromLeft')}
        kind="vertical"
        cursorClassName="cursor-ew-resize"
        style={{ left: left - railSize, top, width: railSize, height: layout.viewportHeight }}
        active={shared.activeDirection === 'west'}
        onPointerDown={shared.onPointerDown}
        onKeyDown={shared.onKeyDown}
      />
      <ResizeHandle
        direction="east"
        label={t('codeAgentBrowserResizeViewportFromRight')}
        kind="vertical"
        cursorClassName="cursor-ew-resize"
        style={{ left: right, top, width: railSize, height: layout.viewportHeight }}
        active={shared.activeDirection === 'east'}
        onPointerDown={shared.onPointerDown}
        onKeyDown={shared.onKeyDown}
      />
      <ResizeHandle
        direction="south"
        label={t('codeAgentBrowserResizeViewportFromBottom')}
        kind="horizontal"
        cursorClassName="cursor-ns-resize"
        style={{ left, top: bottom, width: layout.viewportWidth, height: railSize }}
        active={shared.activeDirection === 'south'}
        onPointerDown={shared.onPointerDown}
        onKeyDown={shared.onKeyDown}
      />
      <ResizeHandle
        direction="southwest"
        label={t('codeAgentBrowserResizeViewportFromBottomLeft')}
        kind="corner"
        cursorClassName="cursor-nesw-resize"
        style={{ left: left - railSize, top: bottom, width: railSize, height: railSize }}
        active={shared.activeDirection === 'southwest'}
        mirrorCorner
        onPointerDown={shared.onPointerDown}
        onKeyDown={shared.onKeyDown}
      />
      <ResizeHandle
        direction="southeast"
        label={t('codeAgentBrowserResizeViewportFromBottomRight')}
        kind="corner"
        cursorClassName="cursor-nwse-resize"
        style={{ left: right, top: bottom, width: railSize, height: railSize }}
        active={shared.activeDirection === 'southeast'}
        onPointerDown={shared.onPointerDown}
        onKeyDown={shared.onKeyDown}
      />
    </>
  );
}

export function useCodeAgentBrowserViewportResize(options: CodeAgentBrowserViewportResizeOptions) {
  const {
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio,
    onChange,
  } = options;
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const dragVersionRef = useRef(0);
  const keyboardCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardViewportRef = useRef<ViewportDrag | null>(null);
  const [dragViewport, setDragViewport] = useState<ViewportDrag | null>(null);
  const sourceViewportKey = codeAgentBrowserViewportSettingKey(viewport);
  const sourceViewportKeyRef = useRef(sourceViewportKey);
  sourceViewportKeyRef.current = sourceViewportKey;
  const activeDrag = dragViewport?.sourceKey === sourceViewportKey ? dragViewport : null;
  const effectiveViewport = activeDrag
    ? ({
      _tag: 'freeform',
      width: activeDrag.width,
      height: activeDrag.height,
    } as const satisfies CodeAgentPreviewViewportSetting)
    : viewport;
  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportContainerSize = deviceToolbarVisible
    ? resolveCodeAgentBrowserDeviceViewportArea(containerSize)
    : containerSize;
  const layout = deviceToolbarVisible && effectiveViewport._tag !== 'fill'
    ? resolveCodeAgentBrowserDeviceViewportLayout(containerSize, effectiveViewport, zoomFactor)
    : resolveCodeAgentBrowserViewportLayout(containerSize, effectiveViewport, zoomFactor);

  useEffect(() => () => {
    dragVersionRef.current += 1;
    dragCleanupRef.current?.();
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
    }
    keyboardCommitTimerRef.current = null;
    keyboardViewportRef.current = null;
  }, []);

  useEffect(() => {
    const pending = keyboardViewportRef.current;
    if (!pending || pending.sourceKey === sourceViewportKey) return;
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
      keyboardCommitTimerRef.current = null;
    }
    keyboardViewportRef.current = null;
  }, [sourceViewportKey]);

  const commitViewportChange = useCallback((next: CodeAgentPreviewViewportSetting) => {
    dragVersionRef.current += 1;
    dragCleanupRef.current?.();
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
      keyboardCommitTimerRef.current = null;
    }
    keyboardViewportRef.current = null;
    setDragViewport(null);
    return Promise.resolve(onChange(next));
  }, [onChange]);

  const clearDrag = useCallback(() => setDragViewport(null), []);

  const commitDrag = useCallback((next: CodeAgentPreviewViewportSetting) => {
    const version = ++dragVersionRef.current;
    const clearIfCurrent = () => {
      if (dragVersionRef.current === version) clearDrag();
    };
    void Promise.resolve(onChange(next)).then(clearIfCurrent, clearIfCurrent);
  }, [clearDrag, onChange]);

  const handleResizeKeyDown = useCallback((
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (effectiveViewport._tag === 'fill') return;
    const controlsWidth = direction.includes('east') || direction.includes('west');
    const controlsHeight = direction.includes('north') || direction.includes('south');
    const step = (event.shiftKey ? 50 : 10) * normalizedZoomFactor;
    const delta = event.key === 'ArrowLeft' && controlsWidth
      ? { x: -step, y: 0 }
      : event.key === 'ArrowRight' && controlsWidth
        ? { x: step, y: 0 }
        : event.key === 'ArrowUp' && controlsHeight
          ? { x: 0, y: -step }
          : event.key === 'ArrowDown' && controlsHeight
            ? { x: 0, y: step }
            : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const pending = keyboardViewportRef.current;
    const base = pending?.sourceKey === sourceViewportKey ? pending : effectiveViewport;
    const next = resizeCodeAgentFreeformViewport(
      base,
      delta,
      zoomFactor,
      direction,
      aspectRatio ?? undefined,
    );
    if (next.width === base.width && next.height === base.height) return;
    const keyboardViewport = { sourceKey: sourceViewportKey, ...next, direction };
    keyboardViewportRef.current = keyboardViewport;
    setDragViewport(keyboardViewport);
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
    }
    keyboardCommitTimerRef.current = setTimeout(() => {
      keyboardCommitTimerRef.current = null;
      const latest = keyboardViewportRef.current;
      if (!latest || latest.sourceKey !== sourceViewportKeyRef.current) return;
      keyboardViewportRef.current = null;
      commitDrag({ _tag: 'freeform', width: latest.width, height: latest.height });
    }, KEYBOARD_RESIZE_COMMIT_DELAY_MS);
  }, [aspectRatio, commitDrag, effectiveViewport, normalizedZoomFactor, sourceViewportKey, zoomFactor]);

  const handleResizePointerDown = useCallback((
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (effectiveViewport._tag === 'fill') return;
    event.preventDefault();
    event.stopPropagation();
    if (keyboardCommitTimerRef.current !== null) {
      clearTimeout(keyboardCommitTimerRef.current);
      keyboardCommitTimerRef.current = null;
    }
    keyboardViewportRef.current = null;
    dragCleanupRef.current?.();
    dragVersionRef.current += 1;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = effectiveViewport.width;
    const startHeight = effectiveViewport.height;
    const dragZoomFactor = normalizedZoomFactor * layout.viewportScale;
    let latest = { width: startWidth, height: startHeight };
    setDragViewport({
      sourceKey: sourceViewportKey,
      width: startWidth,
      height: startHeight,
      direction,
    });
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Window listeners below keep the drag functional when capture is unavailable.
    }

    const sourceChanged = () => sourceViewportKeyRef.current !== sourceViewportKey;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (sourceChanged()) {
        cleanup();
        dragVersionRef.current += 1;
        clearDrag();
        return;
      }
      moveEvent.preventDefault();
      const { width, height } = resizeCodeAgentBrowserViewportFromRail(
        { width: startWidth, height: startHeight },
        {
          x: moveEvent.clientX - startX,
          y: moveEvent.clientY - startY,
        },
        viewportContainerSize,
        dragZoomFactor,
        direction,
        aspectRatio ?? undefined,
      );
      latest = { width, height };
      setDragViewport({ sourceKey: sourceViewportKey, width, height, direction });
    };
    function cleanup() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      dragCleanupRef.current = null;
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // The browser may already have released capture on pointerup.
      }
    }
    function finish(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      cleanup();
      if (sourceChanged() || (latest.width === startWidth && latest.height === startHeight)) {
        clearDrag();
        return;
      }
      commitDrag({ _tag: 'freeform', width: latest.width, height: latest.height });
    }
    function cancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
      dragVersionRef.current += 1;
      clearDrag();
    }
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  }, [
    aspectRatio,
    clearDrag,
    commitDrag,
    effectiveViewport,
    layout.viewportScale,
    normalizedZoomFactor,
    sourceViewportKey,
    viewportContainerSize,
  ]);

  return {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout,
  };
}

type HandleKind = 'horizontal' | 'vertical' | 'corner';

function ResizeHandle({
  direction,
  label,
  kind,
  cursorClassName,
  style,
  active,
  mirrorCorner = false,
  onPointerDown,
  onKeyDown,
}: {
  direction: CodeAgentBrowserViewportResizeDirection;
  label: string;
  kind: HandleKind;
  cursorClassName: string;
  style: CSSProperties;
  active: boolean;
  mirrorCorner?: boolean;
  onPointerDown: (
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onKeyDown: (
    direction: CodeAgentBrowserViewportResizeDirection,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${label}. Use arrow keys to resize.`}
      className={`group absolute z-20 touch-none border-0 bg-transparent p-0 outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:bg-[#141413]/[0.04] ${
        kind === 'corner' ? 'z-30' : ''
      } ${cursorClassName}`}
      style={style}
      onPointerDown={(event) => onPointerDown(direction, event)}
      onKeyDown={(event) => onKeyDown(direction, event)}
    >
      <span
        className={`pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center text-[#5e5d59]/60 transition-colors duration-150 group-hover:text-[#141413]/85 group-focus-visible:text-[#141413] group-active:text-[#141413] dark:text-[#8f8d86]/60 dark:group-hover:text-[#faf9f5]/85 dark:group-focus-visible:text-[#faf9f5] dark:group-active:text-[#faf9f5] ${
          kind === 'vertical' ? 'h-8 w-1.5' : ''
        } ${kind === 'horizontal' ? 'h-1.5 w-8' : ''} ${
          kind === 'corner' ? 'size-3' : ''
        } ${active ? 'text-[#141413] dark:text-[#faf9f5]' : ''}`}
      >
        {kind === 'vertical' ? (
          <span className="flex gap-px" aria-hidden="true">
            <span className="h-6 w-px rounded-full bg-current" />
            <span className="h-6 w-px rounded-full bg-current" />
          </span>
        ) : kind === 'horizontal' ? (
          <span className="flex flex-col gap-px" aria-hidden="true">
            <span className="h-px w-6 rounded-full bg-current" />
            <span className="h-px w-6 rounded-full bg-current" />
          </span>
        ) : (
          <span
            className={`relative block size-3 ${mirrorCorner ? '-scale-x-100' : ''}`}
            aria-hidden="true"
          >
            <span className="absolute bottom-[3px] left-0 h-px w-3 -rotate-45 rounded-full bg-current" />
            <span className="absolute bottom-0 left-[5px] h-px w-2 -rotate-45 rounded-full bg-current" />
          </span>
        )}
      </span>
    </button>
  );
}
