import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiffTitlePathMap,
  buildPatchCacheKey,
  getDiffCollapseIconClassName,
  getCodeAgentDiffFilePreviewState,
  getRenderablePatch,
  isPureRenameFileDiff,
  resetCodeAgentRenderablePatchCacheForTests,
  resolveFileDiffPath,
  resolveDiffTitleOpenPath,
  resolveCodeAgentDiffThemeName,
  summarizeFileDiffStat,
  stripDiffPathPrefix,
  withDiffLineTarget,
} from './codeAgentDiffRendering';

describe('codeAgentDiffRendering', () => {
  afterEach(() => {
    resetCodeAgentRenderablePatchCacheForTests();
    vi.restoreAllMocks();
  });

  it('returns stable T3-style cache keys and includes the cache scope', () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(`\n${patch}\n`));
    expect(buildPatchCacheKey(patch, 'workspace:light')).not.toBe(buildPatchCacheKey(patch, 'workspace:dark'));
  });

  it('resolves Pierre theme names like T3', () => {
    expect(resolveCodeAgentDiffThemeName('light')).toBe('pierre-light');
    expect(resolveCodeAgentDiffThemeName('dark')).toBe('pierre-dark');
  });

  it('reuses T3-style parsed diff results for the same cache scope and diff', () => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1,1 +1,1 @@',
      '-before',
      '+after',
    ].join('\n');

    const first = getRenderablePatch(patch, 'workspace:room-1:branch:auto');
    const second = getRenderablePatch(`\n${patch}\n`, 'workspace:room-1:branch:auto');
    expect(second).toBe(first);

    const differentScope = getRenderablePatch(patch, 'workspace:room-1:working-tree');
    expect(differentScope).not.toBe(first);
  });

  it('recomputes cached parsed diffs when render options change', () => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -48,1 +48,1 @@',
      '-before',
      '+after',
    ].join('\n');

    const sourceOffsets = getRenderablePatch(patch, 'workspace:partial');
    const compactOffsets = getRenderablePatch(patch, 'workspace:partial', {
      compactPartialHunkOffsets: true,
    });

    expect(compactOffsets).not.toBe(sourceOffsets);
    expect(compactOffsets).toBe(getRenderablePatch(patch, 'workspace:partial', {
      compactPartialHunkOffsets: true,
    }));
  });

  it('compacts partial hunk render offsets for virtualized workspace diffs', () => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      'index 1111111..2222222 100644',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -48,4 +48,4 @@',
      ' context',
      '-before',
      '+after',
      ' context',
      ' context',
      '@@ -80,3 +80,4 @@',
      ' context',
      '+added',
      ' context',
      ' context',
    ].join('\n');

    const parsed = getRenderablePatch(patch, 'workspace', {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it('retains source-file offsets when compacting is disabled', () => {
    const patch = [
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -48,1 +48,1 @@',
      '-before',
      '+after',
    ].join('\n');

    const parsed = getRenderablePatch(patch, 'workspace');
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });

  it('uses the T3 truncated raw excerpt reason and strips the truncation marker', () => {
    const parsed = getRenderablePatch('not a complete patch\n[truncated]', 'workspace', {
      truncated: true,
    });

    expect(parsed).toEqual({
      kind: 'raw',
      text: 'not a complete patch',
      reason: 'Diff was truncated before it could be parsed completely. Showing the raw excerpt.',
      truncated: true,
      notice: 'Diff output hit the server size cap. Showing the available excerpt.',
    });
  });

  it('silences Pierre parser errors while preserving partial file results like T3', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const parsed = getRenderablePatch('diff --git a/a.ts b/a.ts\n@@ broken', 'workspace');

    expect(consoleError).not.toHaveBeenCalled();
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.hunks).toEqual([]);
  });

  it('treats T3 truncation markers as partial renderable diffs', () => {
    const parsed = getRenderablePatch([
      'diff --git a/example.ts b/example.ts',
      'index 1111111..2222222 100644',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1 +1,2 @@',
      ' const before = 1;',
      '+const after = 2;',
      '',
      '[truncated]',
    ].join('\n'), 'workspace');

    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;
    expect(parsed.truncated).toBe(true);
    expect(parsed.notice).toBe('Diff output hit the server size cap. Showing the available excerpt.');
    expect(parsed.files).toHaveLength(1);
  });

  it('summarizes file diff stats from hunk metadata', () => {
    const parsed = getRenderablePatch([
      'diff --git a/example.ts b/example.ts',
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-before',
      '+after',
      '+added',
      ' context',
      '@@ -8,2 +9,2 @@',
      '-old',
      '+new',
    ].join('\n'), 'workspace');
    expect(parsed?.kind).toBe('files');
    if (parsed?.kind !== 'files') return;

    expect(summarizeFileDiffStat(parsed.files[0])).toEqual({ additions: 3, deletions: 2 });
  });

  it('resolves T3-style diff paths without git prefixes', () => {
    expect(resolveFileDiffPath({ name: 'b/src/App.tsx' } as any)).toBe('src/App.tsx');
    expect(resolveFileDiffPath({ prevName: 'a/src/Old.tsx' } as any)).toBe('src/Old.tsx');
    expect(resolveFileDiffPath({ name: 'src/App.tsx' } as any)).toBe('src/App.tsx');
  });

  it('returns T3-style collapse icon classes by file diff type', () => {
    expect(getDiffCollapseIconClassName({ type: 'new' } as any)).toBe('text-[var(--diffs-addition-base)]');
    expect(getDiffCollapseIconClassName({ type: 'deleted' } as any)).toBe('text-[var(--diffs-deletion-base)]');
    expect(getDiffCollapseIconClassName({ type: 'change' } as any)).toBe('text-[var(--diffs-modified-base)]');
    expect(getDiffCollapseIconClassName({ type: 'rename-pure' } as any)).toBe('text-[var(--diffs-modified-base)]');
    expect(getDiffCollapseIconClassName({ type: 'unknown' } as any)).toBe('text-muted-foreground/80');
  });

  it('detects T3-style pure rename files without modifications', () => {
    expect(isPureRenameFileDiff({
      type: 'rename-pure',
      name: 'b/src/New.ts',
      prevName: 'a/src/Old.ts',
      hunks: [],
      additionLines: [],
      deletionLines: [],
    } as any)).toBe(true);

    expect(isPureRenameFileDiff({
      type: 'rename-pure',
      name: 'b/src/New.ts',
      prevName: 'a/src/Old.ts',
      hunks: [{
        additionLines: 1,
        deletionLines: 0,
        hunkContent: [{ type: 'change', deletions: 0, additions: 1 }],
      }],
      additionLines: ['export const renamed = true;'],
      deletionLines: [],
    } as any)).toBe(false);

    expect(isPureRenameFileDiff({
      type: 'change',
      name: 'b/src/App.ts',
      hunks: [],
      additionLines: [],
      deletionLines: [],
    } as any)).toBe(false);
  });

  it('suppresses non-text diff previews like T3', () => {
    expect(getCodeAgentDiffFilePreviewState({
      name: 'b/assets/icon.png',
      hunks: [],
      additionLines: [],
      deletionLines: [],
    } as any)).toMatchObject({
      kind: 'suppressed',
      reason: 'non-text',
      title: 'Non-text file',
      actionLabel: null,
    });
  });

  it('suppresses large diff previews until explicitly loaded like T3', () => {
    expect(getCodeAgentDiffFilePreviewState({
      name: 'b/src/big.ts',
      hunks: [{
        additionLines: 401,
        deletionLines: 0,
        hunkContent: [{ type: 'change', deletions: 0, additions: 401 }],
      }],
      additionLines: Array.from({ length: 401 }, (_, index) => `const line${index} = ${index};`),
      deletionLines: [],
    } as any)).toMatchObject({
      kind: 'suppressed',
      reason: 'large',
      title: 'Large diff',
      actionLabel: 'Load diff',
    });
  });

  it('resolves T3-style diff title clicks to workspace file paths', () => {
    const pathMap = buildDiffTitlePathMap([
      { name: 'b/src/App.tsx' },
      { prevName: 'a/src/Old.tsx', name: 'b/src/New.tsx' },
    ] as any);

    expect(pathMap.get('b/src/App.tsx')).toBe('src/App.tsx');
    expect(pathMap.get('src/App.tsx')).toBe('src/App.tsx');
    expect(resolveDiffTitleOpenPath('src/App.tsx +2 -1', pathMap)).toBe('src/App.tsx');
    expect(resolveDiffTitleOpenPath('src/Old.tsx → src/New.tsx +1 -0', pathMap)).toBe('src/New.tsx');
    expect(resolveDiffTitleOpenPath('src/Old.tsx -> src/New.tsx', pathMap)).toBe('src/New.tsx');
    expect(resolveDiffTitleOpenPath('b/src/Unknown.ts', pathMap)).toBe('src/Unknown.ts');
    expect(resolveDiffTitleOpenPath('   ', pathMap)).toBeNull();
  });

  it('normalizes T3-style diff path prefixes and line targets', () => {
    expect(stripDiffPathPrefix('a/src/App.tsx')).toBe('src/App.tsx');
    expect(stripDiffPathPrefix('b/src/App.tsx')).toBe('src/App.tsx');
    expect(stripDiffPathPrefix('src/App.tsx')).toBe('src/App.tsx');
    expect(withDiffLineTarget('src/App.tsx', 42)).toBe('src/App.tsx#L42');
    expect(withDiffLineTarget('src/App.tsx', null)).toBe('src/App.tsx');
  });
});
