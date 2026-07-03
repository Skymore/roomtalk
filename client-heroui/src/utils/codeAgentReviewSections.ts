import type { CodeAgentWorkspaceDiff, CodeAgentWorkspaceDiffScope, CodeAgentWorkspaceRefs } from './cocoWorkspace';
import {
  CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
  CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
  getCodeAgentDiffReviewSectionId,
  type CodeAgentDiffPanelSelection,
  type CodeAgentDiffReviewSectionId,
} from './codeAgentDiffPanelStore';

export type CodeAgentReviewSectionKind = 'branch-range' | 'working-tree';

export interface CodeAgentReviewSectionItem {
  id: CodeAgentDiffReviewSectionId;
  kind: CodeAgentReviewSectionKind;
  scope: CodeAgentWorkspaceDiffScope;
  selected: boolean;
  headRef: string | null;
  baseRef: string | null;
  isLoading: boolean;
}

export function buildCodeAgentReviewSections(input: {
  selection: CodeAgentDiffPanelSelection;
  diff: CodeAgentWorkspaceDiff | null;
  refs: CodeAgentWorkspaceRefs | null;
  isDiffPending: boolean;
  isRefsPending: boolean;
}): readonly CodeAgentReviewSectionItem[] {
  const selectedSectionId = getCodeAgentDiffReviewSectionId(input.selection);
  const selectedBranchBaseRef = input.selection.kind === 'branch' ? input.selection.baseRef : null;
  const branchSection: CodeAgentReviewSectionItem = {
    id: CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
    kind: 'branch-range',
    scope: 'branch',
    selected: selectedSectionId === CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID,
    headRef: input.diff?.headRef ?? input.refs?.headRef ?? null,
    baseRef: input.diff?.baseRef ?? selectedBranchBaseRef,
    isLoading: selectedSectionId === CODE_AGENT_BRANCH_RANGE_REVIEW_SECTION_ID
      ? input.isDiffPending || input.isRefsPending
      : false,
  };
  const workingTreeSection: CodeAgentReviewSectionItem = {
    id: CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
    kind: 'working-tree',
    scope: 'unstaged',
    selected: selectedSectionId === CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID,
    headRef: null,
    baseRef: null,
    isLoading: selectedSectionId === CODE_AGENT_WORKING_TREE_REVIEW_SECTION_ID
      ? input.isDiffPending
      : false,
  };

  return [branchSection, workingTreeSection];
}
