// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateCodeAgentRightPanelSurface,
  closeAllCodeAgentRightPanelSurfaces,
  closeCodeAgentRightPanelSurface,
  closeCodeAgentRightPanelSurfacesToRight,
  closeOtherCodeAgentRightPanelSurfaces,
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  readCodeAgentRightPanelState,
  reconcileCodeAgentFileSurfaces,
  removeCodeAgentRightPanelRoom,
  resetCodeAgentRightPanelStoreForTests,
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

  it('keeps files as a singleton surface', () => {
    openCodeAgentRightPanel('room-1', 'files');
    openCodeAgentRightPanel('room-1', 'files');

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [{ id: 'files', kind: 'files' }],
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

  it('reconciles file surfaces when the workspace is unavailable or paths disappear', () => {
    openCodeAgentRightPanelFile('room-1', 'src/index.ts');
    openCodeAgentRightPanelFile('room-1', 'README.md');

    reconcileCodeAgentFileSurfaces('room-1', true, new Set(['README.md']));
    expect(readCodeAgentRightPanelState('room-1').surfaces.map((surface) => surface.id)).toEqual([
      'file:README.md',
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
});
