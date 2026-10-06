import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { PersonalAgentIdeaConflictError, RoomStore } from '../repositories/store';
import { AIModelOption, CodeAgentMode, PersonalAgentGoal, Room, Message, PersonalAgentNotification } from '../types';
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
  onNotification?:(notice:PersonalAgentNotification)=>Promise<void>;
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

  async delegate(clientId:string,input:{kind:'plan'|'document'|'finance'|'agent';prompt:string;title?:string;goalId?:string;input:{csv?:string;messageId?:string}}):Promise<{room:Room}>{
    const instruction=[input.prompt,'',`This is a delegated ${input.kind} task. Read roomtalk task get --json for the persisted task input.`,
      input.kind==='finance'?'Use the complete imported CSV from task.input.csv. Save a finance result from those actual rows; do not invent transactions.':
      input.kind==='document'?'Read the chosen email with roomtalk google message --id <task.input.messageId> --json, import the actual PDF, ask for missing personal details, and prepare the filled copy and reply for review.':
      'Save a practical plan and reusable result for the requested outcome.'].join('\n');
    const {room,message}=await this.prepareTask(clientId,input.title ?? input.prompt.slice(0,100),instruction,input.goalId);
    const saved=await this.store.startPersonalAgentTask!({roomId:room.id,clientId,kind:input.kind,prompt:input.prompt,input:input.input,createdAt:message.timestamp},room,message);
    await this.wakeTask(saved);return {room:saved};
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
    const reviews=await this.store.readPersonalAgentReviewContinuations?.() || [];
    for(const review of reviews){
      const content=`The reviewed action ${review.id} is ${review.data.status}. ${review.data.result || review.data.error || 'No external action was taken.'} Read roomtalk google actions --json for its saved receipt. Continue the saved task from this outcome. Do not execute this reviewed action again; an uncertain outcome must be reconciled by the user before another attempt.`;
      const message=this.createQueuedMessage(review.clientId,String(review.data.sourceRoomId),content);
      const room=await this.store.continuePersonalAgentReview!(review,message);
      if(room)await this.options.onRunQueued?.(room);
      else if(this.options.onNotification){const notice=await this.store.readPersonalAgentNotification!(review.clientId,`review:${review.id}`);if(notice)await this.options.onNotification(notice);}
    }
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
    return {room,message:this.createQueuedMessage(clientId,room.id,prompt)};
  }
  createQueuedMessage(clientId:string,roomId:string,prompt:string):Message {
    const now=this.now();
    const settings=normalizeCodexRunSettings(this.options.codexRunSettings?.model,this.options.codexRunSettings?.reasoningEffort,'fullAccess',this.options.codexRunSettings?.serviceTier);
    return {
      ...createUserMessage({id:this.createId(),clientId,roomId,content:prompt,now}),
      codeAgentQueuedInput:{state:'queued',queuedAt:now.toISOString(),updatedAt:now.toISOString(),selectedModel:this.options.selectedModel,
        codexModel:settings.model,codexReasoningEffort:settings.reasoningEffort,codexPermissionMode:settings.permissionMode,codexServiceTier:settings.serviceTier,
        requestedMode:'fullAccess',serverOrigin:this.options.serverOrigin},
    };
  }
  async wakeTask(room: Room) {
    try {
      await this.options.onRunQueued?.(room);
      await this.sessions.resumeQueuedTurns();
    } catch (error) {
      this.logger.warn('Personal agent task saved; queue wake will retry', { error, roomId: room.id });
    }
  }

}
