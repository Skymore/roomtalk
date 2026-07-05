import dotenv from 'dotenv';
import { createClient, RedisClientType } from 'redis';
import { Readable } from 'stream';
import { Logger } from '../logger';
import { createPostgresPool } from '../repositories/postgresPool';
import { PostgresPool } from '../repositories/postgresStore';
import { Room } from '../types';
import { CocoSandboxHandle, CocoSandboxService } from '../services/cocoSandboxService';
import { DEFAULT_COCO_E2B_KILL_TIMEOUT_MS, DEFAULT_COCO_E2B_PAUSE_TIMEOUT_MS, DEFAULT_COCO_RUNNER_PYTHONPATH, DEFAULT_COCO_WORKSPACE_ROOT, resolveCodeAgentRuntimeConfig } from '../services/codeAgentRuntimeConfig';
import { E2BCocoSandboxService } from '../services/e2bCocoSandboxService';
import { createE2BSdkDriver } from '../services/e2bSdkDriver';

interface SandboxMigrationCandidate {
  roomId: string;
  creatorId: string;
  sandboxId: string;
  sandboxStatus?: string;
}

interface SandboxMigrationRoomIndex {
  listCandidates(roomId?: string, limit?: number): Promise<SandboxMigrationCandidate[]>;
  updateSandboxId(candidate: SandboxMigrationCandidate, nextSandboxId: string, updatedAt: string): Promise<boolean>;
  close(): Promise<void>;
}

type CodexSandboxMigrationPlan =
  | { run: false; reason: string }
  | {
    run: true;
    dryRun: boolean;
    roomId?: string;
    limit: number;
    destroyOld: boolean;
    maxArchiveBytes: number;
    archiveTimeoutMs: number;
    sandboxTtlMs: number;
    runnerEnv: Record<string, string>;
    persistenceStore: 'postgres' | 'redis';
    e2bTemplateId: string;
    e2bWorkspace?: string;
    artifactVersion?: string;
    cocoSourceRef?: string;
    e2bLifecycle: {
      onTimeout: 'kill' | 'pause';
      autoResume: boolean;
      keepMemory: boolean;
    };
    e2bConnection: {
      apiKey?: string;
      accessToken?: string;
      domain?: string;
      apiUrl?: string;
      sandboxUrl?: string;
      requestTimeoutMs: number;
    };
    redisUrl?: string;
    databaseUrl?: string;
  };

interface CodexProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
}

interface MigrationResult {
  roomId: string;
  oldSandboxId: string;
  status: 'already_ready' | 'would_migrate' | 'migrated' | 'failed';
  newSandboxId?: string;
  error?: string;
  archiveBytes?: number;
}

const CODEX_READY_MARKER = '__ROOMTALK_CODEX_READY__';
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const DEFAULT_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;

export const buildCodexSandboxMigrationPlan = (env: NodeJS.ProcessEnv): CodexSandboxMigrationPlan => {
  if (env.RUN_CODEX_SANDBOX_MIGRATION !== 'true') {
    return { run: false, reason: 'RUN_CODEX_SANDBOX_MIGRATION is not true' };
  }
  if (!env.COCO_E2B_TEMPLATE_ID) {
    return { run: false, reason: 'COCO_E2B_TEMPLATE_ID is not set' };
  }
  if (!env.E2B_API_KEY && !env.E2B_ACCESS_TOKEN) {
    return { run: false, reason: 'E2B_API_KEY or E2B_ACCESS_TOKEN is not set' };
  }

  const migrationEnv = {
    ...env,
    COCO_ENABLED: 'true',
    COCO_SANDBOX_PROVIDER: 'e2b',
    COCO_RUNNER_CLIENT: 'jsonl',
  };
  const config = resolveCodeAgentRuntimeConfig(migrationEnv);
  const persistenceStore = (env.PERSISTENCE_STORE || 'redis').toLowerCase();
  if (persistenceStore !== 'postgres' && persistenceStore !== 'redis') {
    return { run: false, reason: `Unsupported PERSISTENCE_STORE for migration: ${persistenceStore}` };
  }
  if (persistenceStore === 'postgres' && !env.DATABASE_URL) {
    return { run: false, reason: 'PERSISTENCE_STORE=postgres requires DATABASE_URL' };
  }

  const defaultSandboxTtlMs = config.e2bLifecycle.onTimeout === 'pause'
    ? DEFAULT_COCO_E2B_PAUSE_TIMEOUT_MS
    : DEFAULT_COCO_E2B_KILL_TIMEOUT_MS;

  return {
    run: true,
    dryRun: env.CODEX_SANDBOX_MIGRATION_DRY_RUN !== 'false',
    roomId: env.CODEX_SANDBOX_MIGRATION_ROOM_ID,
    limit: parsePositiveInteger(env.CODEX_SANDBOX_MIGRATION_LIMIT, DEFAULT_LIMIT),
    destroyOld: env.CODEX_SANDBOX_MIGRATION_DESTROY_OLD === 'true',
    maxArchiveBytes: parsePositiveInteger(env.CODEX_SANDBOX_MIGRATION_MAX_ARCHIVE_BYTES, DEFAULT_MAX_ARCHIVE_BYTES),
    archiveTimeoutMs: parsePositiveInteger(env.CODEX_SANDBOX_MIGRATION_ARCHIVE_TIMEOUT_MS, DEFAULT_ARCHIVE_TIMEOUT_MS),
    sandboxTtlMs: parsePositiveInteger(env.COCO_SANDBOX_TTL_MS, defaultSandboxTtlMs),
    runnerEnv: {
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: config.runnerEnv.PYTHONPATH || DEFAULT_COCO_RUNNER_PYTHONPATH,
      COCO_WORKSPACE_ROOT: config.runnerEnv.COCO_WORKSPACE_ROOT || config.e2bWorkspace || DEFAULT_COCO_WORKSPACE_ROOT,
    },
    persistenceStore,
    e2bTemplateId: config.e2bTemplateId || '',
    e2bWorkspace: config.e2bWorkspace,
    artifactVersion: config.artifactVersion,
    cocoSourceRef: config.cocoSourceRef,
    e2bLifecycle: config.e2bLifecycle,
    e2bConnection: {
      apiKey: env.E2B_API_KEY,
      accessToken: env.E2B_ACCESS_TOKEN,
      domain: env.E2B_DOMAIN,
      apiUrl: env.E2B_API_URL,
      sandboxUrl: env.E2B_SANDBOX_URL,
      requestTimeoutMs: parsePositiveInteger(env.E2B_REQUEST_TIMEOUT_MS, 60_000),
    },
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    databaseUrl: env.DATABASE_URL,
  };
};

export const runCodexSandboxMigration = async (
  plan: Extract<CodexSandboxMigrationPlan, { run: true }>,
  logger = new Logger('CodexSandboxMigration')
): Promise<MigrationResult[]> => {
  const roomIndex = await createRoomIndex(plan, logger);
  const sandboxService = new E2BCocoSandboxService(createE2BSdkDriver({
    apiKey: plan.e2bConnection.apiKey,
    accessToken: plan.e2bConnection.accessToken,
    domain: plan.e2bConnection.domain,
    apiUrl: plan.e2bConnection.apiUrl,
    sandboxUrl: plan.e2bConnection.sandboxUrl,
    requestTimeoutMs: plan.e2bConnection.requestTimeoutMs,
  }), {
    templateId: plan.e2bTemplateId,
    workspace: plan.e2bWorkspace,
    artifactVersion: plan.artifactVersion,
    cocoSourceRef: plan.cocoSourceRef,
    lifecycle: plan.e2bLifecycle,
    logger,
  });
  const results: MigrationResult[] = [];

  try {
    const candidates = await roomIndex.listCandidates(plan.roomId, plan.limit);
    logger.info('Loaded Codex sandbox migration candidates', {
      count: candidates.length,
      dryRun: plan.dryRun,
      roomId: plan.roomId,
    });

    for (const candidate of candidates) {
      const result = await migrateCandidate(candidate, plan, roomIndex, sandboxService, logger);
      results.push(result);
    }
    return results;
  } finally {
    await roomIndex.close();
  }
};

const migrateCandidate = async (
  candidate: SandboxMigrationCandidate,
  plan: Extract<CodexSandboxMigrationPlan, { run: true }>,
  roomIndex: SandboxMigrationRoomIndex,
  sandboxService: E2BCocoSandboxService,
  logger: Logger
): Promise<MigrationResult> => {
  let oldHandle: CocoSandboxHandle;
  try {
    oldHandle = await sandboxService.connect(candidate.sandboxId);
  } catch (error) {
    return failed(candidate, error);
  }

  const oldProbe = await probeCodexCapability(sandboxService, oldHandle, plan.runnerEnv, plan.artifactVersion);
  if (oldProbe.ok) {
    logger.info('Codex sandbox already supports dual-cli runner', { roomId: candidate.roomId, sandboxId: candidate.sandboxId });
    return { roomId: candidate.roomId, oldSandboxId: candidate.sandboxId, status: 'already_ready' };
  }
  if (plan.dryRun) {
    return {
      roomId: candidate.roomId,
      oldSandboxId: candidate.sandboxId,
      status: 'would_migrate',
      error: summarizeProbeFailure(oldProbe),
    };
  }
  if (!sandboxService.exportWorkspaceArchive || !sandboxService.importWorkspaceArchive) {
    return failed(candidate, new Error('Sandbox service does not support workspace archive migration'));
  }

  let newHandle: CocoSandboxHandle | undefined;
  try {
    const archive = await sandboxService.exportWorkspaceArchive(oldHandle, {
      maxBytes: plan.maxArchiveBytes,
      timeoutMs: plan.archiveTimeoutMs,
    });
    newHandle = await sandboxService.create({
      roomId: candidate.roomId,
      creatorId: candidate.creatorId,
      ttlMs: plan.sandboxTtlMs,
    });
    await sandboxService.importWorkspaceArchive(newHandle, archive, {
      timeoutMs: plan.archiveTimeoutMs,
    });

    const newProbe = await probeCodexCapability(sandboxService, newHandle, plan.runnerEnv, plan.artifactVersion);
    if (!newProbe.ok) {
      throw new Error(`New sandbox does not support Codex CLI: ${summarizeProbeFailure(newProbe)}`);
    }

    const updatedAt = new Date().toISOString();
    const updated = await roomIndex.updateSandboxId(candidate, newHandle.id, updatedAt);
    if (!updated) {
      throw new Error('Room sandboxId changed before migration update');
    }

    if (plan.destroyOld) {
      await sandboxService.destroy(candidate.sandboxId).catch(error => {
        logger.warn('Unable to destroy old sandbox after migration', { error, roomId: candidate.roomId, sandboxId: candidate.sandboxId });
      });
    }

    logger.info('Migrated Codex sandbox', {
      roomId: candidate.roomId,
      oldSandboxId: candidate.sandboxId,
      newSandboxId: newHandle.id,
      archiveBytes: archive.byteSize,
    });
    return {
      roomId: candidate.roomId,
      oldSandboxId: candidate.sandboxId,
      newSandboxId: newHandle.id,
      status: 'migrated',
      archiveBytes: archive.byteSize,
    };
  } catch (error) {
    if (newHandle) {
      await sandboxService.destroy(newHandle.id).catch(destroyError => {
        logger.warn('Unable to destroy failed migration sandbox', { error: destroyError, roomId: candidate.roomId, sandboxId: newHandle!.id });
      });
    }
    return failed(candidate, error);
  }
};

export const probeCodexCapability = async (
  sandboxService: Pick<CocoSandboxService, 'startRunner'>,
  handle: CocoSandboxHandle,
  runnerEnv: Record<string, string>,
  expectedArtifactVersion?: string
): Promise<CodexProbeResult> => {
  let process: Awaited<ReturnType<CocoSandboxService['startRunner']>> | undefined;
  try {
    process = await sandboxService.startRunner({
      handle,
      command: codexProbeCommand(expectedArtifactVersion),
      env: runnerEnv,
      timeoutMs: 30_000,
    });
    const stdoutPromise = collectReadableText(process.stdout, 64 * 1024);
    const stderrPromise = collectReadableText(process.stderr, 64 * 1024);
    const completed = process.completed ? await process.completed : { exitCode: 0 };
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      ok: completed.exitCode === 0 && stdout.includes(CODEX_READY_MARKER),
      stdout,
      stderr,
      exitCode: completed.exitCode,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    await process?.stop().catch(() => {});
  }
};

const codexProbeCommand = (expectedArtifactVersion?: string) => [
  'python - <<\'PY\'',
  'import importlib',
  'import json',
  'import os',
  'from pathlib import Path',
  'import shutil',
  'import subprocess',
  'import sys',
  'importlib.import_module("roomtalk_coco_runner.codex_cli")',
  'importlib.import_module("roomtalk_coco_runner.codex_app_server")',
  'importlib.import_module("roomtalk_coco_runner.codex_sdk_app_server")',
  'importlib.import_module("openai_codex")',
  'codex = shutil.which("codex")',
  'if not codex:',
  '    print("codex executable missing", file=sys.stderr)',
  '    raise SystemExit(42)',
  'result = subprocess.run([codex, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)',
  'if result.returncode != 0:',
  '    print((result.stderr or result.stdout).strip(), file=sys.stderr)',
  '    raise SystemExit(result.returncode)',
  `expected_artifact_version = ${JSON.stringify(expectedArtifactVersion || '')}`,
  'if expected_artifact_version:',
  '    artifact_version = os.environ.get("ROOMTALK_COCO_ARTIFACT_VERSION", "")',
  '    artifact_lock_path = Path("/opt/roomtalk-coco-artifact.lock.json")',
  '    if artifact_lock_path.exists():',
  '        try:',
  '            artifact_version = json.loads(artifact_lock_path.read_text()).get("artifactVersion") or artifact_version',
  '        except Exception as error:',
  '            print(f"unable to read artifact lock: {error}", file=sys.stderr)',
  '            raise SystemExit(43)',
  '    if artifact_version != expected_artifact_version:',
  '        observed = artifact_version or "missing"',
  '        print(f"artifact version mismatch: expected {expected_artifact_version}, got {observed}", file=sys.stderr)',
  '        raise SystemExit(44)',
  `print("${CODEX_READY_MARKER}")`,
  'PY',
].join('\n');

const createRoomIndex = async (
  plan: Extract<CodexSandboxMigrationPlan, { run: true }>,
  logger: Logger
): Promise<SandboxMigrationRoomIndex> => {
  if (plan.persistenceStore === 'postgres') {
    return new PostgresSandboxMigrationRoomIndex(createPostgresPool(plan.databaseUrl!, logger));
  }

  const redisClient: RedisClientType = createClient({ url: plan.redisUrl });
  await redisClient.connect();
  return new RedisSandboxMigrationRoomIndex(redisClient);
};

class PostgresSandboxMigrationRoomIndex implements SandboxMigrationRoomIndex {
  constructor(private readonly pool: PostgresPool) {}

  async listCandidates(roomId?: string, limit = DEFAULT_LIMIT): Promise<SandboxMigrationCandidate[]> {
    const result = await this.pool.query<{
      id: string;
      creator_id: string;
      sandbox_id: string;
      sandbox_status: string | null;
    }>(
      `SELECT id, creator_id, sandbox_id, sandbox_status
      FROM rooms
      WHERE type = 'coco'
        AND sandbox_id IS NOT NULL
        AND COALESCE(sandbox_status, 'none') <> 'creating'
        AND COALESCE(coco_status, 'idle') <> 'running'
        AND ($1::text IS NULL OR id = $1)
      ORDER BY updated_at DESC
      LIMIT $2`,
      [roomId || null, limit]
    );
    return result.rows.map(row => ({
      roomId: row.id,
      creatorId: row.creator_id,
      sandboxId: row.sandbox_id,
      sandboxStatus: row.sandbox_status || undefined,
    }));
  }

  async updateSandboxId(candidate: SandboxMigrationCandidate, nextSandboxId: string, updatedAt: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE rooms
      SET sandbox_id = $2,
        sandbox_status = 'ready',
        sandbox_updated_at = $3::timestamptz,
        room_version = room_version + 1,
        updated_at = NOW()
      WHERE id = $1
        AND sandbox_id = $4`,
      [candidate.roomId, nextSandboxId, updatedAt, candidate.sandboxId]
    );
    return result.rowCount === 1;
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

class RedisSandboxMigrationRoomIndex implements SandboxMigrationRoomIndex {
  constructor(private readonly redisClient: RedisClientType) {}

  async listCandidates(roomId?: string, limit = DEFAULT_LIMIT): Promise<SandboxMigrationCandidate[]> {
    const values = roomId
      ? [await this.redisClient.hGet('rooms', roomId)]
      : await this.redisClient.hVals('rooms');
    return values
      .map(value => parseRoom(value))
      .filter(isCodexSandboxMigrationCandidateRoom)
      .slice(0, limit)
      .map(room => ({
        roomId: room.id,
        creatorId: room.creatorId,
        sandboxId: room.sandboxId!,
        sandboxStatus: room.sandboxStatus,
      }));
  }

  async updateSandboxId(candidate: SandboxMigrationCandidate, nextSandboxId: string, updatedAt: string): Promise<boolean> {
    const value = await this.redisClient.hGet('rooms', candidate.roomId);
    const room = parseRoom(value);
    if (!room || room.sandboxId !== candidate.sandboxId) {
      return false;
    }
    await this.redisClient.hSet('rooms', candidate.roomId, JSON.stringify({
      ...room,
      sandboxId: nextSandboxId,
      sandboxStatus: 'ready',
      sandboxUpdatedAt: updatedAt,
      roomVersion: (room.roomVersion || 0) + 1,
      updatedAt,
    }));
    return true;
  }

  async close(): Promise<void> {
    await this.redisClient.quit();
  }
}

const parseRoom = (value: string | null | undefined): Room | null => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as Room;
  } catch {
    return null;
  }
};

export const isCodexSandboxMigrationCandidateRoom = (room: Room | null | undefined): room is Room & { sandboxId: string } => Boolean(
  room &&
  room.type === 'coco' &&
  room.sandboxId &&
  room.sandboxStatus !== 'creating' &&
  room.cocoStatus !== 'running'
);

const failed = (candidate: SandboxMigrationCandidate, error: unknown): MigrationResult => ({
  roomId: candidate.roomId,
  oldSandboxId: candidate.sandboxId,
  status: 'failed',
  error: error instanceof Error ? error.message : String(error),
});

const summarizeProbeFailure = (probe: CodexProbeResult) => (
  probe.stderr.trim() ||
  probe.stdout.trim() ||
  probe.error?.message ||
  `probe exited with ${probe.exitCode}`
);

const collectReadableText = async (stream: Readable | undefined, maxBytes: number): Promise<string> => {
  if (!stream) {
    return '';
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteSize = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', chunk => {
      if (byteSize >= maxBytes) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - byteSize;
      chunks.push(buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer);
      byteSize += buffer.byteLength;
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

if (require.main === module) {
  dotenv.config();
  const logger = new Logger('CodexSandboxMigration');
  let plan: CodexSandboxMigrationPlan;
  try {
    plan = buildCodexSandboxMigrationPlan(process.env);
  } catch (error) {
    logger.error('Codex sandbox migration config failed', { error });
    process.stderr.write(`Codex sandbox migration config failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!plan.run) {
    logger.warn('Codex sandbox migration skipped', { reason: plan.reason });
    process.stdout.write(`Codex sandbox migration skipped: ${plan.reason}\n`);
    process.exit(0);
  }

  const runPlan = plan;
  runCodexSandboxMigration(runPlan, logger)
    .then(results => {
      process.stdout.write(`${JSON.stringify({ dryRun: runPlan.dryRun, results }, null, 2)}\n`);
      process.exit(results.some(result => result.status === 'failed') ? 1 : 0);
    })
    .catch(error => {
      logger.error('Codex sandbox migration failed', { error });
      process.stderr.write(`Codex sandbox migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
