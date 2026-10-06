import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { AIModelOption, CodeAgentMode, PersonalAgentGoal, Room } from '../types';
import { CodeAgentSessionService } from './codeAgentSessionService';
import { CodexRunSettings, normalizeCodexRunSettings } from './codexRunSettings';
import { createRoomRecord, createUserMessage } from './messageDomain';
import { nextPersonalAgentGoalRunAt } from './personalAgentSchedule';

export interface PersonalAgentSchedulerOptions {
  selectedModel: AIModelOption;
  codexRunSettings?: CodexRunSettings;
  mode?: CodeAgentMode;
  serverOrigin?: string;
  pollIntervalMs?: number;
  now?: () => Date;
  createId?: () => string;
  onRunQueued?: (room: Room) => Promise<void> | void;
}

export class PersonalAgentScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private tickPromise?: Promise<void>;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly store: RoomStore,
    private readonly sessions: Pick<CodeAgentSessionService, 'resumeQueuedTurns'>,
    private readonly logger: Logger,
    private readonly options: PersonalAgentSchedulerOptions,
  ) {
    this.now = options.now || (() => new Date());
    this.createId = options.createId || randomUUID;
  }

  start(): void {
    if (this.timer) return;
    const run = () => void this.tick().catch(error => this.logger.error('Personal agent scheduler tick failed', { error }));
    this.timer = setInterval(run, this.options.pollIntervalMs || 60_000);
    this.timer.unref?.();
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPromise;
  }

  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runTick().finally(() => { this.tickPromise = undefined; });
    return this.tickPromise;
  }

  async startGoal(goal: PersonalAgentGoal): Promise<{ room: Room }> {
    const result = await this.queueGoal(goal);
    if (!result) throw new Error('Personal agent goal no longer exists');
    return result;
  }

  async acceptIdea(clientId: string, id: string, prompt: string, expectedUpdatedAt: string) {
    const idea = (await this.store.readPersonalAgentIdeas!(clientId,{id,limit:1})).ideas[0];
    if (!idea) throw new PersonalAgentIdeaConflictError('Suggestion not found');
    const {room,message} = await this.prepareTask(clientId,idea.title,prompt);
    const saved = await this.store.acceptPersonalAgentIdea!({clientId,id,expectedUpdatedAt,room,message});
    if (!saved) throw new PersonalAgentIdeaConflictError('The suggestion or its source changed. Read it again before accepting.');
    await this.wakeTask(saved.room);
    return saved;
  }

  private async runTick(): Promise<void> {
    // This also recovers a committed prompt when the prior App died before it
    // could wake the code-agent queue. Execution itself owns the existing lease.
    await this.sessions.resumeQueuedTurns();
    const goals = await this.store.readDuePersonalAgentGoals?.(this.now().toISOString(), 20) || [];
    for (const goal of goals) {
      try {
        if (goal.nextRunAt) await this.queueGoal(goal, goal.nextRunAt);
      } catch (error) {
        this.logger.error('Failed to queue personal agent routine', { error, goalId: goal.id, clientId: goal.clientId });
      }
    }
  }

  private async queueGoal(goal: PersonalAgentGoal, expectedNextRunAt?: string): Promise<{ room: Room } | null> {
    if (!this.store.startPersonalAgentGoalRun) throw new Error('Durable personal agent scheduling is unavailable');
    const {room,message} = await this.prepareTask(goal.clientId,goal.title,goal.prompt,goal.id);
    const result = await this.store.startPersonalAgentGoalRun({
      clientId: goal.clientId, goalId: goal.id, room, message,
      nextRunAt: nextPersonalAgentGoalRunAt(goal, new Date(message.timestamp)),
      ...(expectedNextRunAt ? { expectedNextRunAt } : {}),
    });
    if (!result) return null;
    // Queue admission has already committed. A wake/notification failure must
    // not make the API caller retry an admitted task; the next tick recovers it.
    await this.wakeTask(result.room);
    return { room: result.room };
  }
  private async prepareTask(clientId: string, title: string, prompt: string, goalId?: string) {
    const profile = await this.store.getPersonalAgentProfile?.(clientId);
    if (!profile) throw new Error('Personal agent profile not found');
    const mainRoom = await this.store.getRoomById(profile.mainRoomId);
    if (!mainRoom || mainRoom.personalAgentOwnerId !== clientId) throw new Error('Personal agent workspace not found');
    const now = this.now();
    const room: Room = {
      ...createRoomRecord({
        roomId: this.createId(), name: title, creatorId: clientId,
        type: 'codeAgent', codeAgentBackend: mainRoom.codeAgentBackend || 'codex-app-server', now,
      }),
      personalAgentOwnerId: clientId,
      personalAgentThreadKind: 'task',
      ...(goalId ? { personalAgentGoalId: goalId } : {}),
      codeAgentAccess: 'owner',
      codeAgentMode: 'fullAccess',
    };
    const settings = normalizeCodexRunSettings(
      this.options.codexRunSettings?.model, this.options.codexRunSettings?.reasoningEffort,
      'fullAccess', this.options.codexRunSettings?.serviceTier,
    );
    const message = {
      ...createUserMessage({ id: this.createId(), clientId: clientId, roomId: room.id, content: prompt, now }),
      codeAgentQueuedInput: {
        state: 'queued' as const, queuedAt: now.toISOString(), updatedAt: now.toISOString(),
        selectedModel: this.options.selectedModel,
        codexModel: settings.model, codexReasoningEffort: settings.reasoningEffort,
        codexPermissionMode: settings.permissionMode, codexServiceTier: settings.serviceTier,
        requestedMode: room.codeAgentMode, serverOrigin: this.options.serverOrigin,
      },
    };
    return {room,message};
  }
  private async wakeTask(room: Room) {
    try {
      await this.options.onRunQueued?.(room);
      await this.sessions.resumeQueuedTurns();
    } catch (error) {
      this.logger.warn('Personal agent task saved; queue wake will retry', { error, roomId: room.id });
    }
  }

}
