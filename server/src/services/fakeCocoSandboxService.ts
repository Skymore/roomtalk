import { randomUUID } from 'crypto';
import {
  CocoRunnerProcess,
  CocoSandboxHandle,
  CocoSandboxService,
  CreateCocoSandboxInput,
  StartCocoRunnerInput,
} from './cocoSandboxService';

type FakeSandboxFailure = 'create' | 'connect' | 'startRunner' | 'destroy';

export class FakeCocoSandboxService implements CocoSandboxService {
  private readonly sandboxes = new Map<string, CocoSandboxHandle>();
  private readonly failures = new Set<FakeSandboxFailure>();
  readonly destroyedSandboxIds: string[] = [];
  readonly startedRunnerCommands: string[] = [];
  readonly startedRunnerEnvs: Record<string, string>[] = [];
  readonly stoppedRunnerCommands: string[] = [];
  private readonly workspaceFilesBySandboxId = new Map<string, string[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  failNext(operation: FakeSandboxFailure) {
    this.failures.add(operation);
  }

  private consumeFailure(operation: FakeSandboxFailure) {
    if (!this.failures.has(operation)) {
      return;
    }
    this.failures.delete(operation);
    throw new Error(`Fake Coco sandbox ${operation} failed`);
  }

  async create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle> {
    this.consumeFailure('create');
    const createdAt = this.now().toISOString();
    const handle: CocoSandboxHandle = {
      id: `fake-sandbox-${randomUUID()}`,
      provider: 'fake',
      roomId: input.roomId,
      creatorId: input.creatorId,
      workspace: `/workspace/${input.roomId}`,
      createdAt,
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
    this.sandboxes.set(handle.id, handle);
    this.workspaceFilesBySandboxId.set(handle.id, []);
    return handle;
  }

  async connect(sandboxId: string): Promise<CocoSandboxHandle> {
    this.consumeFailure('connect');
    const handle = this.sandboxes.get(sandboxId);
    if (!handle) {
      throw new Error(`Fake Coco sandbox not found: ${sandboxId}`);
    }
    return handle;
  }

  async startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess> {
    this.consumeFailure('startRunner');
    this.startedRunnerCommands.push(input.command);
    this.startedRunnerEnvs.push({ ...(input.env || {}) });
    return {
      command: input.command,
      stop: async () => {
        this.stoppedRunnerCommands.push(input.command);
      },
    };
  }

  setWorkspaceFiles(sandboxId: string, files: string[]) {
    this.workspaceFilesBySandboxId.set(sandboxId, files);
  }

  async listWorkspaceFiles(handle: CocoSandboxHandle): Promise<string[]> {
    this.consumeFailure('connect');
    if (!this.sandboxes.has(handle.id)) {
      throw new Error(`Fake Coco sandbox not found: ${handle.id}`);
    }
    return [...(this.workspaceFilesBySandboxId.get(handle.id) || [])].sort((a, b) => a.localeCompare(b));
  }

  async destroy(sandboxId: string): Promise<void> {
    this.consumeFailure('destroy');
    this.destroyedSandboxIds.push(sandboxId);
    this.sandboxes.delete(sandboxId);
    this.workspaceFilesBySandboxId.delete(sandboxId);
  }

  async countActiveSandboxes(): Promise<number> {
    return this.sandboxes.size;
  }

  async countActiveSandboxesForUser(creatorId: string): Promise<number> {
    return [...this.sandboxes.values()].filter(handle => handle.creatorId === creatorId).length;
  }
}
