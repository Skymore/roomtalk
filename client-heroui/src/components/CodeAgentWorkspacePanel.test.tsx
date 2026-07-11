// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message, Room } from '../utils/types';
import {
  resetCodeAgentDiffPanelStoreForTests,
  selectCodeAgentDiffScope,
} from '../utils/codeAgentDiffPanelStore';
import { resetCodeAgentChangedFilesExpansionStoreForTests } from '../utils/codeAgentChangedFilesExpansionStore';
import {
  readCodeAgentRightPanelState,
  resetCodeAgentRightPanelStoreForTests,
} from '../utils/codeAgentRightPanelStore';
import { CodeAgentWorkspacePanel } from './CodeAgentWorkspacePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('./CodeAgentWorkspaceDiffViewer', () => ({
  CodeAgentWorkspaceDiffViewer: ({
    enabled,
    onFileSummariesChange,
    selectedFilePath,
    selectedFileRevealRequestId,
    mobileLayout,
    compactLayout,
  }: {
    enabled: boolean;
    onFileSummariesChange?: (summaries: readonly { id: string; path: string; additions: number; deletions: number }[]) => void;
    selectedFilePath?: string | null;
    selectedFileRevealRequestId?: number;
    mobileLayout?: boolean;
    compactLayout?: boolean;
  }) => (
    <div
      data-testid="code-agent-workspace-diff-viewer"
      data-enabled={String(enabled)}
      data-selected-file={selectedFilePath || ''}
      data-selected-file-request-id={String(selectedFileRevealRequestId || '')}
      data-mobile-layout={String(Boolean(mobileLayout))}
      data-compact-layout={String(Boolean(compactLayout))}
    >
      <button
        type="button"
        data-testid="emit-diff-file-summaries"
        onClick={() => onFileSummariesChange?.([
          { id: 'src/App.tsx', path: 'src/App.tsx', additions: 7, deletions: 3 },
        ])}
      >
        emit summaries
      </button>
    </div>
  ),
}));

const room: Room = {
  id: 'room-1',
  name: 'Code Agent',
  createdAt: '2026-05-26T00:00:00.000Z',
  creatorId: 'client-1',
  type: 'codeAgent',
  sandboxStatus: 'ready',
  codeAgentStatus: 'idle',
};

const toolCall: Message = {
  id: 'tool-1',
  clientId: 'code_agent_runner',
  content: '',
  roomId: 'room-1',
  timestamp: '2026-05-26T00:00:00.000Z',
  messageType: 'tool_call',
  toolName: 'Read',
  toolArgs: { file_path: '/workspace/src/App.tsx' },
};

function mockWorkspacePanelMobileLayout(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(max-width: 1023px)' ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe('CodeAgentWorkspacePanel', () => {
  beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    resetCodeAgentChangedFilesExpansionStoreForTests();
    resetCodeAgentDiffPanelStoreForTests();
    resetCodeAgentRightPanelStoreForTests();
    vi.unstubAllGlobals();
  });

  it('renders plan mode as read-only workspace state', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('codexPermissionPlanDescription')).toBeTruthy();
    expect(screen.getByText('codeAgentTools')).toBeTruthy();
    expect(screen.getByText('codeAgentResults')).toBeTruthy();
    expect(screen.getByText('codeAgentErrors')).toBeTruthy();
    fireEvent.click(screen.getByText('codeAgentActivity'));
    expect(screen.getByText('codeAgentNoActivity')).toBeTruthy();
    fireEvent.click(screen.getByText('codeAgentArtifacts'));
    expect(screen.getByText('codeAgentNoArtifacts')).toBeTruthy();
  });

  it('selects run mode from the workspace header when switching is available', async () => {
    const onModeChange = vi.fn();
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        availableModes={['plan', 'edit']}
        canSwitchMode
        onModeChange={onModeChange}
        sessionCostUsd={0}
      />
    );

    fireEvent.click(screen.getByTestId('code-agent-mode-toggle'));
    fireEvent.click(await screen.findByText('codexPermissionEdit'));

    expect(onModeChange).toHaveBeenCalledWith('edit');
  });

  it('toggles code-agent engine from the workspace header when switching is available', () => {
    const onBackendChange = vi.fn();
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        backend="code-agent"
        canSwitchBackend
        onBackendChange={onBackendChange}
        sessionCostUsd={0}
      />
    );

    expect(screen.getByText('Coco')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByTestId('code-agent-backend-codex')).toBeNull();

    fireEvent.click(screen.getByTestId('code-agent-backend-codex-app-server'));

    expect(onBackendChange).toHaveBeenCalledWith('codex-app-server');
  });

  it('shows the latest Codex context usage', () => {
    const aiMessage: Message = {
      id: 'ai-1',
      clientId: 'ai_assistant',
      content: 'Working',
      roomId: room.id,
      timestamp: '2026-07-09T00:00:00.000Z',
      messageType: 'ai',
      status: 'streaming',
      usage: {
        promptTokens: 106_000,
        completionTokens: 0,
        totalTokens: 106_000,
        modelContextWindow: 200_000,
        source: 'reported',
      },
    };

    render(
      <CodeAgentWorkspacePanel
        room={{ ...room, codeAgentBackend: 'codex-app-server' }}
        messages={[aiMessage]}
        mode="plan"
        backend="codex-app-server"
        sessionCostUsd={0}
      />
    );

    expect(screen.getByTestId('code-agent-context-usage').textContent).toBe('Context: 50%');
    expect(screen.getByText('Cost: $0.000000')).toBeTruthy();
  });

  it('keeps workspace tabs horizontally scrollable on narrow screens', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
      />
    );

    const workspace = screen.getByTestId('code-agent-workspace');
    expect(workspace.className).toContain('min-w-0');
    expect(workspace.className).toContain('max-w-full');
    expect(workspace.className).toContain('overflow-x-hidden');
    expect(workspace.className).toContain('overflow-y-auto');
    expect(workspace.className).toContain('max-h-[calc(100dvh-var(--code-agent-composer-height,96px)-2.5rem)]');
    expect(workspace.className).toContain('lg:max-h-[calc(100dvh-var(--code-agent-composer-height,96px)-4rem)]');

    const details = screen.getByTestId('code-agent-workspace-details');
    expect(details.className).toContain('min-w-0');
    expect(details.className).toContain('overflow-hidden');

    const tabList = screen.getByRole('tablist', { name: 'codeAgentWorkspace' });
    const tabsViewport = tabList.parentElement;
    expect(tabsViewport?.getAttribute('data-slot')).toBe('base');
    expect(tabsViewport?.className).toContain('overflow-x-auto');
    expect(tabsViewport?.className).toContain('overflow-y-hidden');
    expect(tabsViewport?.className).toContain('overscroll-x-contain');
    expect(tabsViewport?.className).toContain('max-w-full');
    expect(tabsViewport?.className).toContain('[scrollbar-width:none]');
    expect(tabsViewport?.className).toContain('[-webkit-overflow-scrolling:touch]');
    expect(tabsViewport?.className).toContain('touch-pan-x');

    expect(tabList.className).toContain('inline-flex');
    expect(tabList.className).toContain('w-max');
    expect(tabList.className).toContain('min-w-max');
    expect(tabList.className).toContain('max-w-none');
    expect(tabList.className).toContain('flex-nowrap');
    expect(tabList.className).toContain('overflow-visible');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    tabs.forEach((tab) => {
      expect(tab.className).toContain('flex-none');
      expect(tab.className).toContain('w-auto');
      expect(tab.className).toContain('whitespace-nowrap');
    });
  });

  it('renders edit mode and derived tool activity', () => {
    const onRefreshWorkspace = vi.fn();
    render(
      <CodeAgentWorkspacePanel
        room={{ ...room, codeAgentStatus: 'running' }}
        messages={[toolCall]}
        mode="edit"
        sessionCostUsd={0.25}
        onRefreshWorkspace={onRefreshWorkspace}
      />
    );

    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('codexPermissionEditDescription')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentActivity'));
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByLabelText('codeAgentRefreshWorkspace')).toBeTruthy();
    expect(screen.queryByText('codeAgentRefreshWorkspace')).toBeNull();
  });

  it('allows workspace refresh and shows non-blocking refresh errors', async () => {
    const onRefreshWorkspace = vi.fn();

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
        workspaceRefreshError="Failed"
        onRefreshWorkspace={onRefreshWorkspace}
      />
    );

    fireEvent.click(screen.getByLabelText('codeAgentRefreshWorkspace'));

    expect(onRefreshWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('codeAgentWorkspaceRefreshFailed');
  });

  it('collapses workspace details while keeping the sticky summary available', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[toolCall]}
        mode="plan"
        sessionCostUsd={0.1}
      />
    );

    const toggle = screen.getByTestId('code-agent-workspace-toggle');
    const details = screen.getByTestId('code-agent-workspace-details');

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.getAttribute('hidden')).toBeNull();
    expect(screen.getByText('codeAgentOverview')).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.getAttribute('hidden')).toBe('');
    expect(screen.queryByText('codeAgentWorkspace')).toBeNull();
    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('sandboxStatusReady')).toBeTruthy();
    expect(screen.getByText('codeAgentStatusIdle')).toBeTruthy();
    expect(screen.queryByText('codexPermissionPlanDescription')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.getAttribute('hidden')).toBeNull();
    expect(screen.getByText('codeAgentOverview')).toBeTruthy();
  });

  it('renders command history from refreshed workspace snapshots', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="plan"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-05-29T00:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: false },
          summary: {
            toolCalls: 1,
            toolResults: 1,
            toolErrors: 0,
            lastToolName: 'Shell',
          },
          artifacts: [
            {
              slug: 'roomtalk-demo',
              title: 'RoomTalk Demo',
              url: 'https://room.ruit.me/p/roomtalk-demo/',
              entry: 'index.html',
              versionId: '20260630T120000Z_aaaaaaaa',
              fileCount: 1,
              totalBytes: 128,
              createdAt: '2026-06-30T12:00:00.000Z',
              updatedAt: '2026-06-30T12:00:00.000Z',
            },
          ],
          changes: { available: false, changedFiles: [], changedFileStats: [], diffSummary: null },
          commands: [
            {
              id: 'tool-1',
              name: 'Shell',
              status: 'succeeded',
              preview: 'npm test',
            },
            {
              id: 'tool-2',
              name: 'Write',
              status: 'started',
            },
            {
              id: 'tool-3',
              name: 'Edit',
              status: 'failed',
              preview: 'permission denied',
            },
          ],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentActivity'));
    expect(screen.getAllByText('Shell').length).toBeGreaterThan(0);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandStarted')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandSucceeded')).toBeTruthy();
    expect(screen.getByText('codeAgentCommandFailed')).toBeTruthy();
    expect(screen.getByText('permission denied')).toBeTruthy();

    fireEvent.click(screen.getByText('codeAgentArtifacts'));
    const link = screen.getByText('RoomTalk Demo').closest('a');
    expect(link?.getAttribute('href')).toBe('https://room.ruit.me/p/roomtalk-demo/');
    fireEvent.click(link!);
    expect(readCodeAgentRightPanelState('room-1')).toMatchObject({
      isOpen: true,
      activeSurfaceId: 'browser:url:https%3A%2F%2Froom.ruit.me%2Fp%2Froomtalk-demo%2F',
      surfaces: [{
        kind: 'preview',
        relativePath: null,
        url: 'https://room.ruit.me/p/roomtalk-demo/',
      }],
    });
  });

  it('enables the diff viewer only when the changes tab is active', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: {
            available: true,
            changedFiles: ['src/App.tsx'],
            changedFileStats: [{ path: 'src/App.tsx', additions: 2, deletions: 1 }],
            diffSummary: { files: 1, additions: 2, deletions: 1 },
          },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));

    expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0);
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.getByText('codeAgentCollapseChangedFileTree').hasAttribute('data-scroll-anchor-ignore')).toBe(true);
    expect(screen.getByTestId('code-agent-changed-files-tree')).toBeTruthy();
    fireEvent.click(screen.getByText('App.tsx'));

    const diffViewer = screen.getByTestId('code-agent-workspace-diff-viewer');
    expect(diffViewer.dataset.enabled).toBe('true');
    expect(diffViewer.dataset.selectedFile).toBe('src/App.tsx');
    expect(diffViewer.dataset.selectedFileRequestId).toBe('1');
    expect(diffViewer.dataset.mobileLayout).toBe('false');
    expect(diffViewer.dataset.compactLayout).toBe('true');
    expect(diffViewer.parentElement?.className).toContain('flex-1');
    const changesScroll = screen.getByTestId('code-agent-workspace-changes-scroll');
    expect(changesScroll.className).toContain('overflow-y-auto');
    expect(changesScroll.className).toContain('overscroll-contain');
    expect((changesScroll as HTMLElement).style.height).toBe('min(44vh, 30rem)');
    expect(changesScroll.className).not.toContain('max-h-44');

    fireEvent.click(screen.getByText('App.tsx'));
    expect(diffViewer.dataset.selectedFile).toBe('src/App.tsx');
    expect(diffViewer.dataset.selectedFileRequestId).toBe('2');
  });

  it('uses a mobile scroll shell for workspace changes with composer-safe bottom inset', () => {
    mockWorkspacePanelMobileLayout(true);

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: {
            available: true,
            changedFiles: ['index.html'],
            changedFileStats: [{ path: 'index.html', additions: 888, deletions: 0 }],
            diffSummary: { files: 1, additions: 888, deletions: 0 },
          },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));

    const changesScroll = screen.getByTestId('code-agent-workspace-changes-scroll');
    expect(changesScroll.dataset.mobileLayout).toBe('true');
    expect(changesScroll.className).toContain('overflow-y-auto');
    expect(changesScroll.className).toContain('overscroll-contain');
    expect(changesScroll.className).toContain('touch-pan-y');
    expect(changesScroll.className).toContain('max-h-[min(42dvh,22rem)]');
    expect(changesScroll.className).toContain('p-0');
    expect(changesScroll.className).not.toContain('px-3');
    expect(changesScroll.className).not.toContain('py-2');
    expect(changesScroll.className).not.toContain('pb-[calc(var(--code-agent-composer-height,96px)+env(safe-area-inset-bottom)+1rem)]');
    expect(changesScroll.className).not.toContain('max-h-[min(44vh,30rem)]');
    const changesContent = screen.getByTestId('code-agent-workspace-changes-content');
    expect(changesContent.className).toContain('flex-col');
    expect(changesContent.className).not.toContain('flex-1');
    expect(screen.queryByText('codeAgentChangedFilesCount')).toBeNull();
    expect(screen.queryByText('+888')).toBeNull();
    expect(screen.queryByTestId('code-agent-changed-files-tree')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-changes-summary')).toBeNull();
    const inlineChanges = screen.getByTestId('code-agent-mobile-changes-inline');
    expect(inlineChanges.className).toContain('h-[clamp(14rem,38dvh,24rem)]');
    const inlineDiffViewer = screen.getByTestId('code-agent-workspace-diff-viewer');
    expect(inlineDiffViewer.dataset.enabled).toBe('true');
    expect(inlineDiffViewer.dataset.mobileLayout).toBe('true');
    expect(inlineDiffViewer.dataset.compactLayout).toBe('true');
    expect(inlineChanges.contains(inlineDiffViewer)).toBe(true);
  });

  it('uses inline mobile changes instead of embedding a changed-file tree', () => {
    mockWorkspacePanelMobileLayout(true);

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: {
            available: true,
            changedFiles: ['src/App.tsx', 'src/utils.ts'],
            changedFileStats: [
              { path: 'src/App.tsx', additions: 7, deletions: 3 },
              { path: 'src/utils.ts', additions: 1, deletions: 0 },
            ],
            diffSummary: { files: 2, additions: 8, deletions: 3 },
          },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));

    expect(screen.queryByText('codeAgentChangedFilesCount')).toBeNull();
    expect(screen.queryByTestId('code-agent-changed-files-tree')).toBeNull();
    expect(screen.queryByTestId('code-agent-changed-files-tree-row')).toBeNull();
    expect(screen.queryByText('App.tsx')).toBeNull();
    expect(screen.queryByTestId('code-agent-mobile-changes-summary')).toBeNull();
    const inlineDiffViewer = screen.getByTestId('code-agent-workspace-diff-viewer');
    const inlineChanges = screen.getByTestId('code-agent-mobile-changes-inline');
    expect(inlineChanges.className).toContain('h-[clamp(14rem,38dvh,24rem)]');
    expect(inlineChanges.contains(inlineDiffViewer)).toBe(true);
    expect(inlineDiffViewer.dataset.enabled).toBe('true');
    expect(inlineDiffViewer.dataset.mobileLayout).toBe('true');
    expect(inlineDiffViewer.dataset.compactLayout).toBe('true');
  });

  it('persists changed-file tree collapse state for the same workspace scope', () => {
    const workspaceSnapshot = {
      roomId: 'room-1',
      backend: 'code-agent' as const,
      source: 'sandbox' as const,
      generatedAt: '2026-06-30T12:00:00.000Z',
      status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
      summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
      artifacts: [],
      changes: {
        available: true,
        changedFiles: ['src/App.tsx'],
        changedFileStats: [{ path: 'src/App.tsx', additions: 2, deletions: 1 }],
        diffSummary: { files: 1, additions: 2, deletions: 1 },
      },
      commands: [],
    };

    const { unmount } = render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={workspaceSnapshot}
      />
    );
    fireEvent.click(screen.getByText('codeAgentChanges'));
    fireEvent.click(screen.getByText('codeAgentCollapseChangedFileTree'));
    expect(screen.getByText('codeAgentExpandChangedFileTree')).toBeTruthy();

    unmount();

    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={workspaceSnapshot}
      />
    );
    fireEvent.click(screen.getByText('codeAgentChanges'));

    expect(screen.getByText('codeAgentExpandChangedFileTree')).toBeTruthy();
    expect(screen.queryByText('App.tsx')).toBeNull();
  });

  it('loads live diff summaries even when the old workspace snapshot marks changes unavailable', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: { available: false, changedFiles: [], changedFileStats: [], diffSummary: null },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));

    const diffViewer = screen.getByTestId('code-agent-workspace-diff-viewer');
    expect(diffViewer.dataset.enabled).toBe('true');
    expect(screen.queryByText('codeAgentChangesUnavailable')).toBeNull();
    expect(screen.queryByTestId('code-agent-changed-files-tree')).toBeNull();

    fireEvent.click(screen.getByTestId('emit-diff-file-summaries'));

    expect(screen.getByTestId('code-agent-changed-files-tree')).toBeTruthy();
    expect(screen.getByText('codeAgentChangedFilesCount')).toBeTruthy();
    expect(screen.getByText('codeAgentCollapseChangedFileTree')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.getAllByText('+7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-3').length).toBeGreaterThan(0);
  });

  it('fills changed-file tree stats from parsed diff summaries', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: {
            available: true,
            changedFiles: ['src/App.tsx'],
            changedFileStats: [],
            diffSummary: null,
          },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));
    expect(screen.queryByText('+7')).toBeNull();
    expect(screen.queryByText('-3')).toBeNull();

    fireEvent.click(screen.getByTestId('emit-diff-file-summaries'));

    expect(screen.getAllByText('+7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-3').length).toBeGreaterThan(0);
  });

  it('does not reuse parsed changed-file stats after switching diff scope', () => {
    render(
      <CodeAgentWorkspacePanel
        room={room}
        messages={[]}
        mode="edit"
        sessionCostUsd={0}
        workspaceSnapshot={{
          roomId: 'room-1',
          backend: 'code-agent',
          source: 'sandbox',
          generatedAt: '2026-06-30T12:00:00.000Z',
          status: { sandboxStatus: 'ready', agentStatus: 'idle', hasSession: true },
          summary: { toolCalls: 0, toolResults: 0, toolErrors: 0 },
          artifacts: [],
          changes: {
            available: true,
            changedFiles: ['src/App.tsx'],
            changedFileStats: [],
            diffSummary: null,
          },
          commands: [],
        }}
      />
    );

    fireEvent.click(screen.getByText('codeAgentChanges'));
    fireEvent.click(screen.getByTestId('emit-diff-file-summaries'));
    expect(screen.getAllByText('+7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('-3').length).toBeGreaterThan(0);

    act(() => {
      selectCodeAgentDiffScope('room-1', 'unstaged');
    });

    expect(screen.queryByText('+7')).toBeNull();
    expect(screen.queryByText('-3')).toBeNull();
  });
});
