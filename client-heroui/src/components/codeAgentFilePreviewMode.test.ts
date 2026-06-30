import { describe, expect, it } from 'vitest';
import {
  isMarkdownPreviewFile,
  markdownTaskMarkerOffsets,
  setMarkdownTaskChecked,
} from './codeAgentFilePreviewMode';

describe('codeAgentFilePreviewMode', () => {
  it('matches T3 markdown preview file extensions', () => {
    expect(isMarkdownPreviewFile('README.md')).toBe(true);
    expect(isMarkdownPreviewFile('notes.mdx')).toBe(true);
    expect(isMarkdownPreviewFile('src/App.tsx')).toBe(false);
  });

  it('updates markdown task markers using T3 marker offsets', () => {
    const markdown = '- [ ] First\n- [x] Second\n';

    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe('- [x] First\n- [x] Second\n');
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe('- [ ] First\n- [ ] Second\n');
    expect(setMarkdownTaskChecked('1. [X] Ordered\n', 3, false)).toBe('1. [ ] Ordered\n');
  });

  it('ignores invalid task marker offsets', () => {
    const markdown = '- [ ] First\n';

    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });

  it('returns task marker offsets in render order', () => {
    expect(markdownTaskMarkerOffsets('- [ ] First\n  - [x] Nested\n1. [ ] Ordered\n')).toEqual([2, 16, 30]);
  });
});
