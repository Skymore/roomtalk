import { randomUUID } from 'node:crypto';
import { RoomStore,PersonalAgentTaskControlError } from '../repositories/store';
import { PersonalAgentInputRequest,Message,Room } from '../types';
import { z } from 'openmuse-zod';
import { analyzeSpending } from './personalAgentFinance';
import { PersonalAgentTrackingService,personalWatchMetadata } from './personalAgentTracking';
import {personalBrowserMetadata} from './personalAgentBrowser';
import {personalFileMetadata} from './personalAgentFiles';
import { PersonalAgentGoogleService } from './personalAgentGoogle';
const delegationSchema=z.object({kind:z.enum(['plan','document','finance','agent']).default('agent'),title:z.string().trim().min(1).max(160).optional(),goalId:z.string().min(1).max(100).optional(),prompt:z.string().trim().min(1).max(12000),input:z.object({csv:z.string().max(500000).optional(),messageId:z.string().max(1024).optional()}).default({})});
export const PERSONAL_TASK_API_PATH='/api/code-agent/room-context/personal-task';
export class PersonalAgentTaskError extends Error { constructor(message:string,readonly statusCode:number){super(message);} }
const metadata=({clientId:_owner,...request}:PersonalAgentInputRequest)=>request;
export class PersonalAgentTaskService {
  constructor(private readonly store:RoomStore,private readonly continuation?:{create:(clientId:string,roomId:string,content:string)=>Message;wake:(room:Room)=>Promise<void>;interrupt?:(roomId:string,clientId:string)=>Promise<unknown>;delegate?:(clientId:string,input:z.infer<typeof delegationSchema>)=>Promise<{room:Room}>;google?:Pick<PersonalAgentGoogleService,'message'>;tracking?:Pick<PersonalAgentTrackingService,'control'>}){}
  private async room(clientId:string,roomId:string){
    const room=await this.store.getRoomById(roomId);
    if(!room || room.creatorId!==clientId || room.personalAgentOwnerId!==clientId)throw new PersonalAgentTaskError('Task not found',404);
    return room;
  }
  async list(clientId:string){
    const rooms=await this.store.readPersonalAgentRooms!(clientId);
    return {tasks:rooms.filter(room=>room.personalAgentTaskKind || room.personalAgentGoalId)};
  }
  async delegate(clientId:string,input:unknown){
    if(!this.continuation?.delegate)throw new PersonalAgentTaskError('Task execution is unavailable',503);
    const value=delegationSchema.parse(input);
    if(value.kind==='finance'){
      if(!value.input.csv)throw new RangeError('Choose transaction CSV');
      try{analyzeSpending(value.input.csv);}catch(error){throw new RangeError(error instanceof Error?error.message:'Invalid transaction CSV');}
    }
    if(value.kind==='document'){
      if(!value.input.messageId)throw new RangeError('Choose the email with the PDF');
      if(!this.continuation.google)throw new PersonalAgentTaskError('Google is unavailable',503);
      const message=(await this.continuation.google.message(clientId,value.input.messageId)).mail;
      if(!message.attachments.length)throw new RangeError('Choose an email with a PDF attachment');
    }
    return this.continuation.delegate(clientId,value);
  }
  async detail(clientId:string,roomId:string,beforeMessageId?:unknown){
    if(beforeMessageId!==undefined && (typeof beforeMessageId!=='string' || !beforeMessageId || beforeMessageId.length>100))throw new RangeError('Invalid task history page');
    const room=await this.room(clientId,roomId);
    const watch=(await this.store.readPersonalAgentWatches!(clientId,{roomId,limit:1})).watches[0];
    if(watch){
      room.personalAgentTaskKind='monitor';
      room.personalAgentTaskStatus=watch.status==='active'?'scheduled':watch.status==='paused'?'paused':'cancelled';
      room.personalAgentTaskSummary=watch.error || watch.lastText?.slice(0,1000);
      return {room,task:{kind:'monitor' as const,prompt:`Watch ${watch.url}. ${watch.condition==='change'?'Notify me when it changes.':watch.condition==='contains'?`Notify me when it contains “${watch.value}”.`:`Notify me when the price is below $${watch.value}.`}`},watch:personalWatchMetadata(watch),turns:[],messages:[],requests:[],actions:[],files:[],browsers:[],hasMore:false};
    }
    const [turns,page,requests,task,actions,files,observations]=await Promise.all([this.store.readRoomAgentTurns!(roomId),this.store.readMessagePageByRoom(roomId,{limit:100,...(beforeMessageId?{beforeMessageId:beforeMessageId as string}:{})}),this.store.readPersonalAgentInputRequests!(clientId,roomId),this.store.readPersonalAgentTask?.(clientId,roomId),this.store.readPersonalGoogleRecords!(clientId,'action'),this.store.readPersonalAgentFiles!(clientId,{roomId,limit:100}),this.store.readPersonalAgentBrowserObservations!(clientId,{roomId,limit:100})]);
    const sessionIds=[...new Set(observations.observations.flatMap(visit=>visit.sessionId?[visit.sessionId]:[]))];
    const sessions=await Promise.all(sessionIds.map(id=>this.store.getPersonalAgentBrowserSession!(clientId,id)));
    const browsers=sessions.flatMap(session=>session?[personalBrowserMetadata(session)]:[]);
    const plan=page.messages.filter(message=>message.toolName==='update_plan' && Array.isArray(message.toolArgs?.plan)).at(-1)?.toolArgs?.plan;
    if(plan)room.personalAgentTaskPlan=plan as Room['personalAgentTaskPlan'];
    const latest=turns[turns.length-1];
    const queued=page.messages.some(message=>message.codeAgentQueuedInput?.state==='queued' || message.codeAgentQueuedInput?.state==='starting');
    const reviews=actions.filter(action=>action.data.sourceRoomId===roomId && action.data.sourceTurnId===latest?.id);
    const waitingReview=reviews.some(action=>['awaiting_review','executing'].includes(String(action.data.status)));
    const pendingOutcome=reviews.some(action=>!action.data.taskContinuationMessageId && !action.data.taskOutcomeRecorded);
    room.personalAgentTaskStatus=room.personalAgentTaskControl || (latest?.status==='running'?'running':queued?'queued':latest?.status==='error' || (latest?.status==='cancelled' && room.personalAgentResumedTurnId!==latest.id)?latest.status:requests.some(request=>!request.answeredAt)?'waiting_input':waitingReview?'waiting_review':pendingOutcome?'queued':latest?.status || 'queued');
    return {room,task,turns,files:files.files.map(personalFileMetadata),browsers,messages:page.messages,hasMore:page.hasMore,requests:requests.map(metadata),actions:actions.filter(action=>action.data.sourceRoomId===roomId).map(action=>({...action.data,updatedAt:action.updatedAt}))};
  }
  async pauseGoal(goal:import('../types').PersonalAgentGoal){
    if(goal.enabled || goal.completedAt)return;
    for(const room of await this.store.readPersonalAgentRooms!(goal.clientId)){
      if(room.personalAgentGoalId===goal.id && !['complete','error','cancelled','paused'].includes(room.personalAgentTaskStatus || 'queued'))await this.control(goal.clientId,room.id,{action:'pause'});
    }
  }
  async control(clientId:string,roomId:string,input:Record<string,unknown>){
    const action=input.action;
    if(action!=='pause' && action!=='resume' && action!=='cancel' && action!=='retry')throw new RangeError('Choose pause, resume, cancel or retry');
    await this.room(clientId,roomId);
    const watch=(await this.store.readPersonalAgentWatches!(clientId,{roomId,limit:1})).watches[0];
    if(watch){
      if(!this.continuation?.tracking)throw new PersonalAgentTaskError('Tracking is unavailable',503);
      if(action==='retry')throw new RangeError('Resume paused tracking to continue');
      await this.continuation.tracking.control(clientId,watch.id,{action:action==='cancel'?'stop':action});
      return {room:(await this.detail(clientId,roomId)).room};
    }
    if(!this.continuation)throw new PersonalAgentTaskError('Task control is unavailable',503);
    const message=this.continuation.create(clientId,roomId,action==='retry'?'Retry this task using the saved task input and progress.':'Resume this task using the saved task input and progress.');
    let room:Room;
    try{room=await this.store.controlPersonalAgentTask!(clientId,roomId,action,message);}catch(error){if(error instanceof PersonalAgentTaskControlError)throw new PersonalAgentTaskError(error.message,409);throw error;}
    if(action==='pause' || action==='cancel')await this.continuation.interrupt?.(roomId,clientId);
    else await this.continuation.wake(room);
    return {room};
  }
  async request(source:{clientId:string;roomId:string;turnId:string},input:Record<string,unknown>){
    await this.room(source.clientId,source.roomId);
    if(typeof input.question!=='string' || !input.question.trim() || input.question.length>4000)throw new RangeError('Provide the question needed to continue');
    let fields: PersonalAgentInputRequest['fields']=[];
    if(input.fileId!==undefined){
      if(typeof input.fileId!=='string')throw new RangeError('Invalid PDF id');
      const file=(await this.store.readPersonalAgentFiles!(source.clientId,{id:input.fileId,limit:1})).files[0];
      if(!file)throw new PersonalAgentTaskError('PDF not found',404);
      if(!Array.isArray(input.fields) || input.fields.length>100 || input.fields.some(name=>typeof name!=='string'))throw new RangeError('Provide the actual missing PDF field names');
      fields=input.fields.map(name=>{
        const field=file.fields.find(field=>field.name===name);
        if(!field || field.type==='unsupported')throw new RangeError('Choose supported fields from the actual PDF');
        return {name:field.name,type:field.type};
      });
    }
    const request:PersonalAgentInputRequest={...source,id:randomUUID(),question:input.question.trim(),fields,fileId:input.fileId as string|undefined,createdAt:new Date().toISOString()};
    const saved=await this.store.savePersonalAgentInputRequest!(request);
    if(!saved)throw new PersonalAgentTaskError('This agent turn ended',409);
    return {request:metadata(saved),status:'waiting_input'};
  }
  async answer(clientId:string,roomId:string,id:string,input:Record<string,unknown>){
    const room=await this.room(clientId,roomId);
    if(room.personalAgentTaskControl)throw new PersonalAgentTaskError('Resume the task before continuing. Cancelled tasks cannot continue.',409);
    const turns=await this.store.readRoomAgentTurns!(roomId);
    if(turns[turns.length-1]?.status==='cancelled' && room.personalAgentResumedTurnId!==turns[turns.length-1]?.id)throw new PersonalAgentTaskError('Cancelled tasks cannot continue',409);
    const request=(await this.store.readPersonalAgentInputRequests!(clientId,roomId)).find(value=>value.id===id);
    if(!request)throw new PersonalAgentTaskError('Input request not found',404);
    const text=input.text ?? '',fields=input.fields ?? {};
    if(typeof text!=='string' || text.length>16000 || !fields || typeof fields!=='object' || Array.isArray(fields))throw new RangeError('Invalid input answer');
    const values=fields as Record<string,unknown>;
    if(Object.keys(values).some(name=>!request.fields.some(field=>field.name===name)))throw new RangeError('Unknown requested field');
    for(const field of request.fields)if(field.type==='checkbox' ? typeof values[field.name]!=='boolean' : typeof values[field.name]!=='string' || !(values[field.name] as string).trim() || (values[field.name] as string).length>10000)throw new RangeError(`Provide ${field.name}`);
    if(!request.fields.length && !text.trim())throw new RangeError('Provide your answer');
    if(request.answeredAt)return {request:metadata(request)};
    if(!this.continuation)throw new PersonalAgentTaskError('Task continuation is unavailable',503);
    const content=`${request.question}\n${text}\n${JSON.stringify(values)}`;
    const message=this.continuation.create(clientId,roomId,content);
    const saved=await this.store.answerPersonalAgentInputRequest!(clientId,id,{text,fields:values as Record<string,string|boolean>},message);
    if(!saved)throw new PersonalAgentTaskError('This input request changed',409);
    await this.continuation.wake(await this.room(clientId,roomId));
    return {request:metadata(saved)};
  }
}
