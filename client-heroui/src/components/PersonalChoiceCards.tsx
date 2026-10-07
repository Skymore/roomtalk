import type {PersonalChoiceSender} from '../utils/personalChoiceTranscript';
import React from 'react';
import {Button,Spinner} from '@heroui/react';
import {Icon} from '@iconify/react';
import {useTranslation} from 'react-i18next';
import type {Message} from '../utils/types';
import type {JevPanel,JevToolResult} from '../utils/personalChoiceDomain';
import {choiceAvailability,confirmedJevSelection,latestJevPanelId,retryChoiceAvailable,selectionText} from '../utils/personalChoiceActions';
import {personalChoiceSteps,personalChoiceTranscript} from '../utils/personalChoiceTranscript';

type Interaction={threadId:string;busy:boolean;latestPanelId:string|null;latestUserText:string|null;canRetry:boolean;confirmedSelection:(panelId:string)=>string|null;send:PersonalChoiceSender};
// Ported from OpenMuse jev-tool-card.tsx: source chips, comparison cards and selection lifecycle.
const ChoiceCard:React.FC<{result:JevToolResult|null;loading:boolean;interaction:Interaction}>=({result,loading,interaction})=>{
  const {t}=useTranslation();
  const [submittingId,setSubmittingId]=React.useState<string|null>(null);
  const [confirmedId,setConfirmedId]=React.useState<string|null>(null);
  const [failedOptionId,setFailedOptionId]=React.useState<string|null>(null);
  const [submitError,setSubmitError]=React.useState('');
  const pending=React.useRef(false);
  if(loading)return <div role="status" className="flex items-center gap-2 p-3 text-sm text-default-500"><Spinner size="sm"/>{t('personalChoicesPreparing')}</div>;
  if(!result)return <p role="alert" className="text-sm text-danger">{t('personalChoicesUnreadable')}</p>;
  if(result.error)return <p role="alert" className="text-sm text-danger">{result.error}</p>;
  const panel=result.panel;
  if(!panel)return null;
  const availability=choiceAvailability(panel,interaction.threadId,interaction.latestPanelId,interaction.busy,submittingId!==null || confirmedId!==null || interaction.confirmedSelection(panel.id)!==null);
  const selectedId=panel.selectedId || confirmedId || interaction.confirmedSelection(panel.id);
  const preferred=panel.options.find(option=>option.id===panel.preferredId);
  const canRetry=retryChoiceAvailable(panel,interaction.threadId,interaction.latestPanelId,failedOptionId,interaction.latestUserText,!!selectedId,!interaction.canRetry || submittingId!==null);
  const choose=async(optionId:string,retrying=false)=>{
    if(pending.current || selectedId || (retrying?(!canRetry || optionId!==failedOptionId):choiceAvailability(panel,interaction.threadId,interaction.latestPanelId,interaction.busy,false)!=='ready'))return;
    pending.current=true;setSubmittingId(optionId);setSubmitError('');
    try {await interaction.send(selectionText(panel,optionId),retrying);setConfirmedId(optionId);setFailedOptionId(null);}
    catch(error){setFailedOptionId(optionId);setSubmitError(error instanceof Error?error.message:String(error));}
    finally{pending.current=false;setSubmittingId(null);}
  };
  const button=(option:JevPanel['options'][number],position:number)=>{
    const caption=panel.type==='comparison'?t(/exhibit/i.test(panel.title)?'personalChoicesExhibit':'personalChoicesOption'):option.label;
    return <Button size="sm" className="h-auto min-h-9 max-w-full whitespace-normal bg-secondary/15 px-4 py-2 text-foreground" aria-label={panel.type==='comparison'?`${caption}: ${option.label} (option ${position})`:option.label} aria-pressed={selectedId===option.id}
      isDisabled={availability!=='ready'} isLoading={submittingId===option.id} onPress={()=>void choose(option.id)}>{selectedId===option.id && <Icon icon="lucide:check"/>}{caption}</Button>;
  };
  return <div className="w-full max-w-[440px] space-y-[13px] rounded-[20px] border border-default-200 bg-content1 p-[17px]" data-testid="personal-choice-card">
    <div className="space-y-1"><h3 className="text-lg font-semibold">{panel.title}</h3><p className="text-xs text-default-500">{t(panel.mode==='sample'?'personalChoicesSample':'personalChoicesLive')}</p>
      {preferred && !selectedId && <p className="text-xs text-default-500">{t('personalChoicesPrevious',{label:preferred.label})}</p>}
      {(availability==='wrong-thread' || availability==='stale') && <p className="text-xs text-default-500">{t('personalChoicesEarlier')}</p>}
      {selectedId && <p className="text-xs text-default-500">{t('personalChoicesSubmitted')}</p>}
    </div>
    {panel.type==='clarification'?<div className="flex flex-wrap gap-2">{panel.options.map((option,index)=><React.Fragment key={option.id}>{button(option,index+1)}</React.Fragment>)}</div>:
      <div className="space-y-2.5">{panel.options.map((option,index)=><div key={option.id} className="space-y-2 rounded-2xl bg-content2 p-3.5"><p className="font-semibold">{option.label}</p>
        {!!option.details.length && <ul className="list-inside list-disc text-sm text-default-600">{option.details.map((detail,index)=><li key={index}>{detail}</li>)}</ul>}
        <div className="space-y-1">{option.sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" aria-label={t('personalChoicesSource',{title:source.title})} className="flex items-center gap-1 break-words text-xs text-foreground underline">{source.title}<Icon icon="lucide:external-link"/></a>)}</div>
        {button(option,index+1)}</div>)}</div>}
    {submitError && <p role="alert" className="text-sm text-danger">{submitError}</p>}
    {failedOptionId && !selectedId && <Button size="sm" variant="light" isDisabled={!canRetry} onPress={()=>void choose(failedOptionId,true)}>{t('personalChoicesRetry')}</Button>}
  </div>;
};
export const PersonalChoiceCards:React.FC<{messages:Message[];transcript:Message[];threadId:string;busy:boolean;canInteract:boolean;send?:PersonalChoiceSender}>=({messages,transcript,threadId,busy,canInteract,send})=>{
  const history=React.useMemo(()=>personalChoiceTranscript(transcript),[transcript]);
  const interaction:Interaction={threadId,busy:busy || !canInteract,latestPanelId:latestJevPanelId(history,threadId),latestUserText:transcript.filter(message=>message.messageType==='text').at(-1)?.content ?? null,
    canRetry:canInteract && !busy,confirmedSelection:panelId=>confirmedJevSelection(history,panelId),send:send ?? (async()=>{throw new Error('Open an active conversation to choose an option.');})};
  return <>{personalChoiceSteps(messages).map(step=><ChoiceCard key={step.id} {...step} interaction={interaction}/>)}</>;
};

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

Ported from CopilotKit/OpenMuse 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
*/
