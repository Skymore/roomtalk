import React from 'react';
import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Tab, Tabs } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { formatUsdCost } from '../utils/formatters';
import {
  CodeAgentWorkspaceCommand,
  CodeAgentWorkspaceSnapshot,
  summarizeCodeAgentMessages,
} from '../utils/codeAgentWorkspace';
import { Message, Room } from '../utils/types';
import {
  CODE_AGENT_BACKEND_OPTIONS,
  CodeAgentBackend,
  CodeAgentMode,
  getCodeAgentBackendLabelKey,
  getCodeAgentModeDescriptionKey,
  getCodeAgentModeIcon,
  getCodeAgentModeLabelKey,
  getCodeAgentStatus,
  normalizeCodeAgentMode,
  normalizeCodeAgentModeList,
} from '../utils/codeAgent';
import {
  getCodeAgentStatusClassName,
  getCodeAgentStatusLabelKey,
  getSandboxStatusClassName,
  getSandboxStatusLabelKey,
} from '../utils/codeAgentRoom';
import { CodeAgentChangedFilesTree } from './CodeAgentChangedFilesTree';
import { CodeAgentDiffStatLabel, hasNonZeroChangedFileStat } from './CodeAgentDiffStatLabel';
import {
  CodeAgentWorkspaceDiffViewer,
  type CodeAgentWorkspaceDiffFileSummary,
} from './CodeAgentWorkspaceDiffViewer';
import type { ReviewCommentContext } from '../utils/codeAgentReviewComments';
import {
  clearCodeAgentDiffFile,
  selectCodeAgentDiffFile,
  useCodeAgentDiffPanelSelection,
} from '../utils/codeAgentDiffPanelStore';
import { summarizeCodeAgentChangedFileStats } from '../utils/codeAgentChangedFileTree';
import {
  setCodeAgentChangedFilesExpanded,
  useCodeAgentChangedFilesExpanded,
} from '../utils/codeAgentChangedFilesExpansionStore';
import { requestCodexThread, requestCodexThreads } from '../utils/socket';

interface CodeAgentWorkspacePanelProps {
  room: Room;
  messages: Message[];
  mode: CodeAgentMode;
  availableModes?: CodeAgentMode[];
  backend?: CodeAgentBackend;
  canSwitchMode?: boolean;
  canSwitchBackend?: boolean;
  onModeChange?: (mode: CodeAgentMode) => void;
  onBackendChange?: (backend: CodeAgentBackend) => void;
  sessionCostUsd: number;
  workspaceSnapshot?: CodeAgentWorkspaceSnapshot | null;
  isRefreshingWorkspace?: boolean;
  workspaceRefreshError?: string | null;
  onRefreshWorkspace?: () => void;
  onInterruptTurn?: () => void;
  onOpenWorkspaceFile?: (path: string) => void;
  reviewComments?: readonly ReviewCommentContext[];
  onAddReviewComment?: (comment: ReviewCommentContext) => void;
  onRemoveReviewComment?: (commentId: string) => void;
}

const workspaceSurfaceClassName = 'rounded-xl border border-[#dedbd0] bg-[#faf9f5] dark:border-[#30302e] dark:bg-[#1d1d1b]';
const EMPTY_CHANGED_FILES: string[] = [];
const EMPTY_CHANGED_FILE_STATS: CodeAgentWorkspaceSnapshot['changes']['changedFileStats'] = [];
const EMPTY_DIFF_FILE_SUMMARIES: readonly CodeAgentWorkspaceDiffFileSummary[] = [];
const MOBILE_WORKSPACE_QUERY = '(max-width: 1023px)';

type ScopedDiffFileSummaries = {
  scopeKey: string;
  summaries: readonly CodeAgentWorkspaceDiffFileSummary[];
};

function readResolvedTheme() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function useResolvedTheme() {
  const [resolvedTheme, setResolvedTheme] = React.useState<'light' | 'dark'>(readResolvedTheme);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const observer = new MutationObserver(() => setResolvedTheme(readResolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return resolvedTheme;
}

function readIsMobileWorkspaceLayout() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(MOBILE_WORKSPACE_QUERY).matches;
}

function useMobileWorkspaceLayout() {
  const [isMobileWorkspaceLayout, setIsMobileWorkspaceLayout] = React.useState(readIsMobileWorkspaceLayout);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mediaQuery = window.matchMedia(MOBILE_WORKSPACE_QUERY);
    const update = () => setIsMobileWorkspaceLayout(mediaQuery.matches);
    update();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', update);
      return () => mediaQuery.removeEventListener('change', update);
    }
    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return isMobileWorkspaceLayout;
}

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

const backendShortLabels: Record<CodeAgentBackend, string> = {
  'code-agent': 'Coco',
  codex: 'Codex',
  'codex-app-server': 'CodexApp',
};

const modePillLabels: Record<ReturnType<typeof normalizeCodeAgentMode>, string> = {
  plan: 'Plan',
  edit: 'Edit',
  approveForMe: 'Auto',
  fullAccess: 'Full',
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readString = (value: unknown, key: string): string => {
  if (!isRecord(value)) return '';
  const item = value[key];
  return typeof item === 'string' ? item : '';
};

const readNumber = (value: unknown, key: string): number | null => {
  if (!isRecord(value)) return null;
  const item = value[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
};

const threadIdFor = (thread: unknown) => readString(thread, 'id');
const threadTitleFor = (thread: unknown) => readString(thread, 'name') || readString(thread, 'preview') || threadIdFor(thread);
const threadPreviewFor = (thread: unknown) => readString(thread, 'preview');

const threadUpdatedAtFor = (thread: unknown) => {
  const updatedAt = readNumber(thread, 'updatedAt') || readNumber(thread, 'createdAt');
  if (!updatedAt) return '';
  return new Date(updatedAt * 1000).toLocaleString();
};

const threadTurnCountFor = (thread: unknown) => {
  if (!isRecord(thread) || !Array.isArray(thread.turns)) return 0;
  return thread.turns.length;
};

export const CodeAgentWorkspacePanel: React.FC<CodeAgentWorkspacePanelProps> = ({
  room,
  messages,
  mode,
  availableModes,
  backend,
  canSwitchMode = false,
  canSwitchBackend = false,
  onModeChange,
  onBackendChange,
  sessionCostUsd,
  workspaceSnapshot,
  isRefreshingWorkspace = false,
  workspaceRefreshError,
  onRefreshWorkspace,
  onInterruptTurn,
  onOpenWorkspaceFile,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
}) => {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const isMobileWorkspaceLayout = useMobileWorkspaceLayout();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [selectedWorkspaceTab, setSelectedWorkspaceTab] = React.useState('overview');
  const [codexThreads, setCodexThreads] = React.useState<unknown[]>([]);
  const [codexThreadsNextCursor, setCodexThreadsNextCursor] = React.useState<string | null | undefined>(null);
  const [isLoadingCodexThreads, setIsLoadingCodexThreads] = React.useState(false);
  const [codexThreadsError, setCodexThreadsError] = React.useState<string | null>(null);
  const [selectedCodexThreadId, setSelectedCodexThreadId] = React.useState<string | null>(null);
  const [selectedCodexThread, setSelectedCodexThread] = React.useState<unknown | null>(null);
  const [isLoadingSelectedCodexThread, setIsLoadingSelectedCodexThread] = React.useState(false);
  const diffPanelSelection = useCodeAgentDiffPanelSelection(room.id);
  const [diffFileSummaries, setDiffFileSummaries] = React.useState<ScopedDiffFileSummaries>(() => ({
    scopeKey: '',
    summaries: [],
  }));
  const messageSummary = React.useMemo(() => summarizeCodeAgentMessages(messages), [messages]);
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
  const changedFileStats = workspaceChanges?.changedFileStats ?? EMPTY_CHANGED_FILE_STATS;
  const diffRefreshKey = `${room.sandboxStatus || 'none'}:${room.sandboxUpdatedAt || ''}:${workspaceSnapshot?.generatedAt || ''}`;
  const diffSelectionScopeKey = diffPanelSelection.kind === 'branch'
    ? `branch:${diffPanelSelection.baseRef ?? 'auto'}`
    : 'unstaged';
  const changedFilesExpansionScopeKey = `${room.sandboxStatus || 'none'}:${room.sandboxUpdatedAt || ''}:${diffSelectionScopeKey}`;
  const allChangedDirectoriesExpanded = useCodeAgentChangedFilesExpanded(room.id, changedFilesExpansionScopeKey);
  const diffSummaryScopeKey = `${diffRefreshKey}:${diffSelectionScopeKey}`;
  const hasActiveDiffFileSummaries = diffFileSummaries.scopeKey === diffSummaryScopeKey;
  const activeDiffFileSummaries = hasActiveDiffFileSummaries
    ? diffFileSummaries.summaries
    : EMPTY_DIFF_FILE_SUMMARIES;
  const liveChangedFileEntries = React.useMemo(
    () => activeDiffFileSummaries.map((summary) => ({
      path: normalizeChangedFilePath(summary.path),
      additions: summary.additions,
      deletions: summary.deletions,
    })).filter((entry) => entry.path.length > 0),
    [activeDiffFileSummaries],
  );
  const snapshotChangedFileEntries = React.useMemo(
    () => {
      const statEntries = changedFileStats.map((stat) => ({
        path: normalizeChangedFilePath(stat.path),
        additions: stat.additions,
        deletions: stat.deletions,
      })).filter((entry) => entry.path.length > 0);
      const statPathSet = new Set(statEntries.map((entry) => entry.path));
      const fallbackEntries = changedFiles
        .map((path) => ({ path: normalizeChangedFilePath(path) }))
        .filter((entry) => entry.path.length > 0 && !statPathSet.has(entry.path));
      if (statEntries.length > 0) {
        return [...statEntries, ...fallbackEntries];
      }
      return fallbackEntries;
    },
    [changedFileStats, changedFiles],
  );
  const changedFileEntries = hasActiveDiffFileSummaries
    ? liveChangedFileEntries
    : snapshotChangedFileEntries;
  const showOuterChangedFilesSummary = changedFileEntries.length > 0 && !isMobileWorkspaceLayout;
  const showOuterChangedFilesTree = changedFileEntries.length > 0 && !isMobileWorkspaceLayout;
  const normalizedChangedFilePathSet = React.useMemo(
    () => new Set(changedFileEntries.map((entry) => normalizeChangedFilePath(entry.path))),
    [changedFileEntries],
  );
  const selectedDiffFilePath = diffPanelSelection.filePath;
  const selectedDiffFileRequestId = diffPanelSelection.revealRequestId;
  const hasChangedFileDirectories = React.useMemo(
    () => changedFileEntries.some((entry) => entry.path.includes('/')),
    [changedFileEntries],
  );
  const changedFileSummary = React.useMemo(
    () => {
      const parsedSummary = summarizeCodeAgentChangedFileStats(changedFileEntries);
      if (hasActiveDiffFileSummaries || !workspaceChanges?.diffSummary) {
        return parsedSummary;
      }
      return {
        additions: workspaceChanges.diffSummary.additions,
        deletions: workspaceChanges.diffSummary.deletions,
      };
    },
    [changedFileEntries, hasActiveDiffFileSummaries, workspaceChanges?.diffSummary],
  );
  const normalizedAvailableModes = React.useMemo(
    () => normalizeCodeAgentModeList(availableModes?.length ? availableModes : [mode]),
    [availableModes, mode]
  );
  const normalizedMode = normalizeCodeAgentMode(mode);
  const selectedMode = normalizedAvailableModes.includes(normalizedMode)
    ? normalizedMode
    : normalizedAvailableModes[0];
  const agentStatus = getCodeAgentStatus(room);
  const detailsId = 'code-agent-workspace-details';
  const shouldLoadDiff = selectedWorkspaceTab === 'changes';
  const changesScrollClassName = isMobileWorkspaceLayout
    ? 'flex max-h-[min(42dvh,22rem)] min-h-0 flex-col overflow-y-auto overscroll-contain p-0 [-webkit-overflow-scrolling:touch] touch-pan-y'
    : 'flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3 py-2';
  const changesScrollStyle: React.CSSProperties | undefined = isMobileWorkspaceLayout
    ? undefined
    : { height: 'min(44vh, 30rem)' };
  const changesContentClassName = isMobileWorkspaceLayout
    ? 'flex min-w-0 flex-col gap-2'
    : 'flex min-h-0 flex-1 flex-col gap-2';

  React.useEffect(() => {
    const hasResolvedChangedFiles = hasActiveDiffFileSummaries || changedFiles.length > 0 || workspaceChanges?.available === true;
    if (hasResolvedChangedFiles && selectedDiffFilePath && !normalizedChangedFilePathSet.has(selectedDiffFilePath)) {
      clearCodeAgentDiffFile(room.id);
    }
  }, [
    changedFiles.length,
    hasActiveDiffFileSummaries,
    normalizedChangedFilePathSet,
    room.id,
    selectedDiffFilePath,
    workspaceChanges?.available,
  ]);

  const handleOpenDiffFile = React.useCallback((path: string) => {
    const normalizedPath = normalizeChangedFilePath(path);
    selectCodeAgentDiffFile(room.id, normalizedPath);
  }, [room.id]);

  const handleDiffFileSummariesChange = React.useCallback((summaries: readonly CodeAgentWorkspaceDiffFileSummary[]) => {
    setDiffFileSummaries({
      scopeKey: diffSummaryScopeKey,
      summaries,
    });
  }, [diffSummaryScopeKey]);

  const renderWorkspaceDiffViewer = React.useCallback(() => (
    <CodeAgentWorkspaceDiffViewer
      roomId={room.id}
      enabled={shouldLoadDiff}
      refreshKey={diffRefreshKey}
      onOpenFile={onOpenWorkspaceFile}
      onFileSummariesChange={handleDiffFileSummariesChange}
      selectedFilePath={selectedDiffFilePath}
      selectedFileRevealRequestId={selectedDiffFileRequestId}
      reviewComments={reviewComments}
      onAddReviewComment={onAddReviewComment}
      onRemoveReviewComment={onRemoveReviewComment}
      mobileLayout={isMobileWorkspaceLayout}
      compactLayout
    />
  ), [
    diffRefreshKey,
    handleDiffFileSummariesChange,
    isMobileWorkspaceLayout,
    onAddReviewComment,
    onOpenWorkspaceFile,
    onRemoveReviewComment,
    reviewComments,
    room.id,
    selectedDiffFilePath,
    selectedDiffFileRequestId,
    shouldLoadDiff,
  ]);

  const stats = [
    { label: t('codeAgentTools'), value: summary.toolCalls, icon: 'lucide:wrench' },
    { label: t('codeAgentResults'), value: summary.toolResults, icon: 'lucide:list-checks' },
    { label: t('codeAgentErrors'), value: summary.toolErrors, icon: 'lucide:circle-alert' },
  ];
  const canToggleMode = canSwitchMode && normalizedAvailableModes.length > 1 && Boolean(onModeChange);
  const currentBackend: CodeAgentBackend = backend || room.codeAgentBackend || 'code-agent';
  const canToggleBackend = canSwitchBackend && Boolean(onBackendChange);
  const canBrowseCodexThreads = currentBackend === 'codex-app-server';
  const loadCodexThreads = React.useCallback(async (cursor?: string | null) => {
    if (!canBrowseCodexThreads) {
      setCodexThreads([]);
      setCodexThreadsNextCursor(null);
      return;
    }
    setIsLoadingCodexThreads(true);
    setCodexThreadsError(null);
    try {
      const result = await requestCodexThreads(room.id, { cursor: cursor || null, limit: 25 });
      setCodexThreads((current) => cursor ? [...current, ...result.threads] : result.threads);
      setCodexThreadsNextCursor(result.nextCursor);
    } catch (error) {
      setCodexThreadsError(error instanceof Error ? error.message : t('codeAgentThreadBrowserFailed'));
    } finally {
      setIsLoadingCodexThreads(false);
    }
  }, [canBrowseCodexThreads, room.id, t]);

  React.useEffect(() => {
    if (selectedWorkspaceTab === 'threads') {
      void loadCodexThreads(null);
    }
  }, [loadCodexThreads, selectedWorkspaceTab]);

  const handleOpenCodexThread = React.useCallback(async (threadId: string) => {
    setSelectedCodexThreadId(threadId);
    setIsLoadingSelectedCodexThread(true);
    try {
      setSelectedCodexThread(await requestCodexThread(room.id, threadId, { includeTurns: true }));
    } catch (error) {
      setCodexThreadsError(error instanceof Error ? error.message : t('codeAgentThreadBrowserFailed'));
    } finally {
      setIsLoadingSelectedCodexThread(false);
    }
  }, [room.id, t]);

  return (
    <section
      data-testid="code-agent-workspace"
      className="sticky top-0 z-30 max-h-[calc(100dvh-var(--code-agent-composer-height,96px)-2.5rem)] min-w-0 max-w-full flex-shrink-0 overflow-x-hidden overflow-y-auto border-b border-[#dedbd0] bg-[#f5f4ed]/95 px-3 pb-3 pt-3 shadow-[0_1px_0_rgba(20,20,19,0.04)] backdrop-blur dark:border-[#30302e] dark:bg-[#141413]/95 dark:shadow-[0_1px_0_rgba(250,249,245,0.04)] lg:max-h-[calc(100dvh-var(--code-agent-composer-height,96px)-4rem)]"
      aria-label={t('codeAgentWorkspace')}
    >
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Dropdown placement="bottom-start">
              <DropdownTrigger>
                <Button
                  size="sm"
                  variant="flat"
                  radius="full"
                  aria-label={t('codeAgentModeControl')}
                  title={t('codeAgentModeControl')}
                  data-testid="code-agent-mode-toggle"
                  isDisabled={!canToggleMode}
                  className={`h-6 min-w-0 gap-1 border border-[#dedbd0] bg-[#faf9f5] px-2 text-[11px] font-semibold text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5] ${
                    canToggleMode ? 'cursor-pointer' : 'cursor-default opacity-100'
                  }`}
                >
                  {modePillLabels[selectedMode]}
                  {canToggleMode ? <Icon icon="lucide:chevron-down" className="h-3 w-3 flex-shrink-0 opacity-70" /> : null}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label={t('codeAgentModeControl')}
                selectionMode="single"
                selectedKeys={[selectedMode]}
                onAction={(key) => {
                  const nextMode = normalizeCodeAgentMode(key.toString());
                  if (canToggleMode && normalizedAvailableModes.includes(nextMode)) {
                    onModeChange?.(nextMode);
                  }
                }}
              >
                {normalizedAvailableModes.map(option => (
                  <DropdownItem key={option} startContent={<Icon icon={getCodeAgentModeIcon(option)} />}>
                    {t(getCodeAgentModeLabelKey(option))}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
            <div
              role="group"
              aria-label={t('codeAgentEngine')}
              data-testid="code-agent-backend-toggle"
              className="inline-flex h-6 shrink-0 overflow-hidden rounded-full border border-[#dedbd0] bg-[#faf9f5] p-0.5 dark:border-[#30302e] dark:bg-[#242421]"
            >
              {CODE_AGENT_BACKEND_OPTIONS.map((option) => {
                const selected = currentBackend === option;
                const labelKey = getCodeAgentBackendLabelKey(option);
                return (
                  <Button
                    key={option}
                    size="sm"
                    variant="light"
                    radius="full"
                    aria-label={t(labelKey)}
                    title={t(labelKey)}
                    data-testid={`code-agent-backend-${option}`}
                    isDisabled={!canToggleBackend}
                    onPress={() => {
                      if (!canToggleBackend || selected) return;
                      onBackendChange?.(option);
                    }}
                    className={`h-5 min-w-8 px-1.5 text-[10px] font-semibold leading-none ${
                      selected
                        ? 'bg-[#30302e] text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]'
                        : 'bg-transparent text-[#5e5d59] dark:text-[#b0aea5]'
                    }`}
                  >
                    {backendShortLabels[option]}
                  </Button>
                );
              })}
            </div>
            {onRefreshWorkspace && (
              <Button
                size="sm"
                variant="flat"
                radius="full"
                isIconOnly
                isLoading={isRefreshingWorkspace}
                aria-label={t('codeAgentRefreshWorkspace')}
                title={t('codeAgentRefreshWorkspace')}
                data-testid="code-agent-refresh-workspace"
                className="h-6 w-6 min-w-6 border border-[#dedbd0] bg-[#faf9f5] p-0 text-[#4d4c48] dark:border-[#30302e] dark:bg-[#242421] dark:text-[#faf9f5]"
                onPress={onRefreshWorkspace}
              >
                <Icon icon="lucide:refresh-cw" className="h-3.5 w-3.5" />
              </Button>
            )}
            {agentStatus === 'running' && onInterruptTurn ? (
              <Button
                isIconOnly
                size="sm"
                variant="flat"
                radius="full"
                aria-label={t('codeAgentInterrupt')}
                title={t('codeAgentInterrupt')}
                data-testid="code-agent-interrupt-turn"
                className="h-6 w-6 min-w-6 border border-[#f0b49e] bg-[#fff1eb] text-[#a44428] dark:border-[#6f3526] dark:bg-[#321f19] dark:text-[#ffb197]"
                onPress={onInterruptTurn}
              >
                <Icon icon="lucide:square" className="h-3.5 w-3.5" />
              </Button>
            ) : null}
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
              {t(getCodeAgentModeDescriptionKey(selectedMode))}
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
          <span className={`inline-flex max-w-[150px] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getCodeAgentStatusClassName(agentStatus)}`}>
            <Icon icon="lucide:bot" className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{t(getCodeAgentStatusLabelKey(agentStatus))}</span>
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
        className={`mt-3 min-w-0 overflow-hidden ${workspaceSurfaceClassName}`}
      >
        <Tabs
          aria-label={t('codeAgentWorkspace')}
          selectedKey={selectedWorkspaceTab}
          onSelectionChange={(key) => setSelectedWorkspaceTab(String(key))}
          size="sm"
          variant="underlined"
          classNames={{
            base: 'block w-full max-w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-[#dedbd0] [scrollbar-width:none] [-webkit-overflow-scrolling:touch] touch-pan-x dark:border-[#30302e] [&::-webkit-scrollbar]:hidden',
            tabList: 'inline-flex w-max min-w-max max-w-none flex-nowrap gap-2 overflow-visible whitespace-nowrap p-0 px-2',
            cursor: 'bg-[#d66a43]',
            tab: 'h-9 w-auto flex-none whitespace-nowrap px-2 text-xs font-semibold',
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
            key="threads"
            title={
              <span className="inline-flex items-center gap-1.5">
                <Icon icon="lucide:messages-square" className="h-3.5 w-3.5" />
                {t('codeAgentThreads')}
              </span>
            }
          >
            <div className="grid max-h-56 min-h-0 divide-y divide-[#dedbd0] overflow-y-auto dark:divide-[#30302e] lg:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] lg:divide-x lg:divide-y-0">
              <div className="min-w-0 px-2 py-2">
                {!canBrowseCodexThreads ? (
                  <p className="px-1 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentThreadBrowserUnavailable')}</p>
                ) : codexThreadsError ? (
                  <p className="px-1 text-xs font-medium text-[#9f462c] dark:text-[#ff9b78]">{codexThreadsError}</p>
                ) : isLoadingCodexThreads && codexThreads.length === 0 ? (
                  <p className="px-1 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('loading')}</p>
                ) : codexThreads.length === 0 ? (
                  <p className="px-1 text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentNoThreads')}</p>
                ) : (
                  <div className="space-y-1">
                    {codexThreads.map((thread) => {
                      const threadId = threadIdFor(thread);
                      const selected = selectedCodexThreadId === threadId;
                      return (
                        <button
                          key={threadId || JSON.stringify(thread)}
                          type="button"
                          className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            selected
                              ? 'bg-[#fff1eb] text-[#9f462c] dark:bg-[#3a241d] dark:text-[#ffb197]'
                              : 'text-[#4d4c48] hover:bg-[#f0eee6] dark:text-[#e8e6dc] dark:hover:bg-[#242421]'
                          }`}
                          onClick={() => threadId && handleOpenCodexThread(threadId)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{threadTitleFor(thread)}</span>
                            <span className="block truncate font-mono text-[10px] text-[#87867f] dark:text-[#8f8d86]">{threadUpdatedAtFor(thread)}</span>
                          </span>
                          <Icon icon="lucide:chevron-right" className="mt-0.5 h-3.5 w-3.5 text-[#b0aea5]" />
                        </button>
                      );
                    })}
                    {codexThreadsNextCursor ? (
                      <Button
                        size="sm"
                        variant="light"
                        className="h-7 w-full text-xs"
                        isLoading={isLoadingCodexThreads}
                        onPress={() => loadCodexThreads(codexThreadsNextCursor)}
                      >
                        {t('showMore')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="min-w-0 px-3 py-2">
                {isLoadingSelectedCodexThread ? (
                  <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('loading')}</p>
                ) : selectedCodexThread ? (
                  <div className="space-y-2 text-xs">
                    <div>
                      <div className="truncate font-semibold text-[#4d4c48] dark:text-[#e8e6dc]">{threadTitleFor(selectedCodexThread)}</div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-[#87867f] dark:text-[#8f8d86]">{threadIdFor(selectedCodexThread)}</div>
                    </div>
                    {threadPreviewFor(selectedCodexThread) ? (
                      <p className="line-clamp-3 text-[#5e5d59] dark:text-[#b0aea5]">{threadPreviewFor(selectedCodexThread)}</p>
                    ) : null}
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-[#dedbd0] px-2 py-0.5 text-[10px] font-semibold text-[#5e5d59] dark:border-[#30302e] dark:text-[#b0aea5]">
                        {t('codeAgentThreadTurns')}: {threadTurnCountFor(selectedCodexThread)}
                      </span>
                      {readString(selectedCodexThread, 'modelProvider') ? (
                        <span className="rounded-full border border-[#dedbd0] px-2 py-0.5 text-[10px] font-semibold text-[#5e5d59] dark:border-[#30302e] dark:text-[#b0aea5]">
                          {readString(selectedCodexThread, 'modelProvider')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-[#87867f] dark:text-[#8f8d86]">{t('codeAgentSelectThread')}</p>
                )}
              </div>
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
            <div
              className={changesScrollClassName}
              style={changesScrollStyle}
              data-testid="code-agent-workspace-changes-scroll"
              data-mobile-layout={isMobileWorkspaceLayout ? 'true' : undefined}
            >
              <div className={changesContentClassName} data-testid="code-agent-workspace-changes-content">
                {isMobileWorkspaceLayout ? (
                  <div
                    className="flex h-[clamp(14rem,38dvh,24rem)] min-h-0 min-w-0 flex-col overflow-hidden"
                    data-testid="code-agent-mobile-changes-inline"
                  >
                    {renderWorkspaceDiffViewer()}
                  </div>
                ) : showOuterChangedFilesSummary || showOuterChangedFilesTree ? (
                  <>
                    {showOuterChangedFilesSummary ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#4d4c48] dark:text-[#e8e6dc]">
                        <span className="font-semibold">{t('codeAgentChangedFilesCount', { count: changedFileEntries.length })}</span>
                        {hasNonZeroChangedFileStat(changedFileSummary) ? (
                          <CodeAgentDiffStatLabel
                            additions={changedFileSummary.additions}
                            deletions={changedFileSummary.deletions}
                            className="text-[11px]"
                            layout="inline"
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {showOuterChangedFilesTree ? (
                      <div className="space-y-1">
                        {hasChangedFileDirectories ? (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              data-scroll-anchor-ignore
                              className={`${isMobileWorkspaceLayout ? 'min-h-8 px-2.5' : 'px-2 py-1'} rounded-md border border-[#dedbd0] text-[11px] font-semibold text-[#5e5d59] transition-colors hover:bg-[#f0eee6] hover:text-[#141413] dark:border-[#30302e] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]`}
                              onClick={() => setCodeAgentChangedFilesExpanded(room.id, changedFilesExpansionScopeKey, !allChangedDirectoriesExpanded)}
                            >
                              {allChangedDirectoriesExpanded ? t('codeAgentCollapseChangedFileTree') : t('codeAgentExpandChangedFileTree')}
                            </button>
                          </div>
                        ) : null}
                        <CodeAgentChangedFilesTree
                          files={changedFileEntries}
                          allDirectoriesExpanded={allChangedDirectoriesExpanded}
                          resolvedTheme={resolvedTheme}
                          selectedPath={selectedDiffFilePath}
                          onOpenDiffFile={handleOpenDiffFile}
                          mobileLayout={isMobileWorkspaceLayout}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
                {isMobileWorkspaceLayout ? null : renderWorkspaceDiffViewer()}
              </div>
            </div>
          </Tab>
        </Tabs>
      </div>
    </section>
  );
};
