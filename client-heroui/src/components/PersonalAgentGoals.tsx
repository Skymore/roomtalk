/*
MIT License

Copyright (c) 2026 OpenMuse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Ported from OpenMuse GoalsScreen, GoalForm and GoalCard in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button,Checkbox,Input,Modal,ModalBody,ModalContent,ModalHeader,Textarea} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {createPersonalAgentGoal,updatePersonalAgentGoal,delegatePersonalAgentTask,answerPersonalAgentTaskInput,type PersonalAgentGoal} from '../utils/personalAgent';
import {PersonalAgentTaskDetailView} from './PersonalAgentTaskDetail';
import type {Room} from '../utils/types';
interface PersonalAgentGoalsProps {
  clientId:string;goals:PersonalAgentGoal[];rooms:Room[];isConnected:boolean;
  onRoomSelect:(room:Room)=>void;onGoalsChange:(goals:PersonalAgentGoal[])=>void;
  showSuccess:(message:string)=>void;showError:(message:string)=>void;
}
interface GoalAction { ():Promise<void> }
const categories=[{name:'Health',icon:'lucide:heart'},{name:'Relationships',icon:'lucide:users'},{name:'Finances',icon:'lucide:circle-dollar-sign'},{name:'Something else',icon:'lucide:target'}];
const status=(goal:PersonalAgentGoal)=>goal.completedAt?'personalAgentGoalCompleted':goal.enabled?'personalGoalActive':'personalAgentPaused';
export const PersonalAgentGoals:React.FC<PersonalAgentGoalsProps>=({clientId,goals,rooms,onGoalsChange})=>{
  const {t}=useTranslation();
  const [category,setCategory]=React.useState<string>();
  const [selected,setSelected]=React.useState<string>();
  const [taskId,setTaskId]=React.useState<string>();
  const [title,setTitle]=React.useState('');
  const [description,setDescription]=React.useState('');
  const [milestones,setMilestones]=React.useState('');
  const [busy,setBusy]=React.useState(false);
  const [error,setError]=React.useState('');
  const goal=goals.find(item=>item.id===selected);
  const activeGoals=goals.filter(item=>!item.completedAt);
  const completedGoals=goals.filter(item=>item.completedAt);
  async function act(action:GoalAction){if(busy)return;setBusy(true);setError('');try{await action();}catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}}
  const update=(body:Parameters<typeof updatePersonalAgentGoal>[2])=>act(async()=>{
    if(!goal)return;const saved=await updatePersonalAgentGoal(clientId,goal.id,body,goal.updatedAt);onGoalsChange(goals.map(item=>item.id===goal.id?saved.goal:item));
    if(saved.goal.completedAt && !goal.completedAt)setSelected(undefined);
  });
  const renderGoal=(goal:PersonalAgentGoal)=><button key={goal.id} type="button" className="flex w-full items-center gap-3 py-3 text-left" aria-label={t('personalGoalOpen',{title:goal.title})} onClick={()=>{setSelected(goal.id);setError('');}}>
    <Icon icon="lucide:square" className={`h-5 w-5 shrink-0 ${goal.completedAt?'fill-success text-success':'text-default-400'}`}/><span className="min-w-0 flex-1"><span className="block">{goal.title}</span><span className="mt-1 line-clamp-2 text-sm text-default-500">{goal.completedAt ? t(status(goal)) : goal.prompt || t(status(goal))}</span></span><Icon icon="lucide:chevron-right" className="text-default-400"/>
  </button>;

  return <>
    <section className="space-y-2 border-t border-default-200 pt-5" aria-label={t('personalAgentGoals')}>
      <h3 className="flex items-center gap-2 text-lg font-semibold text-secondary"><span className="h-4 w-4 rounded-full border-[5px] border-secondary/20 bg-secondary"/>{t('personalAgentGoals')}</h3>
      {activeGoals.map(renderGoal)}
      {completedGoals.length>0 && <details className="pt-2" data-testid="personal-completed-goals">
        <summary className="cursor-pointer py-2 text-sm text-default-500">{t('personalAgentGoalCompleted')} ({completedGoals.length})</summary>
        {completedGoals.map(renderGoal)}
      </details>}
      {!goals.length && <p className="py-3 text-sm text-default-500">{t('personalGoalEmpty')}</p>}
    </section>
    <section className="space-y-3 border-t border-default-200 pt-5"><h3 className="text-lg font-semibold">{t('personalGoalCreate')}</h3>
      {categories.map(item=><button key={item.name} type="button" className="flex min-h-10 w-full items-center gap-3 text-left text-default-500" aria-label={t('personalGoalCreateCategory',{category:t(`personalGoalCategory_${item.name}`)})} onClick={()=>{setCategory(item.name);setTitle('');setDescription('');setMilestones('');setError('');}}><Icon icon={item.icon} className="h-6 w-6"/><span className="flex-1">{t(`personalGoalCategory_${item.name}`)}</span><Icon icon="lucide:plus"/></button>)}
    </section>
    <Modal isOpen={Boolean(category)} onClose={()=>setCategory(undefined)} scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{t('personalGoalCreate')}</ModalHeader><ModalBody className="pb-6"><form className="space-y-4" onSubmit={event=>{event.preventDefault();void act(async()=>{
      const saved=await createPersonalAgentGoal(clientId,{title:title.trim(),prompt:description,category,schedule:'manual',time:'09:00',timezone:'UTC',milestones:milestones.split('\n').map(line=>line.trim()).filter(Boolean).map(title=>({id:crypto.randomUUID(),title,done:false}))});onGoalsChange([saved.goal,...goals]);setCategory(undefined);
    });}}>
      <Input variant="bordered" labelPlacement="outside" label={t('personalGoalYourGoal')} placeholder={t('personalGoalExample')} value={title} onValueChange={setTitle} maxLength={160}/>
      <Textarea variant="bordered" labelPlacement="outside" label={t('personalGoalSuccess')} value={description} onValueChange={setDescription} maxLength={4000}/>
      <Textarea variant="bordered" labelPlacement="outside" label={t('personalGoalMilestoneLines')} value={milestones} onValueChange={setMilestones}/>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" color="secondary" isLoading={busy} isDisabled={!title.trim()}>{t('personalGoalCreateButton')}</Button>
    </form></ModalBody></ModalContent></Modal>
    <Modal isOpen={Boolean(goal)} onClose={()=>setSelected(undefined)} scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{goal?.title}</ModalHeader><ModalBody className="pb-6">{goal && <div className="space-y-3 rounded-2xl border border-default-200 p-4">
      <div className="flex justify-between gap-3"><h3 className="font-semibold">{goal.title}</h3><span className={`rounded-full px-2 py-1 text-xs ${goal.completedAt?'bg-success/15 text-success-700':'bg-secondary/15'}`}>{t(status(goal))}</span></div>
      <p className="whitespace-pre-wrap text-sm text-default-500">{goal.prompt}</p>
      {Boolean(goal.milestones?.length) && <p className="text-xs text-default-500">{t('personalGoalProgress',{done:goal.milestones!.filter(item=>item.done).length,total:goal.milestones!.length})}</p>}
      {(goal.milestones || []).map(milestone=><Checkbox key={milestone.id} className="flex" isDisabled={busy || Boolean(goal.completedAt)} isSelected={milestone.done} onValueChange={done=>void update({milestones:goal.milestones!.map(item=>item.id===milestone.id?{...item,done}:item)})}>{milestone.title}</Checkbox>)}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!goal.completedAt && <div className="flex flex-wrap gap-2"><Button size="sm" isLoading={busy} onPress={()=>void update({enabled:!goal.enabled,completed:false})}>{t(goal.enabled?'personalAgentPause':'personalAgentResume')}</Button>
        <Button size="sm" isLoading={busy} onPress={()=>void update({completed:true})}>{t('personalAgentCompleteGoal')}</Button>
        <Button size="sm" color="secondary" isLoading={busy} onPress={()=>void act(async()=>{const saved=await delegatePersonalAgentTask(clientId,{kind:'plan',title:`Plan: ${goal.title}`,prompt:`Create a practical plan for this goal: ${goal.title}. ${goal.prompt}`,goalId:goal.id,input:{}});setSelected(undefined);setTaskId(saved.room.id);})}>{t('personalGoalPlan')}</Button>
      </div>}
      {rooms.filter(room=>room.personalAgentGoalId===goal.id).map(room=><button key={room.id} type="button" className="block w-full rounded-xl border border-default-200 p-3 text-left text-sm" onClick={()=>{setSelected(undefined);setTaskId(room.id);}}>{room.name}<span className="mt-1 block text-xs text-default-500">{t('personalAgentViewWork')}</span></button>)}
    </div>}</ModalBody></ModalContent></Modal>
    {taskId && <PersonalAgentTaskDetailView clientId={clientId} roomId={taskId} isOpen onClose={()=>setTaskId(undefined)} onSubmit={async(request,answer)=>{await answerPersonalAgentTaskInput(clientId,taskId,request.id,answer);}}/>}
  </>;
};
