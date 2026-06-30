import { describe, expect, it } from 'vitest';
import { buildPatchCacheKey, getRenderablePatch, resolveCodeAgentDiffThemeName } from './codeAgentDiffRendering';

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
});
