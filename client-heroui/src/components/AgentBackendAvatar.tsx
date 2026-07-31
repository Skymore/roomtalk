import React from 'react';
import { Icon } from '@iconify/react';
import type { CodeAgentBackend } from '../utils/types';

const isCodexBackend = (backend: CodeAgentBackend) => (
  backend === 'codex' || backend === 'codex-app-server'
);

export const AgentBackendAvatar: React.FC<{
  backend: CodeAgentBackend;
  label: string;
}> = ({ backend, label }) => {
  const brand = isCodexBackend(backend)
    ? 'codex'
    : backend === 'opencode'
      ? 'opencode'
      : backend === 'hermes-agent'
        ? 'hermes'
        : 'coco';

  if (backend === 'opencode' || backend === 'hermes-agent') {
    return (
      <div
        role="img"
        aria-label={label}
        data-testid="turn-avatar"
        data-agent-brand={brand}
        className={`absolute left-0 top-0 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] ${
          backend === 'opencode'
            ? 'bg-[#e7f0ff] text-[#275d9b] dark:bg-[#1f3147] dark:text-[#9fc5f5]'
            : 'bg-[#f3e9ff] text-[#7343a5] dark:bg-[#352646] dark:text-[#d1a7ff]'
        }`}
      >
        <Icon icon={backend === 'opencode' ? 'lucide:braces' : 'lucide:bot'} className="h-4.5 w-4.5" />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      data-testid="turn-avatar"
      data-agent-brand={brand}
      className="absolute left-0 top-0 h-8 w-8 flex-shrink-0 overflow-hidden rounded-[10px]"
    >
      <img
        src={`/agent-icons/${brand}-light.${brand === 'codex' ? 'png' : 'svg'}`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-full w-full object-contain dark:hidden"
      />
      <img
        src={`/agent-icons/${brand}-dark.${brand === 'codex' ? 'png' : 'svg'}`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="hidden h-full w-full object-contain dark:block"
      />
    </div>
  );
};
