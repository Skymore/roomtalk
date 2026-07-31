import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CODE_AGENT_ACP_ARTIFACT_VERSION, availableCodeAgentBackends } from './codeAgentBackends';

describe('availableCodeAgentBackends', () => {
  it('only advertises harnesses whose runtime dependencies are configured', () => {
    assert.deepEqual(
      availableCodeAgentBackends({ codexEnabled: false, acpEnabled: false }),
      ['code-agent'],
    );
    assert.deepEqual(
      availableCodeAgentBackends({
        codexEnabled: true,
        acpEnabled: true,
        artifactVersion: CODE_AGENT_ACP_ARTIFACT_VERSION,
      }),
      ['code-agent', 'codex-app-server', 'codex', 'opencode', 'hermes-agent'],
    );
  });

  it('fails closed for ACP harnesses until the verified artifact is active', () => {
    assert.deepEqual(
      availableCodeAgentBackends({
        codexEnabled: true,
        acpEnabled: true,
        artifactVersion: 'roomtalk-code-agent-2026-07-31-multi-harness-v2',
      }),
      ['code-agent', 'codex-app-server', 'codex'],
    );
    assert.deepEqual(
      availableCodeAgentBackends({
        codexEnabled: false,
        acpEnabled: true,
        developmentArtifact: true,
      }),
      ['code-agent', 'opencode', 'hermes-agent'],
    );
  });
});
