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

function ancestorPaths(pathValue: string): string[] {
  const parts = pathValue.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join('/'));
  }
  return ancestors;
}

interface CodeAgentChangedFilesTreeProps {
  files: ReadonlyArray<CodeAgentChangedFile>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: 'light' | 'dark';
  selectedPath?: string | null;
  onOpenDiffFile: (path: string) => void;
  mobileLayout?: boolean;
}

export const CodeAgentChangedFilesTree: React.FC<CodeAgentChangedFilesTreeProps> = ({
  files,
  allDirectoriesExpanded,
  resolvedTheme,
  selectedPath = null,
  onOpenDiffFile,
  mobileLayout = false,
}) => {
  const treeNodes = React.useMemo(() => buildCodeAgentChangedFileTree(files), [files]);
  const directoryPathsKey = React.useMemo(
    () => collectChangedFileDirectoryPaths(treeNodes).join('\u0000'),
    [treeNodes],
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);
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

  React.useEffect(() => {
    if (!selectedPath) {
      return;
    }

    setDirectoryExpansionState((current) => {
      const nextOverrides = current.key === expansionStateKey ? { ...current.overrides } : {};
      let changed = current.key !== expansionStateKey;
      for (const ancestor of ancestorPaths(selectedPath)) {
        if (nextOverrides[ancestor] !== true) {
          nextOverrides[ancestor] = true;
          changed = true;
        }
      }
      return changed ? { key: expansionStateKey, overrides: nextOverrides } : current;
    });
  }, [expansionStateKey, selectedPath]);

  React.useEffect(() => {
    if (!selectedPath || typeof window === 'undefined') {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>('[data-code-agent-changed-file-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [directoryExpansionState, selectedPath]);

  const renderTreeNode = (node: CodeAgentChangedFileTreeNode, depth: number): React.ReactNode => {
    const leftPadding = mobileLayout ? 8 + depth * 18 : 8 + depth * 14;
    if (node.kind === 'directory') {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            data-testid="code-agent-changed-files-tree-row"
            data-kind="directory"
            data-path={node.path}
            data-mobile-layout={mobileLayout ? 'true' : undefined}
            className={mobileLayout
              ? 'group mx-2 flex min-h-[42px] w-[calc(100%-1rem)] min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] active:bg-[#ebe8dc] dark:hover:bg-[#30302e] dark:active:bg-[#30302e]'
              : 'group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors hover:bg-[#f0eee6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] dark:hover:bg-[#30302e]'}
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRight
              className={`${mobileLayout ? 'h-4 w-4' : 'h-3.5 w-3.5'} shrink-0 text-[#5e5d59] transition-transform dark:text-[#8f8d86] ${isExpanded ? 'rotate-90' : ''}`}
            />
            {mobileLayout ? (
              <CodeAgentPierreEntryIcon
                pathValue={node.path}
                kind="directory"
                theme={resolvedTheme}
                className="size-4 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]"
              />
            ) : isExpanded ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            ) : (
              <FolderClosed className="h-3.5 w-3.5 shrink-0 text-[#5e5d59] dark:text-[#8f8d86]" />
            )}
            <span className={`${mobileLayout ? 'text-sm font-medium leading-[19px]' : 'font-mono text-[11px]'} min-w-0 flex-1 truncate text-[#4d4c48] dark:text-[#e8e6dc]`}>
              {node.name}
            </span>
            {mobileLayout ? (
              <span className="shrink-0 font-mono text-[10px] font-medium text-[#5e5d59] dark:text-[#8f8d86]">
                {node.children.length}
              </span>
            ) : null}
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
        aria-current={isSelected ? 'true' : undefined}
        data-code-agent-changed-file-selected={isSelected ? 'true' : undefined}
        data-testid="code-agent-changed-files-tree-row"
        data-kind="file"
        data-path={node.path}
        data-mobile-layout={mobileLayout ? 'true' : undefined}
        className={`group flex min-w-0 items-center rounded-lg text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c96442] ${
          mobileLayout
            ? 'mx-2 min-h-[42px] w-[calc(100%-1rem)] gap-2 px-2 active:bg-[#ebe8dc] dark:active:bg-[#30302e]'
            : 'w-full gap-1.5 py-1 pr-2'
        } ${
          isSelected
            ? 'bg-[#fff2ec] text-[#9f462c] dark:bg-[#2a211d] dark:text-[#ffb197]'
            : 'text-[#4d4c48] hover:bg-[#f0eee6] dark:text-[#e8e6dc] dark:hover:bg-[#30302e]'
        }`}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenDiffFile(node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className={`${mobileLayout ? 'h-4 w-4' : 'h-3.5 w-3.5'} shrink-0`} />
        ) : null}
        <CodeAgentPierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className={`${mobileLayout ? 'size-4' : 'h-3.5 w-3.5'} shrink-0 text-[#5e5d59] dark:text-[#8f8d86]`}
        />
        <span className={`${mobileLayout ? 'text-sm font-medium leading-[19px]' : 'font-mono text-[11px]'} min-w-0 flex-1 truncate`} title={node.path}>
          {node.name}
        </span>
        {node.stat ? (
          <CodeAgentDiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} className="ml-auto shrink-0 text-[10px]" />
        ) : null}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={mobileLayout ? 'space-y-1 py-1' : 'space-y-0.5'}
      data-testid="code-agent-changed-files-tree"
      data-mobile-layout={mobileLayout ? 'true' : undefined}
    >
      {treeNodes.map((node) => renderTreeNode(node, 0))}
    </div>
  );
};
