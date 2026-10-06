import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PersonalChoiceCards} from './PersonalChoiceCards';
import {personalChoiceTranscript,personalChoiceResult} from '../utils/personalChoiceTranscript';
import {displayJevUserMessage,selectionText} from '../utils/personalChoiceActions';
import type {Message} from '../utils/types';
import type {JevPanel} from '../../../server/src/services/personalChoices/domain';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,options?:Record<string,string>)=>key==='personalChoicesSource'?`Source: ${options?.title}`:key})}));
vi.mock('@iconify/react',()=>({Icon:()=>null}));
vi.mock('@heroui/react',()=>({Button:({children,onPress,isDisabled,isLoading,...props}:Record<string,any>)=><button aria-label={props['aria-label']} aria-pressed={props['aria-pressed']} disabled={isDisabled || isLoading} onClick={onPress}>{children}</button>,Spinner:()=>null}));
afterEach(cleanup);
const panel:JevPanel={id:'panel',threadId:'thread',turnId:'turn',candidateSetVersion:1,type:'comparison',title:'Choose a place',mode:'live',options:[{id:'a',label:'Place A',details:['Real evidence'],sources:[{title:'Actual source',url:'https://example.org/place'}]},{id:'b',label:'Place B',details:['Other evidence'],sources:[{title:'Other source',url:'https://example.org/other'}]}]};
const message=(id:string,data:Partial<Message>):Message=>({id,clientId:'owner',roomId:'thread',content:'',timestamp:'2026-10-06T12:00:00Z',username:'Owner',messageType:'text',...data});
const calls=[message('user',{content:'Compare places'}),message('call',{messageType:'tool_call',toolCallId:'call',toolName:'exec_command',toolArgs:{cmd:'roomtalk choices present --file choices.json --json'}})];
const receipt=message('result',{messageType:'tool_result',toolCallId:'call',content:'Process exited with code 0\n'+JSON.stringify({success:true,tool:'PersonalChoices',panel})});
const history=[...calls,receipt];
it('renders source comparison cards and sends a single validated structured choice',async()=>{
  let release!:()=>void;
  const send=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  render(<PersonalChoiceCards messages={history} transcript={history} threadId="thread" busy={false} canInteract send={send}/>);
  const a=screen.getByRole('button',{name:/Place A/}),b=screen.getByRole('button',{name:/Place B/});
  expect(screen.getByRole('link',{name:/Actual source/}).getAttribute('href')).toBe('https://example.org/place');
  fireEvent.click(a);fireEvent.click(b);
  expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledWith(selectionText(panel,'a'),false);
  expect((a as HTMLButtonElement).disabled).toBe(true);expect((b as HTMLButtonElement).disabled).toBe(true);release();
  await waitFor(()=>expect(screen.getByText('personalChoicesSubmitted')).toBeTruthy());
  expect(displayJevUserMessage(selectionText(panel,'a'),personalChoiceTranscript(history))).toBe('Selected: Place A');
});
it('disables a prior panel after another user request or when access is lost',()=>{
  const send=vi.fn();
  const {rerender}=render(<PersonalChoiceCards messages={history} transcript={[...history,message('new',{content:'A different request'})]} threadId="thread" busy={false} canInteract send={send}/>);
  const button=screen.getByRole('button',{name:/Place A/});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(send).not.toHaveBeenCalled();
  rerender(<PersonalChoiceCards messages={history} transcript={history} threadId="thread" busy={false} canInteract={false} send={send}/>);expect((button as HTMLButtonElement).disabled).toBe(true);
});
it('allows retry only for the failed current choice, then confirms the saved selection',async()=>{
  const send=vi.fn().mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(undefined);
  const {rerender}=render(<PersonalChoiceCards messages={history} transcript={history} threadId="thread" busy={false} canInteract send={send}/>);
  fireEvent.click(screen.getByRole('button',{name:/Place A/}));await screen.findByText('Connection interrupted');
  expect((screen.getByRole('button',{name:'personalChoicesRetry'}) as HTMLButtonElement).disabled).toBe(true);
  rerender(<PersonalChoiceCards messages={history} transcript={[...history,message('failed',{content:selectionText(panel,'a'),deliveryStatus:'failed'})]} threadId="thread" busy={false} canInteract send={send}/>);
  fireEvent.click(screen.getByRole('button',{name:'personalChoicesRetry'}));
  await waitFor(()=>expect(send).toHaveBeenLastCalledWith(selectionText(panel,'a'),true));
  await screen.findByText('personalChoicesSubmitted');
});
it('reads the complete durable receipt even when the tool preview is truncated',()=>{
  const large:JevPanel={...panel,options:panel.options.map(option=>({...option,details:Array.from({length:4},()=> 'Grounded detail '.repeat(35).trim())}))};
  const output=JSON.stringify({success:true,tool:'PersonalChoices',panel:large});expect(output.length).toBeGreaterThan(4096);
  expect(personalChoiceResult({...receipt,content:output,toolOutputPreview:output.slice(0,4096)+'[display truncated]'})).toEqual({panel:large});
});
