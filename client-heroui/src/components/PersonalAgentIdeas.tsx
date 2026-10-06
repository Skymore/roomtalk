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

Ported from OpenMuse IdeasScreen and IdeaCard in agent-ui.tsx (73a7149).
*/
import React from 'react';
import {Button,Textarea} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import {acceptPersonalAgentIdea,dismissPersonalAgentIdea,readPersonalAgentIdeas,refreshPersonalAgentIdeas,answerPersonalAgentTaskInput,type PersonalAgentIdea} from '../utils/personalAgent';
import {PersonalAgentTaskDetailView} from './PersonalAgentTaskDetail';
import type {Room} from '../utils/types';

interface Props {
  clientId: string;
  ideas: PersonalAgentIdea[];
  rooms: Room[];
  isConnected: boolean;
  onRoomSelect: (room: Room) => void;
  onIdeasChange: (ideas: PersonalAgentIdea[]) => void;
  onIdeaChange: (idea: PersonalAgentIdea) => void;
  onIdeasAppend: (ideas: PersonalAgentIdea[]) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

const ideaIcon=(title:string)=>/document|permission|form/i.test(title)?'📋':/money|spend|saving/i.test(title)?'💸':/goal|plan|training/i.test(title)?'👟':/dinner|table/i.test(title)?'🍽️':'💡';
const IdeaCard:React.FC<{idea:PersonalAgentIdea;props:Props;onTask:(id:string)=>void}>=({idea,props,onTask})=>{
  const {t}=useTranslation();
  const [expanded,setExpanded]=React.useState(false);
  const [editing,setEditing]=React.useState(false);
  const [prompt,setPrompt]=React.useState(idea.prompt);
  const [busy,setBusy]=React.useState(false);
  const [error,setError]=React.useState('');
  async function act(action:'accept'|'dismiss'){
    if(busy)return;setBusy(true);setError('');
    try{if(action==='accept'){const saved=await acceptPersonalAgentIdea(props.clientId,idea,prompt);props.onIdeaChange(saved.idea);onTask(saved.room.id);}else{const saved=await dismissPersonalAgentIdea(props.clientId,idea);props.onIdeaChange(saved.idea);}}
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  }
  return <article className="border-b border-default-200 py-5" data-testid="personal-idea-card">
    <button type="button" aria-expanded={expanded} aria-label={t('personalIdeaOpen',{title:idea.title})} className="flex w-full gap-3 text-left" onClick={()=>setExpanded(!expanded)}><span className="w-9 shrink-0 pt-1 text-3xl">{ideaIcon(idea.title)}</span><span className="min-w-0 flex-1"><span className="block font-semibold">{idea.title}</span><span className="mt-1 block text-sm text-default-500">{idea.reason}</span></span></button>
    {expanded && <div className="mt-5 space-y-4 pl-12">
      <div className="space-y-2 rounded-xl bg-default-50 p-3 text-sm"><p className="font-medium">{idea.source.title}</p><p className="whitespace-pre-wrap break-words text-default-500">{idea.source.excerpt}</p>{idea.source.url && <p className="break-all text-xs text-default-500">{idea.source.url}</p>}<p className="text-xs text-default-400">{new Date(idea.source.recordedAt).toLocaleString()}</p></div>
      {editing && <Textarea label={t('personalIdeaSourceInstructions')} value={prompt} onValueChange={setPrompt} maxLength={16000} minRows={3}/>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" color="secondary" isLoading={busy} isDisabled={!prompt.trim()} onPress={()=>void act('accept')}>{t('personalIdeaSourceAccept')}</Button><Button size="sm" isDisabled={busy} onPress={()=>setEditing(!editing)}>{t(editing?'personalIdeaKeepEdits':'edit')}</Button><Button size="sm" isDisabled={busy} onPress={()=>void act('dismiss')}>{t('personalIdeaDismiss')}</Button></div>
    </div>}
  </article>;
};
export const PersonalAgentIdeas:React.FC<Props>=props=>{
  const {t}=useTranslation();
  const [refreshing,setRefreshing]=React.useState(false);
  const [hasMore,setHasMore]=React.useState(props.ideas.length>=50);
  const [error,setError]=React.useState('');
  const [taskId,setTaskId]=React.useState<string>();
  const active=React.useRef(true);React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const pending=props.ideas.filter(idea=>idea.status==='new');
  return <section className="space-y-5" aria-label={t('personalAgentIdeas')}>
    <div className="flex items-center justify-between gap-3"><p className="text-xs text-default-500">{t('personalIdeaSourceDescription')}</p><Button size="sm" startContent={<Icon icon="lucide:refresh-cw"/>} isLoading={refreshing} onPress={()=>{
      if(refreshing)return;setRefreshing(true);setError('');void refreshPersonalAgentIdeas(props.clientId).then(saved=>{if(active.current){props.onIdeasChange(saved.ideas);setHasMore(saved.total>saved.ideas.length);}}).catch(error=>{if(active.current)setError(error.message);}).finally(()=>{if(active.current)setRefreshing(false);});
    }}>{t('personalIdeaFind')}</Button></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {pending.map(idea=><IdeaCard key={idea.id} idea={idea} props={props} onTask={setTaskId}/>)}
    {!pending.length && <div className="space-y-2 py-8 text-center"><Icon icon="lucide:lightbulb" className="mx-auto h-6 w-6 text-default-400"/><p className="font-medium">{t('personalIdeaSourceEmpty')}</p><p className="text-sm text-default-500">{t('personalIdeaSourceEmptyHint')}</p></div>}
    {props.ideas.filter(idea=>idea.status==='accepted').map(idea=><article key={idea.id} className="space-y-2 rounded-2xl border border-default-200 p-4"><h3 className="font-semibold">{idea.title}</h3><span className="inline-block rounded-full bg-success-50 px-2 py-1 text-xs text-success-700">{t('personalIdeaStarted')}</span>{idea.acceptedRoomId && <Button size="sm" onPress={()=>setTaskId(idea.acceptedRoomId)}>{t('personalIdeaViewTask')}</Button>}</article>)}
    {hasMore && <Button isLoading={refreshing} onPress={()=>{if(refreshing)return;setRefreshing(true);setError('');void readPersonalAgentIdeas(props.clientId,props.ideas.length).then(saved=>{if(active.current){props.onIdeasAppend(saved.ideas);setHasMore(saved.total>props.ideas.length+saved.ideas.length);}}).catch(error=>{if(active.current)setError(error.message);}).finally(()=>{if(active.current)setRefreshing(false);});}}>{t('loadMore')}</Button>}
    {taskId && <PersonalAgentTaskDetailView clientId={props.clientId} roomId={taskId} isOpen onClose={()=>setTaskId(undefined)} onSubmit={async(request,answer)=>{await answerPersonalAgentTaskInput(props.clientId,taskId,request.id,answer);}}/>}
  </section>;
};
