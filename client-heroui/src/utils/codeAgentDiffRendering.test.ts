import { describe, expect, it } from 'vitest';
import {
  buildPatchCacheKey,
  getDiffCollapseIconClassName,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveCodeAgentDiffThemeName,
  summarizeFileDiffStat,
} from './codeAgentDiffRendering';

describe('codeAgentDiffRendering', () => {
  it('returns stable T3-style cache keys and includes the cache scope', () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(`\n${patch}\n`));
    expect(buildPatchCacheKey(patch, 'workspace:light')).not.toBe(buildPatchCacheKey(patch, 'workspace:dark'));
  });

  it('resolves Pierre theme names like T3', () => {
    expect(resolveCodeAgentDiffThemeName('light')).toBe('pierre-light');
    expect(resolveCodeAgentDiffThemeName('dark')).toBe('pierre-dark');
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
    expect(getDiffCollapseIconClassName({ type: 'unknown' } as any)).toBe('text-[#87867f] dark:text-[#8f8d86]');
  });
});
