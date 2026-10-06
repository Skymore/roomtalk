// @vitest-environment jsdom
import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PersonalAgentConversation} from './PersonalAgentConversation';
import type {Message} from '../utils/types';
const mocks=vi.hoisted(()=>({send:vi.fn(),queue:vi.fn(),upload:vi.fn(),add:vi.fn(),failed:vi.fn(),replace:vi.fn(),retry:undefined as undefined|((message:Message)=>void)}));
vi.mock('../utils/socket',()=>({sendMessageAndAskAI:mocks.send,queueCodeAgentInput:mocks.queue,uploadMediaMessage:mocks.upload,interruptCodeAgentTurn:vi.fn(),requestCodeWorkspaceAssetUrl:vi.fn(),requestCodeWorkspaceFile:vi.fn()}));
vi.mock('../hooks/useRoomTextDraft',()=>({useRoomTextDraft:()=>({saveDraft:vi.fn(),beginDraftSend:()=>vi.fn()})}));
vi.mock('./PersonalAgentTaskDetail',()=>({PersonalAgentTaskDetailView:()=>null}));
vi.mock('./MessageList',()=>({MessageList:React.forwardRef((props:any,ref)=>{mocks.retry=props.onRetryPersonalMessage;React.useImperativeHandle(ref,()=>({addOptimisticMessage:mocks.add,markOptimisticMessageFailed:mocks.failed,replaceOptimisticMessage:mocks.replace,scrollToBottom:vi.fn()}));return null;})}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@iconify/react',()=>({Icon:()=>null}));
vi.mock('@heroui/react',()=>({Button:({onPress,isDisabled,children,...props}:any)=><button aria-label={props['aria-label']} disabled={isDisabled} onClick={onPress}>{children}</button>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('retries the same failed personal message with its images and leaves a newer composer draft untouched',async()=>{
 const ensure=vi.fn().mockResolvedValue(undefined),showError=vi.fn();
 mocks.upload.mockResolvedValue({id:'image',mediaAsset:{kind:'image',filename:'picture.jpg'}});
 mocks.send.mockRejectedValueOnce(new Error('Transport interrupted')).mockImplementation(async params=>({userMessage:{id:params.clientMessageId,content:params.content}}));
 render(<PersonalAgentConversation room={{id:'room',creatorId:'owner',name:'Assistant',createdAt:'2026-10-06T10:00:00Z',personalAgentOwnerId:'owner',personalAgentThreadKind:'main'}} clientId="owner" username="Owner" roomPermissions={{canPost:true,canUseCodeAgent:true} as any} isRoomSessionReady canUseRetainedRoomAccess ensureRoomSessionReady={ensure} onRoomUpdated={vi.fn()} onRoomDeleted={vi.fn()} onRoomAccessDenied={vi.fn()} onBack={vi.fn()} onComputer={vi.fn()} showError={showError}/>);
 const file=screen.getByTestId('personal-agent-conversation').querySelector('input[type=file]')!;
 fireEvent.change(file,{target:{files:[new File(['actual image'],'picture.jpg',{type:'image/jpeg'})]}});await screen.findByText('picture.jpg');
 const editor=screen.getByRole('textbox');Object.defineProperty(editor,'innerText',{configurable:true,value:'Read this picture'});editor.textContent='Read this picture';fireEvent.input(editor);fireEvent.click(screen.getByRole('button',{name:'sendMessage'}));
 await waitFor(()=>expect(mocks.failed).toHaveBeenCalled());
 const message={...mocks.add.mock.calls[0][0],deliveryStatus:'failed'};
 Object.defineProperty(editor,'innerText',{configurable:true,value:'A newer unsent draft'});editor.textContent='A newer unsent draft';fireEvent.input(editor);
 mocks.retry!(message);await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
 expect(mocks.send.mock.calls[1][0]).toEqual(mocks.send.mock.calls[0][0]);expect(mocks.send.mock.calls[1][0].imageMessageIds).toEqual(['image']);expect(editor.textContent).toBe('A newer unsent draft');expect(mocks.replace).toHaveBeenCalledWith(message.clientMessageId,{id:message.clientMessageId,content:'Read this picture'});
});
