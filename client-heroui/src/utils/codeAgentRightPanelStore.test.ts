// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateCodeAgentRightPanelSurface,
  addCodeAgentRightPanelPreviewSurface,
  closeAllCodeAgentRightPanelSurfaces,
  closeCodeAgentRightPanelSurface,
  closeCodeAgentRightPanelSurfacesToRight,
  closeOtherCodeAgentRightPanelSurfaces,
  closeCodeAgentRightPanel,
  migrateCodeAgentRightPanelState,
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  openCodeAgentRightPanelPreview,
  readCodeAgentRightPanelState,
  reconcileCodeAgentFileSurfaces,
  removeCodeAgentRightPanelRoom,
  resetCodeAgentRightPanelStoreForTests,
  selectActiveCodeAgentRightPanelKind,
  selectActiveCodeAgentRightPanelSurface,
  showCodeAgentRightPanel,
  toggleCodeAgentRightPanel,
  toggleCodeAgentRightPanelVisibility,
} from './codeAgentRightPanelStore';

describe('codeAgentRightPanelStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCodeAgentRightPanelStoreForTests();
  });

  afterEach(() => {
    localStorage.clear();
    resetCodeAgentRightPanelStoreForTests();
  });

  it('upgrades saved file surfaces with neutral reveal state like T3', () => {
    expect(
      migrateCodeAgentRightPanelState({
        byRoomId: {
          ' room-1 ': {
            isOpen: true,
            activeSurfaceId: 'file:src/index.ts',
            surfaces: [{ id: 'file:src/index.ts', kind: 'file', relativePath: 'src/index.ts' }],
          },
        },
      }),
    ).toEqual({
      byRoomId: {
        'room-1': {
          isOpen: true,
          activeSurfaceId: 'file:src/index.ts',
          surfaces: [
            {
              id: 'file:src/index.ts',
              kind: 'file',
              relativePath: 'src/index.ts',
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
  });

  it('keeps files as a singleton surface', () => {
    openCodeAgentRightPanel('room-1', 'files');
    openCodeAgentRightPanel('room-1', 'files');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [{ id: 'files', kind: 'files' }],
    });
  });

  it('opens T3-style browser preview surfaces for cloud workspace files', () => {
    openCodeAgentRightPanelPreview('room-1');
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:new',
      surfaces: [{ id: 'browser:new', kind: 'preview', relativePath: null }],
    });

    openCodeAgentRightPanelPreview('room-1', ' output/report.html ');
    openCodeAgentRightPanelPreview('room-1', 'output/report.html');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:output/report.html',
      surfaces: [
        {
          id: 'browser:output/report.html',
          kind: 'preview',
          relativePath: 'output/report.html',
        },
      ],
    });
  });

  it('adds another blank browser surface from the T3-style add browser action', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    addCodeAgentRightPanelPreviewSurface('room-1');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:new:2',
      surfaces: [
        { id: 'browser:new', kind: 'preview', relativePath: null },
        { id: 'browser:new:2', kind: 'preview', relativePath: null },
      ],
    });
  });

  it('keeps diff as a singleton surface and preserves it when opening file surfaces', () => {
    openCodeAgentRightPanel('room-1', 'diff');
    openCodeAgentRightPanel('room-1', 'diff');
    openCodeAgentRightPanel('room-1', 'files');
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        { id: 'diff', kind: 'diff' },
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it('replaces the standalone explorer with peer file surfaces', () => {
    openCodeAgentRightPanel('room-1', 'files');
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:README.md',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: 'file:README.md',
          kind: 'file',
          relativePath: 'README.md',
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it('updates line reveal requests when reopening a file surface', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts', 42);
    openCodeAgentRightPanelFile('room-1', 'src/index.ts', 87);

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    });

    openCodeAgentRightPanelFile('room-1', 'src/index.ts');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    });
  });

  it('closing the active surface activates a neighboring surface', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');

    closeCodeAgentRightPanelSurface('room-1', 'file:README.md');

    expect(readCodeAgentRightPanelState('room-1').activeSurfaceId).toBe('file:src/index.ts');
  });

  it('closing other surfaces keeps the selected surface active', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');
    openCodeAgentRightPanelFile('room-1', 'docs/Guide.md');

    closeOtherCodeAgentRightPanelSurfaces('room-1', 'file:README.md');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:README.md',
      surfaces: [
        {
          id: 'file:README.md',
          kind: 'file',
          relativePath: 'README.md',
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it('closing surfaces to the right activates the selected surface when active was removed', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');
    openCodeAgentRightPanelFile('room-1', 'docs/Guide.md');

    closeCodeAgentRightPanelSurfacesToRight('room-1', 'file:src/index.ts');

    expect(readCodeAgentRightPanelState('room-1').activeSurfaceId).toBe('file:src/index.ts');
    expect(readCodeAgentRightPanelState('room-1').surfaces.map((surface) => surface.id)).toEqual([
      'file:src/index.ts',
    ]);
  });

  it('reconciles file and cloud preview surfaces when the workspace is unavailable or paths disappear', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');
    openCodeAgentRightPanelPreview('room-1', 'output/report.html');

    reconcileCodeAgentFileSurfaces('room-1', true, new Set(['README.md', 'output/report.html']));
    expect(readCodeAgentRightPanelState('room-1').surfaces.map((surface) => surface.id)).toEqual([
      'file:README.md',
      'browser:output/report.html',
    ]);

    reconcileCodeAgentFileSurfaces('room-1', false);
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it('removes the standalone files surface when the workspace becomes unavailable like T3', () => {
    openCodeAgentRightPanel('room-1', 'diff');
    openCodeAgentRightPanel('room-1', 'files');
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');

    reconcileCodeAgentFileSurfaces('room-1', false);

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    });
  });

  it('falls back to the last remaining surface when reconciling invalid files like T3', () => {
    openCodeAgentRightPanel('room-1', 'diff');
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');
    activateCodeAgentRightPanelSurface('room-1', 'file:src/index.ts');

    reconcileCodeAgentFileSurfaces('room-1', true, new Set(['README.md']));

    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'file:README.md',
      surfaces: [
        { id: 'diff', kind: 'diff' },
        {
          id: 'file:README.md',
          kind: 'file',
          relativePath: 'README.md',
        },
      ],
    });
  });

  it('closes all surfaces and removes room state', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    closeAllCodeAgentRightPanelSurfaces('room-1');
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });

    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    removeCodeAgentRightPanelRoom('room-1');
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it('activates an existing surface without duplicating it', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');
    activateCodeAgentRightPanelSurface('room-1', 'file:src/index.ts');

    expect(readCodeAgentRightPanelState('room-1').activeSurfaceId).toBe('file:src/index.ts');
    expect(readCodeAgentRightPanelState('room-1').surfaces).toHaveLength(2);
  });

  it('hides the panel without clearing its selected surface like T3', () => {
    openCodeAgentRightPanel('room-1', 'diff');

    closeCodeAgentRightPanel('room-1');

    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBeNull();
    expect(selectActiveCodeAgentRightPanelSurface('room-1')).toBeNull();
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    });

    showCodeAgentRightPanel('room-1');
    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBe('diff');
    expect(selectActiveCodeAgentRightPanelSurface('room-1')).toEqual({ id: 'diff', kind: 'diff' });
  });

  it('toggles empty panel visibility without creating a surface like T3', () => {
    toggleCodeAgentRightPanelVisibility('room-1');
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    toggleCodeAgentRightPanelVisibility('room-1');
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it('toggles an active singleton surface by hiding instead of discarding tabs like T3', () => {
    toggleCodeAgentRightPanel('room-1', 'diff');
    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBe('diff');

    toggleCodeAgentRightPanel('room-1', 'diff');
    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBeNull();
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    });
  });

  it('toggles to a different singleton surface by switching active tabs like T3', () => {
    toggleCodeAgentRightPanel('room-1', 'diff');
    toggleCodeAgentRightPanel('room-1', 'files');

    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBe('files');
    expect(readCodeAgentRightPanelState('room-1').surfaces).toEqual([
      { id: 'diff', kind: 'diff' },
      { id: 'files', kind: 'files' },
    ]);
  });

  it('toggles a T3-style browser preview surface by hiding instead of discarding tabs', () => {
    toggleCodeAgentRightPanel('room-1', 'preview');
    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBe('preview');

    toggleCodeAgentRightPanel('room-1', 'preview');
    expect(selectActiveCodeAgentRightPanelKind('room-1')).toBeNull();
    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: false,
      activeSurfaceId: 'browser:new',
      surfaces: [{ id: 'browser:new', kind: 'preview', relativePath: null }],
    });
  });
});
