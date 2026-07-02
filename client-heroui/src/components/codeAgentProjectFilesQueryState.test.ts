import { afterEach, describe, expect, it } from 'vitest';
import type { CodeWorkspaceFile } from '../utils/codeWorkspaceFiles';
import {
  clearCodeAgentProjectFileQueryData,
  confirmCodeAgentProjectFileQueryData,
  getOptimisticCodeAgentProjectFileQueryData,
  resetCodeAgentProjectFilesQueryStateForTests,
  resolveCodeAgentProjectFileQueryData,
  setCodeAgentProjectFileQueryData,
  settleConfirmedCodeAgentProjectFileQueryData,
} from './codeAgentProjectFilesQueryState';

describe('codeAgentProjectFilesQueryState', () => {
  afterEach(() => {
    resetCodeAgentProjectFilesQueryStateForTests();
  });

  it('keeps the latest optimistic draft when an older write finishes', () => {
    const initial = {
      path: 'src/App.tsx',
      content: 'export default function App() {}',
      byteSize: 32,
      truncated: false,
      encoding: 'utf-8',
    } satisfies CodeWorkspaceFile;

    setCodeAgentProjectFileQueryData('room-1', '/workspace/src/App.tsx', 'export const stale = true;');
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const latest = true;');

    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const latest = true;',
    );
    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const stale = true;')).toBe(false);
    expect(resolveCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', initial)).toEqual({
      path: 'src/App.tsx',
      content: 'export const latest = true;',
      byteSize: 27,
      truncated: false,
      encoding: 'utf-8',
    });
    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const latest = true;')).toBe(true);
  });

  it('keeps confirmed optimistic data until a refreshed read catches up', async () => {
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const saved = true;');

    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const saved = true;')).toBe(true);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const saved = true;',
    );

    await Promise.resolve();

    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const saved = true;',
    );
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: 'export const stale = true;',
      byteSize: 26,
      truncated: false,
      encoding: 'utf-8',
    })).toBe(false);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const saved = true;',
    );
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: 'export const saved = true;',
      byteSize: 26,
      truncated: false,
      encoding: 'utf-8',
    })).toBe(true);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')).toBeNull();
  });

  it('does not clear confirmed optimistic data from a refreshed read for another path', () => {
    const savedContents = 'export const saved = true;';
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', savedContents);

    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', savedContents)).toBe(true);
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/Other.tsx',
      content: savedContents,
      byteSize: 26,
      truncated: false,
      encoding: 'utf-8',
    })).toBe(false);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(savedContents);

    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: savedContents,
      byteSize: 26,
      truncated: false,
      encoding: 'utf-8',
    })).toBe(true);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')).toBeNull();
  });

  it('does not clear confirmed optimistic data from truncated or non-utf8 refreshed reads', () => {
    const savedContents = 'export const saved = true;';
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', savedContents);

    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', savedContents)).toBe(true);
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: savedContents,
      byteSize: 26,
      truncated: true,
      encoding: 'utf-8',
    })).toBe(false);
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: savedContents,
      byteSize: 26,
      truncated: false,
      encoding: 'base64',
    })).toBe(false);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(savedContents);
  });

  it('does not clear a newer optimistic draft after an older confirmation refreshes', async () => {
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const saved = true;');

    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const saved = true;')).toBe(true);
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'export const newer = true;');

    await Promise.resolve();
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: 'export const saved = true;',
      byteSize: 26,
      truncated: false,
      encoding: 'utf-8',
    })).toBe(false);

    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')?.content).toBe(
      'export const newer = true;',
    );
  });

  it('clears optimistic file data by room and path', () => {
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'room 1');
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'room 1 scoped', 'ready:1');
    setCodeAgentProjectFileQueryData('room-2', 'src/App.tsx', 'room 2');

    clearCodeAgentProjectFileQueryData('room-1', 'src/App.tsx');

    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx')).toBeNull();
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'ready:1')).toBeNull();
    expect(getOptimisticCodeAgentProjectFileQueryData('room-2', 'src/App.tsx')?.content).toBe('room 2');
  });

  it('scopes optimistic file data by workspace refresh key', () => {
    const initial = {
      path: 'src/App.tsx',
      content: 'server content',
      byteSize: 14,
      truncated: false,
      encoding: 'utf-8',
    } satisfies CodeWorkspaceFile;

    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'old workspace edit', 'ready:old');
    setCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'new workspace edit', 'ready:new');

    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'ready:old')?.content).toBe(
      'old workspace edit',
    );
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'ready:new')?.content).toBe(
      'new workspace edit',
    );
    expect(resolveCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', initial, 'ready:missing')).toBe(initial);
    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'old workspace edit', null, 'ready:new')).toBe(false);
    expect(confirmCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'old workspace edit', null, 'ready:old')).toBe(true);
    expect(settleConfirmedCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', {
      path: 'src/App.tsx',
      content: 'old workspace edit',
      byteSize: 18,
      truncated: false,
      encoding: 'utf-8',
    }, 'ready:new')).toBe(false);
    expect(getOptimisticCodeAgentProjectFileQueryData('room-1', 'src/App.tsx', 'ready:old')?.content).toBe(
      'old workspace edit',
    );
  });
});
