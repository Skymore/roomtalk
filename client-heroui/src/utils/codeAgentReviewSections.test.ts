import { describe, expect, it } from 'vitest';
import {
  CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
  CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
} from './codeAgentDiffPanelStore';
import { buildCodeAgentReviewSections } from './codeAgentReviewSections';

describe('codeAgentReviewSections', () => {
  it('builds branch-range and working-tree sections from the diff panel selection', () => {
    const sections = buildCodeAgentReviewSections({
      selection: {
        kind: 'branch',
        baseRef: 'origin/main',
        filePath: null,
        revealRequestId: 0,
      },
      diff: {
        available: true,
        patch: '',
        byteSize: 0,
        truncated: false,
        headRef: 'feature/workspace',
        baseRef: 'origin/main',
      },
      refs: {
        available: true,
        refs: [],
        headRef: 'feature/from-refs',
      },
      isDiffPending: true,
      isRefsPending: false,
    });

    expect(sections).toEqual([
      {
        id: CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
        kind: 'branch-range',
        scope: 'branch',
        selected: true,
        headRef: 'feature/workspace',
        baseRef: 'origin/main',
        isLoading: true,
      },
      {
        id: CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
        kind: 'working-tree',
        scope: 'unstaged',
        selected: false,
        headRef: null,
        baseRef: null,
        isLoading: false,
      },
    ]);
  });

  it('keeps loading state scoped to the selected section', () => {
    const sections = buildCodeAgentReviewSections({
      selection: {
        kind: 'unstaged',
        filePath: null,
        revealRequestId: 0,
      },
      diff: null,
      refs: null,
      isDiffPending: true,
      isRefsPending: true,
    });

    expect(sections.find((section) => section.id === CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID)?.isLoading).toBe(false);
    expect(sections.find((section) => section.id === CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID)?.isLoading).toBe(true);
    expect(sections.find((section) => section.id === CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID)?.selected).toBe(true);
  });
});
