import React from 'react';
import { Button, Chip, Tab, Tabs } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { formatUsdCost } from '../utils/formatters';
import {
  CodeAgentWorkspaceCommand,
  CodeAgentWorkspaceSnapshot,
  summarizeCocoMessages,
} from '../utils/cocoWorkspace';
import { Message, Room } from '../utils/types';
import { CodeAgentMode, getCodeAgentStatus } from '../utils/codeAgent';
import {
  getCocoAgentStatusClassName,
  getCocoStatusLabelKey,
  getSandboxStatusClassName,
  getSandboxStatusLabelKey,
} from '../utils/cocoRoom';
import { CodeAgentChangedFilesTree } from './CodeAgentChangedFilesTree';
import {
  CodeAgentWorkspaceDiffViewer,
  type CodeAgentWorkspaceDiffFileSummary,
} from './CodeAgentWorkspaceDiffViewer';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';

interface CodeAgentWorkspacePanelProps {
  room: Room;
  messages: Message[];
  mode: CodeAgentMode;
  sessionCostUsd: number;
  workspaceSnapshot?: CodeAgentWorkspaceSnapshot | null;
  isRefreshingWorkspace?: boolean;
  workspaceRefreshError?: string | null;
  onRefreshWorkspace?: () => void;
  onOpenWorkspaceFile?: (path: string) => void;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

const workspaceSurfaceClassName = 'rounded-xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const EMPTY_CHANGED_FILES: string[] = [];
const EMPTY_DIFF_FILE_STATS = new Map<string, { additions: number; deletions: number }>();

function normalizeChangedFilePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

const commandStatusIcon: Record<CodeAgentWorkspaceCommand['status'], string> = {
  started: 'lucide:loader',
  succeeded: 'lucide:check',
  failed: 'lucide:circle-alert',
};

const commandStatusClassName: Record<CodeAgentWorkspaceCommand['status'], string> = {
  started: 'text-[#7a5a18] dark:text-[#ffd166]',
  succeeded: 'text-[#2f6f4e] dark:text-[#65d08a]',
  failed: 'text-[#9f462c] dark:text-[#ff9b78]',
};

const commandStatusLabelKey: Record<CodeAgentWorkspaceCommand['status'], string> = {
  started: 'codeAgentCommandStarted',
  succeeded: 'codeAgentCommandSucceeded',
  failed: 'codeAgentCommandFailed',
};

export const CodeAgentWorkspacePanel: React.FC<CodeAgentWorkspacePanelProps> = ({
  room,
  messages,
  mode,
  sessionCostUsd,
  workspaceSnapshot,
  isRefreshingWorkspace = false,
  workspaceRefreshError,
  onRefreshWorkspace,
  onOpenWorkspaceFile,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
}) => {
  const { t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [selectedWorkspaceTab, setSelectedWorkspaceTab] = React.useState('overview');
  const [allChangedDirectoriesExpanded, setAllChangedDirectoriesExpanded] = React.useState(true);
  const [selectedDiffFile, setSelectedDiffFile] = React.useState<{ path: string; requestId: number } | null>(null);
  const [diffFileStats, setDiffFileStats] = React.useState<{
    scopeKey: string;
    byPath: Map<string, { additions: number; deletions: number }>;
  }>(() => ({ scopeKey: '', byPath: EMPTY_DIFF_FILE_STATS }));
  const selectedDiffFileRequestIdRef = React.useRef(0);
  const messageSummary = React.useMemo(() => summarizeCocoMessages(messages), [messages]);
  const summary = React.useMemo(
    () => {
      if (!workspaceSnapshot?.summary) {
        return messageSummary;
      }
      return {
        toolCalls: Math.max(messageSummary.toolCalls, workspaceSnapshot.summary.toolCalls),
        toolResults: Math.max(messageSummary.toolResults, workspaceSnapshot.summary.toolResults),
        toolErrors: Math.max(messageSummary.toolErrors, workspaceSnapshot.summary.toolErrors),
        lastToolName: messageSummary.lastToolName || workspaceSnapshot.summary.lastToolName,
      };
    },
    [messageSummary, workspaceSnapshot?.summary]
  );
  const recentCommands = React.useMemo(
    () => (workspaceSnapshot?.commands || []).slice(-5).reverse(),
    [workspaceSnapshot?.commands]
  );
  const publishedArtifacts = workspaceSnapshot?.artifacts || [];
  const workspaceChanges = workspaceSnapshot?.changes;
  const changedFiles = workspaceChanges?.changedFiles ?? EMPTY_CHANGED_FILES;
  const diffRefreshKey = workspaceSnapshot?.generatedAt || changedFiles.join('\n');
  const activeDiffFileStats = diffFileStats.scopeKey === diffRefreshKey
    ? diffFileStats.byPath
    : EMPTY_DIFF_FILE_STATS;
  const changedFileEntries = React.useMemo(
    () => changedFiles.map((path) => {
      const normalizedPath = normalizeChangedFilePath(path);
      const stat = activeDiffFileStats.get(normalizedPath);
      return stat
        ? { path: normalizedPath, additions: stat.additions, deletions: stat.deletions }
        : { path: normalizedPath };
    }),
    [activeDiffFileStats, changedFiles],
  );
  const normalizedChangedFilePathSet = React.useMemo(
    () => new Set(changedFileEntries.map((entry) => normalizeChangedFilePath(entry.path))),
    [changedFileEntries],
  );
  const hasChangedFileDirectories = React.useMemo(
    () => changedFiles.some((path) => path.replace(/\\/g, '/').includes('/')),
    [changedFiles],
  );
  const diffSummary = workspaceChanges?.diffSummary || null;
  const isPlanMode = mode === 'plan';
  const agentStatus = getCodeAgentStatus(room);
  const detailsId = 'code-agent-workspace-details';
  const shouldLoadDiff = selectedWorkspaceTab === 'changes' && Boolean(workspaceChanges?.available && changedFiles.length > 0);

  React.useEffect(() => {
    if (selectedDiffFile && !normalizedChangedFilePathSet.has(selectedDiffFile.path)) {
      setSelectedDiffFile(null);
    }
  }, [normalizedChangedFilePathSet, selectedDiffFile]);

  const handleOpenDiffFile = React.useCallback((path: string) => {
    const normalizedPath = normalizeChangedFilePath(path);
    selectedDiffFileRequestIdRef.current += 1;
    setSelectedDiffFile({
      path: normalizedPath,
      requestId: selectedDiffFileRequestIdRef.current,
    });
  }, []);

  const handleDiffFileSummariesChange = React.useCallback((summaries: readonly CodeAgentWorkspaceDiffFileSummary[]) => {
    setDiffFileStats({
      scopeKey: diffRefreshKey,
      byPath: new Map(summaries.map((summary) => [
        normalizeChangedFilePath(summary.path),
        { additions: summary.additions, deletions: summary.deletions },
      ])),
    });
  }, [diffRefreshKey]);

  const stats = [
    { label: t('codeAgentTools'), value: summary.toolCalls, icon: 'lucide:wrench' },
    { label: t('codeAgentResults'), value: summary.toolResults, icon: 'lucide:list-checks' },
    { label: t('codeAgentErrors'), value: summary.toolErrors, icon: 'lucide:circle-alert' },
  ];

  return (
    <section
      data-testid="code-agent-workspace"
      className="sticky top-0 z-30 flex-shrink-0 border-b border-[#dedbd0] bg-[#f5f4ed]/95 px-3 pb-3 pt-3 shadow-[0_1px_0_rgba(20,20,19,0.04)] backdrop-blur dark:border-[#30302e] dark:bg-[#141413]/95 dark:shadow-[0_1px_0_rgba(250,249,245,0.04)]"
      aria-label={t('codeAgentWorkspace')}
    >
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold uppercase tracking-normal text-[#5e5d59] dark:text-[#b0aea5]">
              {t('codeAgentWorkspace')}
            </h3>
            <Chip
              size="sm"
              variant="flat"
              startContent={<Icon icon={isPlanMode ? 'lucide:eye' : 'lucide:pencil-ruler'} className="h-3 w-3" />}
              classNames={{
                base: 'h-6 border border-[#dedbd0] bg-[#faf9f5] px-1.5 text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]',
                content: 'px-0 text-[11px] font-semibold',
              }}
            >
              {isPlanMode ? t('codeAgentReadOnlyMode') : t('codeAgentEditMode')}
            </Chip>
            {onRefreshWorkspace && (
              <Button
                size="sm"
                variant="flat"
                radius="full"
                isLoading={isRefreshingWorkspace}
                aria-label={t('codeAgentRefreshWorkspace')}
                title={t('codeAgentRefreshWorkspace')}
                data-testid="code-agent-refresh-workspace"
                className="h-6 min-w-0 gap-1 border border-[#dedbd0] bg-[#faf9f5] px-2 text-[11px] font-semibold text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]"
                onPress={onRefreshWorkspace}
              >
                <Icon icon="lucide:refresh-cw" className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t('codeAgentRefreshWorkspace')}</span>
              </Button>
            )}
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              radius="full"
              aria-controls={detailsId}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? t('showMore') : t('showLess')}
              data-testid="code-agent-workspace-toggle"
              className="h-6 w-6 min-w-6 cursor-pointer border border-[#dedbd0] bg-[#faf9f5] text-[#4d4c48] transition-colors dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]"
              onPress={() => setIsCollapsed((collapsed) => !collapsed)}
            >
              <Icon icon={isCollapsed ? 'lucide:chevron-down' : 'lucide:chevron-up'} className="h-3.5 w-3.5" />
            </Button>
          </div>
          {!isCollapsed && (
            <p className="mt-1 max-w-3xl text-xs leading-5 text-[#5e5d59] dark:text-[#b0aea5]">
              {isPlanMode ? t('codeAgentReadOnlyDescription') : t('codeAgentEditDescription')}
            </p>
          )}
          {workspaceRefreshError && (
            <p
              role="alert"
              className={`${isCollapsed ? 'mt-0.5' : 'mt-1'} text-xs font-medium text-[#9f462c] dark:text-[#ff9b78]`}
            >
              {t('codeAgentWorkspaceRefreshFailed')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex max-w-[150px] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getSandboxStatusClassName(room.sandboxStatus)}`}>
            <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t(getSandboxStatusLabelKey(room.sandboxStatus))}</span>
          </span>
          <span className={`inline-flex max-w-[150px] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getCocoAgentStatusClassName(agentStatus)}`}>
            <Icon icon="lucide:bot" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t(getCocoStatusLabelKey(agentStatus))}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-[11px] font-medium text-[#4d4c48] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#e8e6dc]">
            <Icon icon="lucide:coins" className="h-3 w-3" />
            {t('sessionCost')}: {formatUsdCost(sessionCostUsd)}
          </span>
        </div>
      </div>

      <div
        id={detailsId}
        data-testid="code-agent-workspace-details"
        hidden={isCollapsed}
        className={`mt-3 ${workspaceSurfaceClassName}`}
      >
        <Tabs
          aria-label={t('codeAgentWorkspace')}
          selectedKey={selectedWorkspaceTab}
          onSelectionChange={(key) => setSelectedWorkspaceTab(String(key))}
          size="sm"
          variant="underlined"
          classNames={{
            base: 'w-full border-b border-[#dedbd0] px-2 dark:border-[#30302e]',
            tabList: 'gap-2',
            cursor: 'bg-[#d66a43]',
            tab: 'h-9 px-2 text-xs font-semibold',
            tabContent: 'text-[#5e5d59] group-data-[selected=true]:text-[#141413] dark:text-[#b0aea5] dark:group-data-[selected=true]:text-[#faf9f5]',
            panel: 'p-0',
          }}
        >
          <Tab
            key="overview"
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon icon="lucide:gauge" className="h-3.5 w-3.5" />
                {t('codeAgentOverview')}
              </span>
            }
          >
            <div className="grid divide-y divide-[#dedbd0] dark:divide-[#30302e] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {stats.map((item) => (
                <div key={item.label} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2 text-xs text-[#87867f] dark:text-[#b0aea5]">
                    <Icon icon={item.icon} className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </div>
                  <span className="font-mono text-sm font-semibold tabular-nums text-[#141413] dark:text-[#faf9f5]">{item.value}</span>
                </div>
              ))}
            </div>
          </Tab>

          <Tab
            key="artifacts"
            title={
              <span
                className={`inline-flex items-center gap-1.5 ${publishedArtifacts.length > 0 ? 'text-[#c96442] dark:text-[#ff9b78]' : ''}`}
              >
                <Icon icon="lucide:package-open" className="h-3.5 w-3.5" />
                {t('codeAgentArtifacts')}
                {publishedArtifacts.length > 0 ? (
                  <span className="rounded-full bg-[#d66a43] px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-white">
                    {publishedArtifacts.length}
                  </span>
                ) : null}
              </span>
            }
          >
            <div className="max-h-44 overflow-y-auto px-3 py-2">
              {publishedArtifacts.length === 0 ? (
                <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoArtifacts')}</p>
              ) : (
                <div className="space-y-1.5">
                  {publishedArtifacts.map((artifact) => (
                    <a
                      key={artifact.slug}
                      href={artifact.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[#ead6cc] bg-[#fff7f2] px-2.5 py-2 text-xs text-[#4d4c48] transition-colors hover:border-[#d66a43] hover:text-[#9f462c] dark:border-[#4a3027] dark:bg-[#2a211d] dark:text-[#e8e6dc] dark:hover:border-[#ff9b78] dark:hover:text-[#ffb69e]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Icon icon="lucide:globe-2" className="h-3.5 w-3.5 flex-shrink-0 text-[#c96442] dark:text-[#ff9b78]" />
                        <span className="truncate font-semibold">{artifact.title || artifact.slug}</span>
                      </span>
                      <Icon icon="lucide:external-link" className="h-3.5 w-3.5 flex-shrink-0" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </Tab>

          <Tab
            key="activity"
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon icon="lucide:activity" className="h-3.5 w-3.5" />
                {t('codeAgentActivity')}
              </span>
            }
          >
            <div className="max-h-44 overflow-y-auto px-2 py-2">
              {summary.lastToolName ? (
                <p className="mb-2 truncate px-1 text-xs text-[#4d4c48] dark:text-[#e8e6dc]">
                  {t('codeAgentLatestTool')}: <span className="font-mono">{summary.lastToolName}</span>
                </p>
              ) : null}
              {recentCommands.length > 0 ? (
                <div className="space-y-1">
                  {recentCommands.map(command => (
                    <div
                      key={command.id}
                      data-testid="code-agent-command-row"
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-2 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5 font-semibold text-[#4d4c48] dark:text-[#e8e6dc]">
                          <Icon
                            icon={commandStatusIcon[command.status]}
                            className={`h-3.5 w-3.5 flex-shrink-0 ${commandStatusClassName[command.status]} ${command.status === 'started' ? 'animate-spin' : ''}`}
                          />
                          <span className="truncate">{command.name}</span>
                        </div>
                        {command.preview && (
                          <p className="mt-0.5 truncate font-mono text-[10px] text-[#87867f] dark:text-[#8f8d86]" title={command.preview}>
                            {command.preview}
                          </p>
                        )}
                      </div>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${commandStatusClassName[command.status]}`}>
                        {t(commandStatusLabelKey[command.status])}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-1 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoActivity')}</p>
              )}
            </div>
          </Tab>

          <Tab
            key="changes"
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon icon="lucide:git-compare-arrows" className="h-3.5 w-3.5" />
                {t('codeAgentChanges')}
              </span>
            }
          >
            <div className="flex max-h-[min(72vh,42rem)] min-h-0 flex-col overflow-y-auto px-3 py-2">
              {!workspaceChanges?.available ? (
                <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentChangesUnavailable')}</p>
              ) : changedFiles.length === 0 ? (
                <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoWorkspaceChanges')}</p>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#4d4c48] dark:text-[#e8e6dc]">
                    <span className="font-semibold">{t('codeAgentChangedFilesCount', { count: changedFiles.length })}</span>
                    {diffSummary ? (
                      <span className="font-mono text-[11px] text-[#87867f] dark:text-[#8f8d86]">
                        +{diffSummary.additions} -{diffSummary.deletions}
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {hasChangedFileDirectories ? (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="rounded-md border border-[#dedbd0] px-2 py-1 text-[11px] font-semibold text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]"
                          onClick={() => setAllChangedDirectoriesExpanded((expanded) => !expanded)}
                        >
                          {allChangedDirectoriesExpanded ? t('codeAgentCollapseChangedFileTree') : t('codeAgentExpandChangedFileTree')}
                        </button>
                      </div>
                    ) : null}
                    <CodeAgentChangedFilesTree
                      files={changedFileEntries}
                      allDirectoriesExpanded={allChangedDirectoriesExpanded}
                      selectedPath={selectedDiffFile?.path}
                      onOpenDiffFile={handleOpenDiffFile}
                    />
                  </div>
                  <CodeAgentWorkspaceDiffViewer
                    roomId={room.id}
                    enabled={shouldLoadDiff}
                    refreshKey={diffRefreshKey}
                    onOpenFile={onOpenWorkspaceFile}
                    onFileSummariesChange={handleDiffFileSummariesChange}
                    selectedFilePath={selectedDiffFile?.path}
                    selectedFileRevealRequestId={selectedDiffFile?.requestId}
                    reviewComments={reviewComments}
                    onAddReviewComment={onAddReviewComment}
                    onRemoveReviewComment={onRemoveReviewComment}
                  />
                </div>
              )}
            </div>
          </Tab>
        </Tabs>
      </div>
    </section>
  );
};
