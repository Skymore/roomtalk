import type { ReactNode } from 'react';

export type CodeAgentWorkspaceDiffPanelMode = 'inline' | 'sheet' | 'sidebar' | 'embedded';

function getDiffPanelWidthClassName(mode: CodeAgentWorkspaceDiffPanelMode) {
  return mode === 'inline'
    ? 'w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-[#dedbd0] dark:border-[#30302e]'
    : 'w-full';
}

export function CodeAgentWorkspaceDiffPanelShell({
  mode,
  header,
  children,
  testId,
  headerClassName,
}: {
  mode: CodeAgentWorkspaceDiffPanelMode;
  header: ReactNode;
  children: ReactNode;
  testId?: string;
  headerClassName?: string;
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col bg-transparent ${getDiffPanelWidthClassName(mode)}`}
      data-testid={testId}
    >
      <div
        className={`surface-subheader flex shrink-0 border-b border-[#dedbd0] dark:border-[#30302e] ${
          headerClassName ?? 'h-9 items-center justify-between gap-2 px-3'
        }`}
        data-surface-subheader
      >
        {header}
      </div>
      {children}
    </div>
  );
}

export function CodeAgentWorkspaceDiffPanelViewport({ children }: { children: ReactNode }) {
  return (
    <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );
}

export function CodeAgentWorkspaceDiffPanelHeaderSkeleton() {
  return (
    <>
      <div className="min-w-0 flex-1">
        <span className="block h-8 w-32 animate-pulse rounded-lg bg-[#dedbd0] dark:bg-[#30302e]" />
      </div>
      <div className="flex shrink-0 gap-1">
        <span className="block h-7 w-7 animate-pulse rounded-md bg-[#dedbd0] dark:bg-[#30302e]" />
        <span className="block h-7 w-7 animate-pulse rounded-md bg-[#dedbd0] dark:bg-[#30302e]" />
      </div>
    </>
  );
}

export function CodeAgentWorkspaceDiffLoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2" data-testid="code-agent-workspace-diff-loading">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[#dedbd0] bg-[#faf9f5]/70 dark:border-[#30302e] dark:bg-[#1d1d1b]/70"
        role="status"
        aria-live="polite"
        aria-label={label}
      >
        <div className="flex items-center gap-2 border-b border-[#dedbd0]/70 px-3 py-2 dark:border-[#30302e]/70">
          <span className="h-4 w-32 animate-pulse rounded-full bg-[#dedbd0] dark:bg-[#30302e]" />
          <span className="ml-auto h-4 w-20 animate-pulse rounded-full bg-[#dedbd0] dark:bg-[#30302e]" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <span className="block h-3 w-full animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-full animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-10/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-11/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
            <span className="block h-3 w-9/12 animate-pulse rounded-full bg-[#e8e6dc] dark:bg-[#242422]" />
          </div>
          <span className="sr-only">{label}</span>
        </div>
      </div>
    </div>
  );
}
