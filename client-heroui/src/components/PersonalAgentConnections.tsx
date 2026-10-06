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
// ConnectionsScreen port; original MIT notice is retained in personalAgentDateTime.ts.
import React from 'react';
import { Button,Modal,ModalBody,ModalContent,ModalHeader,Spinner } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { personalGoogleRequest,PersonalGoogleStatus } from '../utils/personalAgent';

interface OpenBotProbe {state:string}
export const PersonalAgentConnections: React.FC<{
  clientId:string;query:string;onOpen:(page:'mail'|'calendar')=>void;computerAvailable:boolean;onComputer:()=>void;showError:(message:string)=>void;
}> = ({clientId,query,onOpen,computerAvailable,onComputer,showError}) => {
  const {t} = useTranslation();
  const [status,setStatus] = React.useState<PersonalGoogleStatus>();
  const [openbot,setOpenbot]=React.useState<OpenBotProbe>();
  const [selected,setSelected] = React.useState<'google'|'openbot'>();
  const [busy,setBusy] = React.useState(false);
  const refresh = React.useCallback(async()=>{
    try {
      const google=personalGoogleRequest<PersonalGoogleStatus>(clientId,'/google');
      const bot=personalGoogleRequest<OpenBotProbe>(clientId,'/openbot');
      const [result,probe]=await Promise.all([google,bot]);setStatus(result);setOpenbot(probe);
    }
    catch(error) {showError(error instanceof Error ? error.message : String(error));}
  },[clientId,showError]);
  React.useEffect(()=>{void refresh();},[refresh]);
  const connect = async (capability:'read'|'write') => {
    setBusy(true);
    try {
      const result = await personalGoogleRequest<{url:string}>(clientId,'/google/connect','POST',{capability});
      window.open(result.url,'_blank','noopener,noreferrer');
    } catch (error) {showError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  const rows = [
    {id:'gmail',name:'Gmail',color:'#ea5b4d',group:'google',icon:'lucide:mail',connected:status?.connected ?? false,page:'mail' as const},
    {id:'calendar',name:'Google Calendar',color:'#4285f4',group:'google',icon:'lucide:calendar-days',connected:status?.connected ?? false,page:'calendar' as const},
    {id:'browser',name:t('personalComputerTitle'),color:'#1987cf',group:'browser',icon:'lucide:globe',connected:computerAvailable,page:undefined},
    {id:'openbot',name:'OpenBot',color:'#6866a6',group:'openbot',icon:'lucide:sparkles',connected:openbot?.state==='authenticated',page:undefined},
  ].filter(row=>`${row.name} ${row.group}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-5">
    {[true,false].map(connected=>{
      const group = rows.filter(row=>row.connected === connected);
      return group.length ? <section key={String(connected)}>
        <h3 className="mb-2 pl-3 text-xs text-default-500">{t(connected ? 'personalGoogleConnected' : 'personalGoogleAvailable')}</h3>
        <div className="divide-y divide-default-200 rounded-3xl bg-[#f3f4f5] px-4 dark:bg-[#252522]">{group.map(row=><button key={row.id} type="button" className="flex min-h-16 w-full items-center gap-3 text-left" onClick={()=>row.group==='browser'?onComputer():setSelected(row.group==='openbot'?'openbot':'google')}>
          <span className="flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] bg-white"><Icon icon={row.icon} className="h-[23px] w-[23px]" style={{color:row.color}}/></span><span className="flex-1 text-sm">{row.name}</span>
          <span className="text-xs text-default-500">{row.connected ? <Icon icon="lucide:chevron-right" /> : t(row.id === 'openbot' ? 'personalGoogleSetup' : 'personalGoogleConnect')}</span>
        </button>)}</div>
      </section> : null;
    })}
    {!rows.length && <p className="text-sm text-default-500">{t('personalAppsNoConnectors')}</p>}
    <Modal isOpen={Boolean(selected)} onClose={()=>setSelected(undefined)} scrollBehavior="inside"><ModalContent>
      <ModalHeader>{selected === 'google' ? t('personalGoogleConnections') : 'OpenBot'}</ModalHeader>
      <ModalBody className="pb-6">{selected === 'google' ? <div className="space-y-4">
        {!status && <Spinner />}
        <p className="text-sm text-default-500">{t('personalGoogleDescription')}</p>
        {status?.account && <p className="text-sm">{status.account}</p>}
        <p className="text-xs text-default-500">{t(status?.configured ? 'personalGoogleConfigured' : 'personalGoogleUnconfigured')}</p>
        {status?.connected && <div className="flex flex-wrap gap-2"><Button size="sm" onPress={()=>{setSelected(undefined);onOpen('mail');}}>{t('personalGoogleGmail')}</Button><Button size="sm" onPress={()=>{setSelected(undefined);onOpen('calendar');}}>{t('personalGoogleCalendar')}</Button></div>}
        <Button color="secondary" isLoading={busy} isDisabled={!status?.configured} onPress={()=>void connect('read')}>{t('personalGoogleConnectGoogle')}</Button>
        <Button isDisabled={!status?.configured || busy} onPress={()=>void connect('write')}>{t('personalGoogleWrite')}</Button>
        {status?.connected && <Button color="danger" variant="light" isDisabled={busy} onPress={()=>{void personalGoogleRequest(clientId,'/google/disconnect','POST',{}).then(refresh).catch(error=>{showError(error.message);void refresh();});}}>{t('personalGoogleDisconnect')}</Button>}
        <Button variant="light" onPress={()=>void refresh()}>{t('refresh')}</Button>
      </div> : <p className="pb-4 text-sm text-default-500">{t('personalOpenBotDisabled')}</p>}</ModalBody>
    </ModalContent></Modal>
  </div>;
};
