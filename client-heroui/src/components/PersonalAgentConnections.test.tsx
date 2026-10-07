// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PersonalAgentConnections} from './PersonalAgentConnections';
const api=vi.hoisted(()=>({personalGoogleRequest:vi.fn()}));
vi.mock('../utils/personalAgent',()=>api);
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@iconify/react',()=>({Icon:()=>null}));
vi.mock('@heroui/react',()=>({
  Button:({children,onPress,isDisabled,...props}:Record<string,any>)=><button aria-label={props['aria-label']} disabled={isDisabled} onClick={onPress}>{children}</button>,
  Spinner:({label}:{label:string})=><span>{label}</span>,
  Modal:({children,isOpen}:Record<string,any>)=>isOpen?<div role="dialog">{children}</div>:null,
  ModalContent:({children}:Record<string,any>)=><div>{children}</div>,
  ModalHeader:({children}:Record<string,any>)=><h2>{children}</h2>,
  ModalBody:({children}:Record<string,any>)=><div>{children}</div>,
}));
const props=()=>({clientId:'owner',query:'',onOpen:vi.fn(),computerAvailable:true,onComputer:vi.fn(),showError:vi.fn()});
const google={configured:true,connected:true,account:'owner@example.com'};
describe('personal app navigation',()=>{
  beforeEach(()=>{vi.clearAllMocks();api.personalGoogleRequest.mockImplementation((_client:string,path:string)=>Promise.resolve(path==='/google'?google:{state:'disabled'}));});
  afterEach(cleanup);
  it('opens connected apps directly and retains a separate connection management action',async()=>{
    const callbacks=props();render(<PersonalAgentConnections {...callbacks}/>);
    fireEvent.click(await screen.findByRole('button',{name:'personalGoogleGmail'}));
    expect(callbacks.onOpen).toHaveBeenLastCalledWith('mail');expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'personalGoogleCalendar'}));
    expect(callbacks.onOpen).toHaveBeenLastCalledWith('calendar');
    fireEvent.click(screen.getByRole('button',{name:'personalAgentManageConnection: personalGoogleGmail'}));
    expect(screen.getByRole('dialog')).toBeTruthy();expect(screen.getByText(google.account)).toBeTruthy();
    expect(screen.getByRole('button',{name:'personalGoogleDisconnect'})).toBeTruthy();
  });
  it('keeps unavailable apps in the connect flow',async()=>{
    api.personalGoogleRequest.mockResolvedValue({configured:true,connected:false});
    const callbacks=props();render(<PersonalAgentConnections {...callbacks}/>);
    fireEvent.click(await screen.findByRole('button',{name:'personalGoogleGmail personalGoogleConnect'}));
    expect(screen.getByRole('dialog')).toBeTruthy();expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:/personalAgentManageConnection:/})).toBeNull();
  });
  it('searches tools without displaying a false empty result or an empty group',async()=>{
    const callbacks={...props(),query:'  personalAgentFiles  '};
    const view=render(<PersonalAgentConnections {...callbacks}/>);
    await waitFor(()=>expect(screen.queryByText('personalAgentLoading')).toBeNull());
    fireEvent.click(screen.getByRole('button',{name:/personalAgentFiles/}));expect(callbacks.onOpen).toHaveBeenCalledWith('files');
    expect(screen.queryByText('personalAppsNoApps')).toBeNull();expect(screen.queryByText('personalGoogleConnected')).toBeNull();
    view.rerender(<PersonalAgentConnections {...callbacks} query="no-such-app"/>);
    expect(screen.getByText('personalAppsNoApps')).toBeTruthy();expect(screen.queryByText('personalAgentTools')).toBeNull();
  });
  it('refreshes app status when returning from authorization',async()=>{
    api.personalGoogleRequest.mockResolvedValue({configured:true,connected:false});
    render(<PersonalAgentConnections {...props()}/>);
    await screen.findByRole('button',{name:'personalGoogleGmail personalGoogleConnect'});
    api.personalGoogleRequest.mockImplementation((_client:string,path:string)=>Promise.resolve(path==='/google'?google:{state:'disabled'}));
    fireEvent(window,new Event('focus'));
    await screen.findByRole('button',{name:'personalGoogleGmail'});
    expect(screen.getByRole('button',{name:'personalAgentManageConnection: personalGoogleGmail'})).toBeTruthy();
  });
});
