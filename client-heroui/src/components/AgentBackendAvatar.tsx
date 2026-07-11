import React from 'react';
import type { CodeAgentBackend } from '../utils/types';

const isCodexBackend = (backend: CodeAgentBackend) => (
  backend === 'codex' || backend === 'codex-app-server'
);

export const AgentBackendAvatar: React.FC<{
  backend: CodeAgentBackend;
  label: string;
}> = ({ backend, label }) => {
  const brand = isCodexBackend(backend) ? 'codex' : 'coco';

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
