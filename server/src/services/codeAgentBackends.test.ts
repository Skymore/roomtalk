import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CODE_AGENT_ACP_ARTIFACT_VERSION, availableCodeAgentBackends } from './codeAgentBackends';

describe('availableCodeAgentBackends', () => {
  it('keeps the verified ACP version aligned with the published artifact lock', () => {
    const lock = JSON.parse(readFileSync(path.resolve(__dirname, '../../../ops/code-agent-sandbox/artifact.lock.json'), 'utf8'));
    assert.equal(CODE_AGENT_ACP_ARTIFACT_VERSION, lock.artifactVersion);
  });

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
