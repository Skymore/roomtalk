import type { CodeAgentBackend } from '../types';

export const CODE_AGENT_BACKENDS = [
  'code-agent',
  'codex',
  'codex-app-server',
  'opencode',
  'hermes-agent',
] as const satisfies readonly CodeAgentBackend[];

const CODE_AGENT_BACKEND_SET = new Set<string>(CODE_AGENT_BACKENDS);

export const isCodeAgentBackend = (value: unknown): value is CodeAgentBackend => (
  typeof value === 'string' && CODE_AGENT_BACKEND_SET.has(value)
);

export const isCodexCodeAgentBackend = (backend: CodeAgentBackend): boolean => (
  backend === 'codex' || backend === 'codex-app-server'
);

export const isAcpCodeAgentBackend = (backend: CodeAgentBackend): boolean => (
  backend === 'opencode' || backend === 'hermes-agent'
);

export const CODE_AGENT_ACP_ARTIFACT_VERSION = 'roomtalk-code-agent-2026-08-02-harness-lifecycle-v1';

export const availableCodeAgentBackends = ({
  codexEnabled,
  acpEnabled,
  artifactVersion,
  developmentArtifact = false,
}: {
  codexEnabled: boolean;
  acpEnabled: boolean;
  artifactVersion?: string;
  developmentArtifact?: boolean;
}): CodeAgentBackend[] => [
  'code-agent',
  ...(codexEnabled ? ['codex-app-server', 'codex'] as const : []),
  ...(acpEnabled && (developmentArtifact || artifactVersion === CODE_AGENT_ACP_ARTIFACT_VERSION)
    ? ['opencode', 'hermes-agent'] as const
    : []),
];

export const codeAgentBackendSupportsInterrupt = (backend: CodeAgentBackend): boolean => (
  backend === 'code-agent' || backend === 'codex-app-server' || isAcpCodeAgentBackend(backend)
);

export const codeAgentBackendSupportsSteer = (backend: CodeAgentBackend): boolean => (
  backend === 'code-agent' || backend === 'codex-app-server'
);

export const codeAgentBackendSupportsApprovals = (backend: CodeAgentBackend): boolean => (
  backend === 'code-agent' || backend === 'codex-app-server' || isAcpCodeAgentBackend(backend)
);

export const displayNameForCodeAgentBackend = (backend: CodeAgentBackend): string => {
  switch (backend) {
    case 'code-agent':
      return 'Coco';
    case 'codex':
    case 'codex-app-server':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'hermes-agent':
      return 'Hermes';
  }
};
