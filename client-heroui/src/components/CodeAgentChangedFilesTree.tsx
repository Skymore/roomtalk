import React from 'react';
import { Icon } from '@iconify/react';
import {
  buildCodeAgentChangedFileTree,
  collectChangedFileDirectoryPaths,
  formatCompactDiffCount,
  hasNonZeroChangedFileStat,
  type CodeAgentChangedFile,
  type CodeAgentChangedFileStat,
  type CodeAgentChangedFileTreeNode,
} from '../utils/codeAgentChangedFileTree';

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

function DiffStatLabel({
  additions,
  deletions,
  className = '',
}: CodeAgentChangedFileStat & { className?: string }) {
  return (
    <span className={`inline-grid grid-cols-[4ch_4ch] gap-1 text-right tabular-nums ${className}`}>
      <span className="font-mono text-[#2f6f4e] dark:text-[#65d08a]">+{formatCompactDiffCount(additions)}</span>
      <span className="font-mono text-[#9f462c] dark:text-[#ff9b78]">-{formatCompactDiffCount(deletions)}</span>
    </span>
  );
}

interface CodeAgentChangedFilesTreeProps {
  files: ReadonlyArray<CodeAgentChangedFile>;
  allDirectoriesExpanded: boolean;
  selectedPath?: string | null;
  onOpenDiffFile: (path: string) => void;
}

export const CodeAgentChangedFilesTree: React.FC<CodeAgentChangedFilesTreeProps> = ({
  files,
  allDirectoriesExpanded,
  selectedPath = null,
  onOpenDiffFile,
}) => {
  const treeNodes = React.useMemo(() => buildCodeAgentChangedFileTree(files), [files]);
  const directoryPathsKey = React.useMemo(
    () => collectChangedFileDirectoryPaths(treeNodes).join('\u0000'),
    [treeNodes],
  );
  const expansionStateKey = `${allDirectoriesExpanded ? 'expanded' : 'collapsed'}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = React.useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories = directoryExpansionState.key === expansionStateKey
    ? directoryExpansionState.overrides
    : EMPTY_DIRECTORY_OVERRIDES;
  const hasDirectoryNodes = directoryPathsKey.length > 0;

  const toggleDirectory = React.useCallback((path: string) => {
    setDirectoryExpansionState((current) => {
      const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
      return {
        key: expansionStateKey,
        overrides: {
          ...nextOverrides,
          [path]: !(nextOverrides[path] ?? allDirectoriesExpanded),
        },
      };
    });
  }, [allDirectoriesExpanded, expansionStateKey]);

  const renderTreeNode = (node: CodeAgentChangedFileTreeNode, depth: number): React.ReactNode => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === 'directory') {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            className="group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#30302e]"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <Icon
              icon="lucide:chevron-right"
              className={`h-3.5 w-3.5 shrink-0 text-[#87867f] transition-transform dark:text-[#8f8d86] ${isExpanded ? 'rotate-90' : ''}`}
            />
            <Icon
              icon={isExpanded ? 'lucide:folder-open' : 'lucide:folder'}
              className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]"
            />
            <span className="truncate font-mono text-[11px] text-[#4d4c48] dark:text-[#e8e6dc]">
              {node.name}
            </span>
            {hasNonZeroChangedFileStat(node.stat) ? (
              <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} className="ml-auto shrink-0 text-[10px]" />
            ) : null}
          </button>
          {isExpanded ? (
            <div className="space-y-0.5">
              {node.children.map((child) => renderTreeNode(child, depth + 1))}
            </div>
          ) : null}
        </div>
      );
    }

    const isSelected = selectedPath === node.path;
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className={`group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
          isSelected
            ? 'bg-[#fff2ec] text-[#9f462c] dark:bg-[#2a211d] dark:text-[#ffb197]'
            : 'text-[#4d4c48] hover:bg-[#f0eee6] dark:text-[#e8e6dc] dark:hover:bg-[#30302e]'
        }`}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenDiffFile(node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        ) : null}
        <Icon icon="lucide:file-code-2" className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
        <span className="truncate font-mono text-[11px]" title={node.path}>
          {node.name}
        </span>
        {node.stat ? (
          <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} className="ml-auto shrink-0 text-[10px]" />
        ) : null}
      </button>
    );
  };

  return (
    <div className="space-y-0.5" data-testid="code-agent-changed-files-tree">
      {treeNodes.map((node) => renderTreeNode(node, 0))}
    </div>
  );
};
