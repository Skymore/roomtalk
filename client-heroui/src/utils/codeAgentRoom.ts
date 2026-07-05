import { RoomCodeAgentStatus, RoomSandboxStatus } from './types';

const sandboxStatusLabelKeys: Record<RoomSandboxStatus, string> = {
  none: 'sandboxStatusNone',
  creating: 'sandboxStatusCreating',
  ready: 'sandboxStatusReady',
  expired: 'sandboxStatusExpired',
  error: 'sandboxStatusError',
};

const codeAgentStatusLabelKeys: Record<RoomCodeAgentStatus, string> = {
  idle: 'codeAgentStatusIdle',
  running: 'codeAgentStatusRunning',
  error: 'codeAgentStatusError',
};

export const getSandboxStatusLabelKey = (status: RoomSandboxStatus | undefined): string => (
  sandboxStatusLabelKeys[status || 'none']
);

export const getCodeAgentStatusLabelKey = (status: RoomCodeAgentStatus | undefined): string => (
  codeAgentStatusLabelKeys[status || 'idle']
);

export const getSandboxStatusClassName = (status: RoomSandboxStatus | undefined): string => {
  if (status === 'error') {
    return 'border-danger-400/50 bg-danger-500/10 text-danger-600 dark:text-danger-300';
  }

  if (status === 'creating' || status === 'expired') {
    return 'border-warning-400/50 bg-warning-500/10 text-warning-700 dark:text-warning-300';
  }

  if (status === 'ready') {
    return 'border-success-400/50 bg-success-500/10 text-success-700 dark:text-success-300';
  }

  return 'border-[#dedbd0] bg-[#e8e6dc] text-[#5e5d59] dark:border-[#30302e] dark:bg-[#30302e] dark:text-[#b0aea5]';
};

export const getCodeAgentStatusClassName = (status: RoomCodeAgentStatus | undefined): string => {
  if (status === 'error') {
    return 'border-danger-400/50 bg-danger-500/10 text-danger-600 dark:text-danger-300';
  }

  if (status === 'running') {
    return 'border-warning-400/50 bg-warning-500/10 text-warning-700 dark:text-warning-300';
  }

  return 'border-[#dedbd0] bg-[#e8e6dc] text-[#5e5d59] dark:border-[#30302e] dark:bg-[#30302e] dark:text-[#b0aea5]';
};
