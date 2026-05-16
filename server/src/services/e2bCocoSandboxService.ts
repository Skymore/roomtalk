import {
  CocoRunnerProcess,
  CocoSandboxHandle,
  CocoSandboxService,
  CreateCocoSandboxInput,
  StartCocoRunnerInput,
} from './cocoSandboxService';

export interface E2BSandboxDriverHandle {
  id: string;
  commands?: {
    run(command: string, options?: Record<string, unknown>): Promise<{ pid?: number; stop?(): Promise<void> }>;
  };
  kill?(): Promise<void>;
}

export interface E2BSandboxDriver {
  create(input: { templateId: string; timeoutMs: number; metadata: Record<string, string> }): Promise<E2BSandboxDriverHandle>;
  connect(sandboxId: string): Promise<E2BSandboxDriverHandle>;
}

export interface E2BCocoSandboxServiceOptions {
  templateId: string;
  workspace?: string;
}

export class E2BCocoSandboxService implements CocoSandboxService {
  constructor(
    private readonly driver: E2BSandboxDriver,
    private readonly options: E2BCocoSandboxServiceOptions,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!options.templateId) {
      throw new Error('E2B Coco sandbox templateId is required');
    }
  }

  async create(input: CreateCocoSandboxInput): Promise<CocoSandboxHandle> {
    const handle = await this.driver.create({
      templateId: this.options.templateId,
      timeoutMs: input.ttlMs,
      metadata: {
        roomId: input.roomId,
        creatorId: input.creatorId,
      },
    });
    const createdAt = this.now().toISOString();
    return {
      id: handle.id,
      provider: 'e2b',
      roomId: input.roomId,
      creatorId: input.creatorId,
      workspace: this.options.workspace || '/workspace',
      createdAt,
      expiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
    };
  }

  async connect(sandboxId: string): Promise<CocoSandboxHandle> {
    const handle = await this.driver.connect(sandboxId);
    const connectedAt = this.now().toISOString();
    return {
      id: handle.id,
      provider: 'e2b',
      roomId: '',
      creatorId: '',
      workspace: this.options.workspace || '/workspace',
      createdAt: connectedAt,
    };
  }

  async startRunner(input: StartCocoRunnerInput): Promise<CocoRunnerProcess> {
    const handle = await this.driver.connect(input.handle.id);
    if (!handle.commands?.run) {
      throw new Error('E2B sandbox driver handle does not support command execution');
    }
    const commandResult = await handle.commands.run(input.command);
    return {
      pid: commandResult?.pid,
      command: input.command,
      stop: async () => {
        await commandResult?.stop?.();
      },
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    const handle = await this.driver.connect(sandboxId);
    if (!handle.kill) {
      throw new Error('E2B sandbox driver handle does not support kill');
    }
    await handle.kill();
  }
}
