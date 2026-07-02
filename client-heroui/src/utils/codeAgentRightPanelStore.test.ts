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
  getCodeAgentPreviewSurfaceNavigationState,
  migrateCodeAgentRightPanelState,
  navigateCodeAgentRightPanelPreviewHistory,
  navigateCodeAgentRightPanelPreviewSurface,
  openCodeAgentRightPanel,
  openCodeAgentRightPanelFile,
  openCodeAgentRightPanelPreview,
  readCodeAgentPreviewRecentTargets,
  readCodeAgentRightPanelState,
  reconcileCodeAgentFileSurfaces,
  removeCodeAgentRightPanelRoom,
  resetCodeAgentRightPanelStoreForTests,
  selectActiveCodeAgentRightPanelKind,
  selectActiveCodeAgentRightPanelSurface,
  setCodeAgentRightPanelPreviewZoomFactor,
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
          navigationHistory: [{ kind: 'workspace-file', relativePath: 'output/report.html' }],
          navigationIndex: 0,
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

  it('navigates a browser surface to URL and workspace preview targets', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: ' https://example.com/report ',
    });

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:url:https%3A%2F%2Fexample.com%2Freport',
      surfaces: [
        {
          id: 'browser:url:https%3A%2F%2Fexample.com%2Freport',
          kind: 'preview',
          relativePath: null,
          url: 'https://example.com/report',
          navigationHistory: [{ kind: 'url', url: 'https://example.com/report' }],
          navigationIndex: 0,
        },
      ],
    });

    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Freport',
      {
        kind: 'workspace-file',
        relativePath: ' output/report.html ',
      },
    );

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:output/report.html',
      surfaces: [
        {
          id: 'browser:output/report.html',
          kind: 'preview',
          relativePath: 'output/report.html',
          navigationHistory: [
            { kind: 'url', url: 'https://example.com/report' },
            { kind: 'workspace-file', relativePath: 'output/report.html' },
          ],
          navigationIndex: 1,
        },
      ],
    });
  });

  it('remembers recent browser preview targets for empty browser tabs', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: ' https://example.com/report ',
    });
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Freport',
      {
        kind: 'workspace-file',
        relativePath: ' output/report.html ',
      },
    );
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:output/report.html',
      {
        kind: 'url',
        url: 'https://example.com/report',
      },
    );
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Freport',
      {
        kind: 'url',
        url: 'javascript:alert(1)',
      },
    );

    expect(readCodeAgentPreviewRecentTargets('room-1')).toEqual([
      { kind: 'url', url: 'https://example.com/report' },
      { kind: 'workspace-file', relativePath: 'output/report.html' },
    ]);

    for (let index = 0; index < 12; index += 1) {
      navigateCodeAgentRightPanelPreviewSurface(
        'room-1',
        readCodeAgentRightPanelState('room-1').activeSurfaceId || 'browser:new',
        {
          kind: 'url',
          url: `https://example.com/${index}`,
        },
      );
    }

    const recentTargets = readCodeAgentPreviewRecentTargets('room-1');
    expect(recentTargets).toHaveLength(10);
    expect(recentTargets[0]).toEqual({ kind: 'url', url: 'https://example.com/11' });
    expect(recentTargets.at(-1)).toEqual({ kind: 'url', url: 'https://example.com/2' });
  });

  it('moves browser preview surfaces through their navigation history', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'https://example.com/one',
    });
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      {
        kind: 'url',
        url: 'https://example.com/two',
      },
    );

    let state = readCodeAgentRightPanelState('room-1');
    expect(state.activeSurfaceId).toBe('browser:url:https%3A%2F%2Fexample.com%2Ftwo');
    expect(getCodeAgentPreviewSurfaceNavigationState(state.surfaces[0])).toEqual({
      canGoBack: true,
      canGoForward: false,
    });

    navigateCodeAgentRightPanelPreviewHistory(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Ftwo',
      'back',
    );

    state = readCodeAgentRightPanelState('room-1');
    expect(state).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:url:https%3A%2F%2Fexample.com%2Fone',
      surfaces: [
        {
          id: 'browser:url:https%3A%2F%2Fexample.com%2Fone',
          kind: 'preview',
          relativePath: null,
          url: 'https://example.com/one',
          navigationHistory: [
            { kind: 'url', url: 'https://example.com/one' },
            { kind: 'url', url: 'https://example.com/two' },
          ],
          navigationIndex: 0,
        },
      ],
    });
    expect(getCodeAgentPreviewSurfaceNavigationState(state.surfaces[0])).toEqual({
      canGoBack: false,
      canGoForward: true,
    });

    navigateCodeAgentRightPanelPreviewHistory(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      'forward',
    );

    state = readCodeAgentRightPanelState('room-1');
    expect(state.activeSurfaceId).toBe('browser:url:https%3A%2F%2Fexample.com%2Ftwo');
    expect(state.surfaces[0]).toMatchObject({
      url: 'https://example.com/two',
      navigationIndex: 1,
    });
  });

  it('keeps browser preview zoom scoped to a surface across navigation', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'https://example.com/one',
    });
    setCodeAgentRightPanelPreviewZoomFactor(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      1.2,
    );

    expect(readCodeAgentRightPanelState('room-1').surfaces[0]).toMatchObject({
      id: 'browser:url:https%3A%2F%2Fexample.com%2Fone',
      zoomFactor: 1.2,
    });

    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      {
        kind: 'url',
        url: 'https://example.com/two',
      },
    );
    expect(readCodeAgentRightPanelState('room-1').surfaces[0]).toMatchObject({
      id: 'browser:url:https%3A%2F%2Fexample.com%2Ftwo',
      zoomFactor: 1.2,
    });

    setCodeAgentRightPanelPreviewZoomFactor(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Ftwo',
      1,
    );
    expect(readCodeAgentRightPanelState('room-1').surfaces[0]).not.toHaveProperty('zoomFactor');
  });

  it('truncates browser preview forward history after a new navigation', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'https://example.com/one',
    });
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      {
        kind: 'url',
        url: 'https://example.com/two',
      },
    );
    navigateCodeAgentRightPanelPreviewHistory(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Ftwo',
      'back',
    );
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Fone',
      {
        kind: 'workspace-file',
        relativePath: 'output/report.html',
      },
    );

    const state = readCodeAgentRightPanelState('room-1');
    expect(state.activeSurfaceId).toBe('browser:output/report.html');
    expect(state.surfaces[0]).toMatchObject({
      relativePath: 'output/report.html',
      navigationHistory: [
        { kind: 'url', url: 'https://example.com/one' },
        { kind: 'workspace-file', relativePath: 'output/report.html' },
      ],
      navigationIndex: 1,
    });
    expect(getCodeAgentPreviewSurfaceNavigationState(state.surfaces[0])).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it('keeps browser preview history when navigation reuses an existing surface', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'https://example.com/one',
    });
    addCodeAgentRightPanelPreviewSurface('room-1');
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'https://example.com/two',
    });
    navigateCodeAgentRightPanelPreviewSurface(
      'room-1',
      'browser:url:https%3A%2F%2Fexample.com%2Ftwo',
      {
        kind: 'url',
        url: 'https://example.com/one',
      },
    );

    const state = readCodeAgentRightPanelState('room-1');
    expect(state).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:url:https%3A%2F%2Fexample.com%2Fone',
      surfaces: [
        {
          id: 'browser:url:https%3A%2F%2Fexample.com%2Fone',
          kind: 'preview',
          relativePath: null,
          url: 'https://example.com/one',
          navigationHistory: [
            { kind: 'url', url: 'https://example.com/two' },
            { kind: 'url', url: 'https://example.com/one' },
          ],
          navigationIndex: 1,
        },
      ],
    });
  });

  it('rejects unsafe browser preview URLs when navigating a surface', () => {
    addCodeAgentRightPanelPreviewSurface('room-1');

    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'javascript:alert(1)',
    });
    navigateCodeAgentRightPanelPreviewSurface('room-1', 'browser:new', {
      kind: 'url',
      url: 'data:text/html,<h1>preview</h1>',
    });

    expect(readCodeAgentRightPanelState('room-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:new',
      surfaces: [{ id: 'browser:new', kind: 'preview', relativePath: null }],
    });
  });

  it('drops unsafe saved browser preview URLs during migration', () => {
    expect(
      migrateCodeAgentRightPanelState({
        byRoomId: {
          'room-1': {
            isOpen: true,
            activeSurfaceId: 'browser:url:javascript%3Aalert(1)',
            surfaces: [
              {
                id: 'browser:url:javascript%3Aalert(1)',
                kind: 'preview',
                relativePath: null,
                url: 'javascript:alert(1)',
              },
              {
                id: 'browser:url:https%3A%2F%2Fexample.com%2Freport',
                kind: 'preview',
                relativePath: null,
                url: ' https://example.com/report ',
              },
              {
                id: 'browser:url:data%3Atext%2Fhtml%2C%3Ch1%3Epreview%3C%2Fh1%3E',
                kind: 'preview',
                relativePath: null,
                url: 'data:text/html,<h1>preview</h1>',
              },
            ],
          },
        },
      }),
    ).toEqual({
      byRoomId: {
        'room-1': {
          isOpen: true,
          activeSurfaceId: null,
          surfaces: [
            {
              id: 'browser:url:https%3A%2F%2Fexample.com%2Freport',
              kind: 'preview',
              relativePath: null,
              url: 'https://example.com/report',
              navigationHistory: [{ kind: 'url', url: 'https://example.com/report' }],
              navigationIndex: 0,
            },
          ],
        },
      },
      recentPreviewTargetsByRoomId: {
        'room-1': [{ kind: 'url', url: 'https://example.com/report' }],
      },
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
