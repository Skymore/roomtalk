import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {PersonalAgentTaskDetailView} from './PersonalAgentTaskDetail';
import type {PersonalAgentTaskDetail} from '../utils/personalAgent';

const api=vi.hoisted(()=>({readPersonalAgentTask:vi.fn(),controlPersonalAgentTask:vi.fn()}));
vi.mock('../utils/personalAgent',()=>api);
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@iconify/react',()=>({Icon:()=>null}));
vi.mock('./MarkdownContent',()=>({MarkdownContent:({content}:{content:string})=><div>{content}</div>}));
vi.mock('./PersonalAgentGoogleReview',()=>({PersonalAgentGoogleReview:()=>null}));
vi.mock('./PersonalAgentFiles',()=>({PersonalAgentFiles:()=>null}));
vi.mock('./PersonalAgentComputer',()=>({PersonalAgentBrowserSessionCard:()=>null}));
vi.mock('./PersonalAgentBrowser',()=>({PersonalAgentBrowserControl:()=>null}));
vi.mock('./PersonalAgentResults',()=>({PersonalAgentResults:()=> <div data-testid="saved-result">Saved plan file</div>}));

const now='2026-10-07T12:00:00Z';
const searchResult={results:[{url:'https://example.com/resort',title:'Resort opening dates',excerpts:['December opening confirmed.']}],warnings:[],truncated:false};
function detail():PersonalAgentTaskDetail {
  return {
    room:{id:'task',name:'December ski trip',creatorId:'owner',createdAt:now,personalAgentTaskStatus:'complete'},
    task:{kind:'plan',prompt:'Give me ski trip options'},requests:[],actions:[],hasMore:false,
    turns:[{id:'run',roomId:'task',status:'complete',startedAt:now,updatedAt:now,backend:'codex-app-server',assistantName:'My Agent',finalMessageId:'answer'}],
    messages:[
      {id:'plan',roomId:'task',clientId:'owner',timestamp:now,messageType:'tool_call',toolName:'update_plan',toolArgs:{plan:[{step:'Compare resorts',status:'completed'}]},content:''},
      {id:'search',roomId:'task',clientId:'owner',timestamp:now,messageType:'tool_call',toolName:'search_web',toolCallId:'search-call',content:''},
      {id:'receipt',roomId:'task',clientId:'owner',timestamp:now,messageType:'tool_result',toolCallId:'search-call',content:JSON.stringify(searchResult)},
      {id:'progress',roomId:'task',clientId:'owner',turnId:'run',timestamp:now,messageType:'ai',content:'Checking resort dates'},
      {id:'answer',roomId:'task',clientId:'owner',turnId:'run',timestamp:now,messageType:'ai',content:'Three confirmed ski trip options'},
    ],
    files:[{id:'pdf',name:'Ski trip.pdf',byteSize:200,pageCount:1,fields:[],source:'task',createdAt:now}],
  };
}
beforeEach(()=>{vi.clearAllMocks();api.readPersonalAgentTask.mockResolvedValue(detail());});
afterEach(cleanup);
const open=()=>render(<PersonalAgentTaskDetailView clientId="owner" roomId="task" isOpen onClose={()=>{}} onSubmit={vi.fn()}/>);
describe('OpenMuse task detail layout',()=>{
  it('shows the final outcome and deliverables before sources and timeline without duplicating chat search cards',async()=>{
    const data=detail();
    data.messages.push({...data.messages[1],id:'second-search',toolCallId:'second-call'}, {...data.messages[2],id:'second-receipt',toolCallId:'second-call',content:JSON.stringify({...searchResult,results:[{...searchResult.results[0],title:'Repeated source'}]})});
    api.readPersonalAgentTask.mockResolvedValue(data);
    open();
    const outcome=await screen.findByTestId('personal-task-outcome');
    expect(screen.getAllByText('Three confirmed ski trip options')).toHaveLength(1);
    const files=screen.getByTestId('personal-file-thread-card'),saved=screen.getByTestId('saved-result');
    const sources=screen.getByTestId('personal-task-sources'),timeline=screen.getByTestId('personal-task-timeline');
    for(const [before,after] of [[outcome,files],[files,saved],[saved,sources],[sources,timeline]])expect(before.compareDocumentPosition(after)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sources).getAllByRole('link')).toHaveLength(1);
    expect(within(sources).getByText('Resort opening dates')).toBeTruthy();
    expect(within(sources).getByText('December opening confirmed.')).toBeTruthy();
    expect(within(sources).getByRole('link').getAttribute('href')).toBe(searchResult.results[0].url);
    expect(within(timeline).getByText('Checking resort dates')).toBeTruthy();
    expect(within(timeline).queryByText('Three confirmed ski trip options')).toBeNull();
    expect(screen.queryByTestId('personal-search-tool-card')).toBeNull();
  });
  it('keeps running commentary in the timeline and retains the pause action',async()=>{
    const data=detail();data.room.personalAgentTaskStatus='running';data.turns[0].status='running';delete data.turns[0].finalMessageId;
    api.readPersonalAgentTask.mockResolvedValue(data);api.controlPersonalAgentTask.mockResolvedValue({});
    open();await screen.findByText('Compare resorts');
    expect(screen.queryByTestId('personal-task-outcome')).toBeNull();
    expect(within(screen.getByTestId('personal-task-timeline')).getByText('Three confirmed ski trip options')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'personalAgentPause'}));
    expect(api.controlPersonalAgentTask).toHaveBeenCalledWith('owner','task','pause');
  });
  it('shows failed execution as an error instead of a completed result, while retaining retry',async()=>{
    const data=detail();data.room.personalAgentTaskStatus='error';data.turns[0].status='error';data.messages.at(-1)!.content='Could not save the result';
    api.readPersonalAgentTask.mockResolvedValue(data);open();
    const failure=await screen.findByRole('alert');expect(failure.textContent).toBe('Could not save the result');
    expect(screen.queryByTestId('personal-task-outcome')).toBeNull();
    expect(screen.getByRole('button',{name:'personalTaskRetry'})).toBeTruthy();
  });
  it('does not present a request for missing information as a completed outcome',async()=>{
    const data=detail();data.room.personalAgentTaskStatus='waiting_input';data.messages.at(-1)!.content='Which departure city should I use?';
    data.requests=[{id:'question',roomId:'task',turnId:'run',question:'Departure city',fields:[],createdAt:now}];
    api.readPersonalAgentTask.mockResolvedValue(data);open();await screen.findByText('Departure city');
    expect(screen.queryByTestId('personal-task-outcome')).toBeNull();
    expect(screen.getByRole('button',{name:'personalTaskContinue'})).toBeTruthy();
    expect(within(screen.getByTestId('personal-task-timeline')).getByText('Which departure city should I use?')).toBeTruthy();
  });
  it('keeps source excerpts to the original 500 character evidence limit',async()=>{
    const data=detail();data.messages[2].content=JSON.stringify({...searchResult,results:[{...searchResult.results[0],excerpts:['A'.repeat(300),'B'.repeat(900)]}]});
    api.readPersonalAgentTask.mockResolvedValue(data);open();
    const sources=await screen.findByTestId('personal-task-sources');
    const excerpt=sources.querySelector('p.text-default-500')!;
    expect(excerpt.textContent).toBe('A'.repeat(300)+'\n'+'B'.repeat(199));
  });
});
