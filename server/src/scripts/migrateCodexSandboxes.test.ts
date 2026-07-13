import assert from 'assert/strict';
import { Readable } from 'stream';
import { describe, it } from 'node:test';
import { buildCodexSandboxMigrationPlan, isCodexSandboxMigrationCandidateRoom, probeCodexCapability } from './migrateCodexSandboxes';
import { CodeAgentSandboxHandle, CodeAgentSandboxService } from '../services/codeAgentSandboxService';
import { Room } from '../types';

const baseEnv = {
  RUN_CODEX_SANDBOX_MIGRATION: 'true',
  E2B_API_KEY: 'e2b-test-key',
  CODE_AGENT_E2B_TEMPLATE_ID: 'roomtalk-code-agent-dual-cli',
  CODE_AGENT_ARTIFACT_VERSION: 'roomtalk-code-agent-2026-07-04-dual-cli-candidate',
  CODE_AGENT_SOURCE_REF: 'a4e70e674e46d59a63874371276f5fec0fcd3f41',
  CODE_AGENT_SANDBOX_PROVIDER: 'e2b',
  CODE_AGENT_RUNNER_CLIENT: 'jsonl',
  CODEX_CLI_BACKEND_ENABLED: 'true',
} as const;

const handle: CodeAgentSandboxHandle = {
  id: 'sandbox-1',
  provider: 'e2b',
  roomId: 'room-1',
  creatorId: 'client-1',
  workspace: '/workspace',
  createdAt: '2026-05-03T00:00:00.000Z',
};

describe('buildCodexSandboxMigrationPlan', () => {
  it('skips unless explicitly enabled', () => {
    assert.deepEqual(buildCodexSandboxMigrationPlan({}), {
      run: false,
      reason: 'RUN_CODEX_SANDBOX_MIGRATION is not true',
    });
  });

  it('builds a dry-run migration plan by default', () => {
    const plan = buildCodexSandboxMigrationPlan(baseEnv);
    assert.equal(plan.run, true);
    if (!plan.run) return;
    assert.equal(plan.dryRun, true);
    assert.equal(plan.persistenceStore, 'redis');
    assert.equal(plan.e2bTemplateId, 'roomtalk-code-agent-dual-cli');
    assert.equal(plan.runnerEnv.PYTHONPATH, '/opt/code-agent-engine/src:/opt/roomtalk_code_agent_runner');
    assert.equal(plan.runnerEnv.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright');
    assert.equal(plan.runnerEnv.NODE_PATH, '/usr/lib/node_modules');
  });

  it('requires DATABASE_URL for postgres migration state', () => {
    assert.deepEqual(buildCodexSandboxMigrationPlan({
      ...baseEnv,
      PERSISTENCE_STORE: 'postgres',
    }), {
      run: false,
      reason: 'PERSISTENCE_STORE=postgres requires DATABASE_URL',
    });
  });
});

describe('isCodexSandboxMigrationCandidateRoom', () => {
  const room: Room = {
    id: 'room-1',
    name: 'Code room',
    description: '',
    createdAt: '2026-05-03T00:00:00.000Z',
    creatorId: 'client-1',
    type: 'codeAgent',
    sandboxId: 'sandbox-1',
    sandboxStatus: 'ready',
    codeAgentStatus: 'idle',
  };

  it('includes paused or expired sandboxes with no active runner', () => {
    assert.equal(isCodexSandboxMigrationCandidateRoom(room), true);
    assert.equal(isCodexSandboxMigrationCandidateRoom({
      ...room,
      sandboxStatus: 'expired',
    }), true);
    assert.equal(isCodexSandboxMigrationCandidateRoom({
      ...room,
      sandboxStatus: undefined,
    }), true);
  });

  it('excludes rooms that are creating, running, missing a sandbox, or not code-agent rooms', () => {
    assert.equal(isCodexSandboxMigrationCandidateRoom({ ...room, sandboxStatus: 'creating' }), false);
    assert.equal(isCodexSandboxMigrationCandidateRoom({ ...room, codeAgentStatus: 'running' }), false);
    assert.equal(isCodexSandboxMigrationCandidateRoom({ ...room, sandboxId: undefined }), false);
    assert.equal(isCodexSandboxMigrationCandidateRoom({ ...room, type: 'chat' }), false);
  });
});

describe('probeCodexCapability', () => {
  it('accepts sandboxes with importable runner and codex executable', async () => {
    const service = createProbeService('__ROOMTALK_CODEX_READY__\n', '', 0);

    const result = await probeCodexCapability(service, handle, { PYTHONPATH: '/runner' });

    assert.equal(result.ok, true);
    assert.match(service.commands[0], /roomtalk_code_agent_runner\.codex_cli/);
    assert.match(service.commands[0], /roomtalk_code_agent_runner\.codex_app_server/);
    assert.match(service.commands[0], /openai_codex/);
  });

  it('checks the sandbox artifact version when an expected version is provided', async () => {
    const service = createProbeService('__ROOMTALK_CODEX_READY__\n', '', 0);

    const result = await probeCodexCapability(
      service,
      handle,
      { PYTHONPATH: '/runner' },
      'roomtalk-code-agent-2026-07-04-codex-app-server-v2'
    );

    assert.equal(result.ok, true);
    assert.match(service.commands[0], /expected_artifact_version = "roomtalk-code-agent-2026-07-04-codex-app-server-v2"/);
    assert.match(service.commands[0], /roomtalk-code-agent-artifact\.lock\.json/);
  });

  it('rejects sandboxes missing the codex runner module', async () => {
    const service = createProbeService('', '/usr/local/bin/python: No module named roomtalk_code_agent_runner.codex_app_server\n', 1);

    const result = await probeCodexCapability(service, handle, { PYTHONPATH: '/runner' });

    assert.equal(result.ok, false);
    assert.match(result.stderr, /No module named/);
  });

  it('rejects sandboxes with an older artifact version', async () => {
    const service = createProbeService(
      '',
      'artifact version mismatch: expected roomtalk-code-agent-2026-07-04-codex-app-server-v2, got roomtalk-code-agent-2026-07-04-dual-cli-candidate\n',
      44
    );

    const result = await probeCodexCapability(
      service,
      handle,
      { PYTHONPATH: '/runner' },
      'roomtalk-code-agent-2026-07-04-codex-app-server-v2'
    );

    assert.equal(result.ok, false);
    assert.match(result.stderr, /artifact version mismatch/);
  });
});

const createProbeService = (stdoutText: string, stderrText: string, exitCode: number) => {
  const commands: string[] = [];
  const service: Pick<CodeAgentSandboxService, 'startRunner'> & { commands: string[] } = {
    commands,
    async startRunner(input) {
      commands.push(input.command);
      return {
        command: input.command,
        stdout: Readable.from([stdoutText]),
        stderr: Readable.from([stderrText]),
        completed: Promise.resolve({ exitCode, signal: null }),
        stop: async () => {},
      };
    },
  };
  return service;
};
