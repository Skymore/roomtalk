// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
  CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
  clearCodeAgentDiffFile,
  getCodeAgentDiffReviewSectionId,
  getCodeAgentDiffScopeForReviewSectionId,
  readCodeAgentDiffPanelSelection,
  resetCodeAgentDiffPanelStoreForTests,
  selectCodeAgentDiffBranchBaseRef,
  selectCodeAgentDiffFile,
  selectCodeAgentDiffReviewSection,
  selectCodeAgentDiffScope,
} from './codeAgentDiffPanelStore';

describe('codeAgentDiffPanelStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCodeAgentDiffPanelStoreForTests();
  });

  afterEach(() => {
    localStorage.clear();
    resetCodeAgentDiffPanelStoreForTests();
  });

  it('defaults each room to branch changes with automatic base selection', () => {
    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: null,
      filePath: null,
      revealRequestId: 0,
    });
  });

  it('clears incompatible file selection fields when changing diff scopes', () => {
    selectCodeAgentDiffFile('room-1', 'src/app.ts');
    selectCodeAgentDiffScope('room-1', 'unstaged');

    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'unstaged',
      filePath: null,
      revealRequestId: 0,
    });

    selectCodeAgentDiffBranchBaseRef('room-1', ' origin/main ');
    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: 'origin/main',
      filePath: null,
      revealRequestId: 0,
    });
  });

  it('increments the reveal request when opening the same diff file again', () => {
    selectCodeAgentDiffFile('room-1', 'src/app.ts');
    selectCodeAgentDiffFile('room-1', 'src/app.ts');

    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: null,
      filePath: 'src/app.ts',
      revealRequestId: 2,
    });
  });

  it('restores the selected branch base after visiting another scope', () => {
    selectCodeAgentDiffBranchBaseRef('room-1', 'origin/main');
    selectCodeAgentDiffScope('room-1', 'unstaged');
    selectCodeAgentDiffScope('room-1', 'branch');

    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: 'origin/main',
      filePath: null,
      revealRequestId: 0,
    });
  });

  it('maps review section selection onto the existing diff scope state', () => {
    selectCodeAgentDiffBranchBaseRef('room-1', 'origin/main');

    expect(getCodeAgentDiffScopeForReviewSectionId(CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID)).toBe('branch');
    expect(getCodeAgentDiffScopeForReviewSectionId(CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID)).toBe('unstaged');

    selectCodeAgentDiffReviewSection('room-1', CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID);

    const workingTreeSelection = readCodeAgentDiffPanelSelection('room-1');
    expect(workingTreeSelection).toEqual({
      kind: 'unstaged',
      filePath: null,
      revealRequestId: 0,
    });
    expect(getCodeAgentDiffReviewSectionId(workingTreeSelection)).toBe(CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID);

    selectCodeAgentDiffReviewSection('room-1', CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID);

    const branchSelection = readCodeAgentDiffPanelSelection('room-1');
    expect(branchSelection).toEqual({
      kind: 'branch',
      baseRef: 'origin/main',
      filePath: null,
      revealRequestId: 0,
    });
    expect(getCodeAgentDiffReviewSectionId(branchSelection)).toBe(CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID);
  });

  it('clears selected file without changing the current diff scope', () => {
    selectCodeAgentDiffScope('room-1', 'unstaged');
    selectCodeAgentDiffFile('room-1', 'src/app.ts');
    clearCodeAgentDiffFile('room-1');

    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'unstaged',
      filePath: null,
      revealRequestId: 1,
    });
  });

  it('migrates legacy diff scope and room base ref storage into the panel store', () => {
    localStorage.setItem('roomtalk.codeWorkspace.diffScope', 'branch');
    localStorage.setItem('roomtalk.codeWorkspace.diffBaseRef.room-1', ' main ');
    resetCodeAgentDiffPanelStoreForTests();

    expect(readCodeAgentDiffPanelSelection('room-1')).toEqual({
      kind: 'branch',
      baseRef: 'main',
      filePath: null,
      revealRequestId: 0,
    });
    expect(localStorage.getItem('roomtalk.codeWorkspace.diffPanelState.v1')).toContain('"room-1"');
  });
});
