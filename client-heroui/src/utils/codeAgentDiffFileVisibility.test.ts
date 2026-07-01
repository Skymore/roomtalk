import { describe, expect, it } from 'vitest';
import {
  getCodeAgentDiffCollapsedFileKeys,
  getDefaultCodeAgentDiffExpandedFileKeys,
  getValidCodeAgentDiffFileKeys,
  getValidExplicitCodeAgentDiffFileKeys,
  removeCodeAgentDiffFileKey,
  toggleCodeAgentDiffFileKey,
  type CodeAgentDiffVisibilityFile,
} from './codeAgentDiffFileVisibility';

function makeFile(id: string): CodeAgentDiffVisibilityFile {
  return { id };
}

describe('codeAgentDiffFileVisibility', () => {
  const files = [makeFile('a.ts'), makeFile('b.ts')];

  it('defaults expanded files to every renderable file like T3', () => {
    expect(getDefaultCodeAgentDiffExpandedFileKeys(files)).toEqual(['a.ts', 'b.ts']);
    expect(getValidCodeAgentDiffFileKeys(files, undefined)).toEqual(['a.ts', 'b.ts']);
    expect(getCodeAgentDiffCollapsedFileKeys(files, undefined)).toEqual([]);
  });

  it('filters stale cached file keys', () => {
    expect(getValidCodeAgentDiffFileKeys(files, ['missing.ts', 'b.ts'])).toEqual(['b.ts']);
    expect(getValidExplicitCodeAgentDiffFileKeys(files, undefined)).toEqual([]);
    expect(getValidExplicitCodeAgentDiffFileKeys(files, ['a.ts', 'missing.ts'])).toEqual(['a.ts']);
    expect(getCodeAgentDiffCollapsedFileKeys(files, ['missing.ts', 'b.ts'])).toEqual(['a.ts']);
  });

  it('toggles and removes file keys without mutating the original array', () => {
    const original = ['a.ts'];

    expect(toggleCodeAgentDiffFileKey(original, 'b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(toggleCodeAgentDiffFileKey(original, 'a.ts')).toEqual([]);
    expect(removeCodeAgentDiffFileKey(original, 'a.ts')).toEqual([]);
    expect(original).toEqual(['a.ts']);
  });
});
