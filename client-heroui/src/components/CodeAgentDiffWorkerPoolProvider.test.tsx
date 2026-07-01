// @vitest-environment jsdom

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeAgentDiffWorkerPoolProvider } from './CodeAgentDiffWorkerPoolProvider';

const mocks = vi.hoisted(() => {
  const workerPool = {
    getDiffRenderOptions: vi.fn(() => ({ theme: 'pierre-light', tokenizeMaxLineLength: 100 })),
    setRenderOptions: vi.fn(async () => undefined),
  };
  const providerProps = vi.fn();
  const MockDiffsWorker = vi.fn(function MockDiffsWorker() {
    return {} as Worker;
  });
  return { MockDiffsWorker, providerProps, workerPool };
});

vi.mock('@pierre/diffs/react', () => ({
  WorkerPoolContextProvider: ({
    children,
    poolOptions,
    highlighterOptions,
  }: {
    children?: React.ReactNode;
    poolOptions: { poolSize: number; totalASTLRUCacheSize: number; workerFactory: () => Worker };
    highlighterOptions: { theme: string; tokenizeMaxLineLength: number; useTokenTransformer: boolean };
  }) => {
    mocks.providerProps({ poolOptions, highlighterOptions });
    return <div data-testid="diff-worker-provider">{children}</div>;
  },
  useWorkerPool: () => mocks.workerPool,
}));

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({
  default: mocks.MockDiffsWorker,
}));

describe('CodeAgentDiffWorkerPoolProvider', () => {
  afterEach(() => {
    document.documentElement.className = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('mirrors T3 worker pool options and syncs the resolved theme', async () => {
    document.documentElement.classList.add('dark');
    vi.stubGlobal('Worker', class MockWorker {});
    vi.stubGlobal('navigator', { hardwareConcurrency: 12 });

    render(
      <CodeAgentDiffWorkerPoolProvider>
        <span>diff content</span>
      </CodeAgentDiffWorkerPoolProvider>,
    );

    expect(screen.getByTestId('diff-worker-provider')).toBeTruthy();
    expect(screen.getByText('diff content')).toBeTruthy();

    const { poolOptions, highlighterOptions } = mocks.providerProps.mock.calls[0][0];
    expect(poolOptions.poolSize).toBe(6);
    expect(poolOptions.totalASTLRUCacheSize).toBe(240);
    expect(highlighterOptions).toMatchObject({
      theme: 'pierre-dark',
      tokenizeMaxLineLength: 1000,
      useTokenTransformer: true,
    });

    expect(poolOptions.workerFactory()).toEqual({});
    expect(mocks.MockDiffsWorker).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.workerPool.setRenderOptions).toHaveBeenCalledWith({
        theme: 'pierre-dark',
        tokenizeMaxLineLength: 100,
      });
    });
  });
});
