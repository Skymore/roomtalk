import React from 'react';
import { ChevronRight, Folder, FolderClosed } from 'lucide-react';
import {
  buildCodeAgentChangedFileTree,
  collectChangedFileDirectoryPaths,
  type CodeAgentChangedFile,
  type CodeAgentChangedFileTreeNode,
} from '../utils/codeAgentChangedFileTree';
import { CodeAgentDiffStatLabel, hasNonZeroChangedFileStat } from './CodeAgentDiffStatLabel';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

interface CodeAgentChangedFilesTreeProps {
  files: ReadonlyArray<CodeAgentChangedFile>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: 'light' | 'dark';
  selectedPath?: string | null;
  onOpenDiffFile: (path: string) => void;
}

export const CodeAgentChangedFilesTree: React.FC<CodeAgentChangedFilesTreeProps> = ({
  files,
  allDirectoriesExpanded,
  resolvedTheme,
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
            data-scroll-anchor-ignore
            className="group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#30302e]"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 shrink-0 text-[#87867f] transition-transform dark:text-[#8f8d86] ${isExpanded ? 'rotate-90' : ''}`}
            />
            {isExpanded ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            ) : (
              <FolderClosed className="h-3.5 w-3.5 shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
            )}
            <span className="truncate font-mono text-[11px] text-[#4d4c48] dark:text-[#e8e6dc]">
              {node.name}
            </span>
            {hasNonZeroChangedFileStat(node.stat) ? (
              <CodeAgentDiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} className="ml-auto shrink-0 text-[10px]" />
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
        <CodeAgentPierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="h-3.5 w-3.5 text-[#87867f] dark:text-[#8f8d86]"
        />
        <span className="truncate font-mono text-[11px]" title={node.path}>
          {node.name}
        </span>
        {node.stat ? (
          <CodeAgentDiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} className="ml-auto shrink-0 text-[10px]" />
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
