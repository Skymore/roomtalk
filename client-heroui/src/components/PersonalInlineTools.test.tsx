// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PersonalInlineTools,PersonalSearchToolCard} from './PersonalInlineTools';
import {readPersonalInlineSteps} from '../utils/personalToolSteps';
import type {Message} from '../utils/types';
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,args?:Record<string,unknown>)=>args?`${key} ${JSON.stringify(args)}`:key})}));
vi.mock('@iconify/react',()=>({Icon:()=>null}));
vi.mock('@heroui/react',()=>({Spinner:()=>null}));
afterEach(cleanup);
const mail={id:'message',threadId:'thread',sender:'Sender',from:'sender@example.org',to:['owner@example.org'],subject:'Actual subject',body:'Actual message body',date:'2026-10-06T10:00:00Z',unread:true,label:'Inbox',attachments:[]};
function history(command:string,result:unknown):Message[]{return [{id:'call',roomId:'room',clientId:'ai',username:'Agent',timestamp:'2026-10-06T10:00:00Z',content:command,messageType:'tool_call',toolCallId:'call',toolName:'exec_command',toolArgs:{cmd:command}},{id:'result',roomId:'room',clientId:'ai',username:'Agent',timestamp:'2026-10-06T10:00:01Z',messageType:'tool_result',toolCallId:'call',content:'Process exited with code 0\n'+JSON.stringify(result),toolOutputPreview:'truncated preview'}];}
it('opens the exact last message through the personal workspace and keeps full receipts beyond the preview',()=>{
 const open=vi.fn();render(<PersonalInlineTools messages={history('roomtalk google thread --id thread --json',{success:true,tool:'PersonalGoogle',messages:[{...mail,id:'earlier'},mail],truncated:true})} active={false} open={open}/>);
 expect(screen.getByText('Actual subject')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'personalToolOpenMail'}));expect(open).toHaveBeenCalledWith('mail',mail);
 expect(screen.getByText('personalToolMailExcerpt')).toBeTruthy();
});
it('deduplicates real search URLs, excludes unreadable unsafe results and reports paused/error states honestly',()=>{
 const step=readPersonalInlineSteps(history('roomtalk search web --objective research --query public --json',{results:[{url:'https://example.org/source',title:'Observed source'},{url:'https://example.org/source',title:'Observed source'}],warnings:['Bounded result','Bounded result'],truncated:true}))[0];
 const {rerender}=render(<PersonalSearchToolCard step={step} active={false}/>);
 expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.org/source');expect(screen.getAllByText('Bounded result')).toHaveLength(1);
 rerender(<PersonalSearchToolCard step={{...step,loading:true,result:null}} active={false}/>);expect(screen.getByText('personalToolSearchStopped {"count":0}')).toBeTruthy();
 rerender(<PersonalSearchToolCard step={{...step,result:{results:[{url:'javascript:alert(1)'}],warnings:[],truncated:false}}} active={false}/>);expect(screen.queryByRole('link')).toBeNull();expect(screen.getByRole('alert').textContent).toBe('personalToolSearchUnreadable');
 rerender(<PersonalSearchToolCard step={{...step,result:{error:'Provider rate limited'}}} active={false}/>);expect(screen.getByRole('alert').textContent).toBe('Provider rate limited');
});
it('opens memory and goals directly from their saved receipts',()=>{
 const open=vi.fn(),{rerender}=render(<PersonalInlineTools messages={history('roomtalk memory save --file memory.json --json',{tool:'PersonalMemory',success:true,memory:{id:'memory'}})} active={false} open={open}/>);
 fireEvent.click(screen.getByRole('button'));expect(open).toHaveBeenCalledWith('memory');
 rerender(<PersonalInlineTools messages={history('roomtalk goal create --file goal.json --json',{tool:'PersonalGoal',success:true,goal:{id:'goal'}})} active={false} open={open}/>);fireEvent.click(screen.getByRole('button'));expect(open).toHaveBeenCalledWith('goals');
});
it('shows successful redirected searches as saved results and preserves actual failures',()=>{
 const messages=history('/bin/sh -lc "roomtalk search web --objective research --query public --json > /workspace/ski-search.json"',null);
 messages[1]={...messages[1],content:'',exitCode:0,isError:false};
 const {rerender}=render(<PersonalInlineTools messages={messages} active={false}/>);
 expect(screen.getByText('personalToolSearchCompleted {"count":0}')).toBeTruthy();
 expect(screen.getByText('personalToolSearchSavedToFile')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 rerender(<PersonalInlineTools messages={[messages[0],{...messages[1],exitCode:1,isError:true}]} active={false}/>);
 expect(screen.getByRole('alert').textContent).toBe('personalToolSearchUnreadable');expect(screen.queryByText('personalToolSearchSavedToFile')).toBeNull();
 rerender(<PersonalInlineTools messages={[messages[0],{...messages[1],exitCode:1,isError:true,content:JSON.stringify({success:false,error:'Parallel search failed: rate limited'})}]} active={false}/>);
 expect(screen.getByRole('alert').textContent).toBe('Parallel search failed: rate limited');
 rerender(<PersonalInlineTools messages={history('roomtalk search web --objective research --query public --json',null).map(message=>({...message,exitCode:0,content:message.messageType==='tool_result'?'':message.content}))} active={false}/>);
 expect(screen.getByRole('alert').textContent).toBe('personalToolSearchUnreadable');
});
