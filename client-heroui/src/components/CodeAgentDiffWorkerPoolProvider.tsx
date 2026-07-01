import React from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  resolveCodeAgentDiffThemeName,
  type CodeAgentDiffThemeName,
} from '../utils/codeAgentDiffRendering';

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

function logDiffWorkerError(
  operation: 'create-worker' | 'get-render-options' | 'set-render-options',
  themeName: CodeAgentDiffThemeName,
  cause: unknown,
) {
  console.error(new Error(`Diff worker operation ${operation} failed for theme ${themeName}.`, { cause }));
}

function DiffWorkerThemeSync({ themeName }: { themeName: CodeAgentDiffThemeName }) {
  const workerPool = useWorkerPool();

  React.useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: 'get-render-options' | 'set-render-options' = 'get-render-options';
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = 'set-render-options';
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        logDiffWorkerError(operation, themeName, cause);
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

export function CodeAgentDiffWorkerPoolProvider({ children }: { children?: React.ReactNode }) {
  const resolvedTheme = useResolvedTheme();
  const diffThemeName = resolveCodeAgentDiffThemeName(resolvedTheme);
  const DiffsWorkerConstructor = DiffsWorker as unknown as { new(): Worker } | undefined;
  const canCreateDiffWorker = typeof Worker !== 'undefined' && typeof DiffsWorkerConstructor === 'function';
  const workerPoolSize = React.useMemo(() => {
    const cores = typeof navigator === 'undefined'
      ? 4
      : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  if (!canCreateDiffWorker) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => {
          try {
            return new DiffsWorkerConstructor();
          } catch (cause) {
            logDiffWorkerError('create-worker', diffThemeName, cause);
            throw cause;
          }
        },
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
