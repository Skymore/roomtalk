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
// MailScreen, MailDetail and EmailEditor port; MIT notice retained in personalAgentDateTime.ts.
import React from 'react';
import { Button,Checkbox,Input,Modal,ModalBody,ModalContent,ModalFooter,ModalHeader,Spinner,Textarea } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { personalGoogleRequest,PersonalMail,PersonalEmailDraft,PersonalGoogleAction,PersonalAgentFile,readPersonalAgentFiles } from '../utils/personalAgent';
import { formatDate } from '../utils/formatters';
import { PersonalAgentGoogleReview } from './PersonalAgentGoogleReview';

const emptyDraft: PersonalEmailDraft = {to:[],cc:[],bcc:[],subject:'',body:'',attachmentIds:[]};
const addresses = (value:string) => value.split(/[,;\n]/).map(value=>value.trim()).filter(Boolean);
export const PersonalAgentMail: React.FC<{clientId:string;showError:(message:string)=>void;onOpenFiles:()=>void;initialMail?:PersonalMail;onMailOpened?:()=>void}> = ({clientId,showError,onOpenFiles,initialMail,onMailOpened}) => {
  const {t,i18n} = useTranslation();
  const [mail,setMail] = React.useState<PersonalMail[]>([]);
  const [drafts,setDrafts] = React.useState<PersonalEmailDraft[]>([]);
  const [tab,setTab] = React.useState<'all'|'unread'|'drafts'>('all');
  const [query,setQuery] = React.useState('');
  const [busy,setBusy] = React.useState(false);
  const [thread,setThread] = React.useState<PersonalMail[]>();
  const [selected,setSelected] = React.useState<PersonalMail>();
  const [editing,setEditing] = React.useState<PersonalEmailDraft>();
  const [action,setAction] = React.useState<PersonalGoogleAction>();
  const [addressText,setAddressText] = React.useState({to:'',cc:'',bcc:''});
  const openEditor = (draft:PersonalEmailDraft) => {setEditing(draft);setAddressText({to:draft.to.join(', '),cc:draft.cc.join(', '),bcc:draft.bcc.join(', ')});};
  const [files,setFiles] = React.useState<PersonalAgentFile[]>([]);
  const [error,setError] = React.useState('');
  const refresh = React.useCallback(async()=>{
    setBusy(true);setError('');
    const results = await Promise.allSettled([
      personalGoogleRequest<{mail:PersonalMail[]}>(clientId,'/mail'),
      personalGoogleRequest<{drafts:PersonalEmailDraft[]}>(clientId,'/drafts'),
      readPersonalAgentFiles(clientId),
    ]);
    if (results[0].status === 'fulfilled') setMail(results[0].value.mail); else setError(results[0].reason.message);
    if (results[1].status === 'fulfilled') setDrafts(results[1].value.drafts); else showError(results[1].reason.message);
    if (results[2].status === 'fulfilled') setFiles(results[2].value.files); else showError(results[2].reason.message);
    setBusy(false);
  },[clientId,showError]);
  React.useEffect(()=>{void refresh();},[refresh]);
  const openThread = React.useCallback(async (message:PersonalMail) => {
    setSelected(message);setThread([message]);setBusy(true);setError('');
    try {setThread((await personalGoogleRequest<{mail:PersonalMail[]}>(clientId,`/mail/threads/${encodeURIComponent(message.threadId)}`)).mail);}
    catch(error) {setError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  },[clientId]);
  React.useEffect(()=>{if(initialMail){void openThread(initialMail);onMailOpened?.();}},[initialMail,onMailOpened,openThread]);
  const importAttachment = async (reference:string) => {
    setBusy(true);setError('');
    try {
      if (!files.some(file=>file.id === reference)) await personalGoogleRequest(clientId,'/mail/attachments','POST',{reference});
      onOpenFiles();
    } catch(error) {setError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  const saveDraft = async (review:boolean) => {
    if (!editing) return;
    setBusy(true);setError('');
    try {
      if (review) {
        const result = await personalGoogleRequest<{action:PersonalGoogleAction}>(clientId,'/actions','POST',{kind:'email.send',data:{...editing,to:addresses(addressText.to),cc:addresses(addressText.cc),bcc:addresses(addressText.bcc)}});
        setEditing(undefined);setAction(result.action);
      } else {
        const {updatedAt,...draft} = {...editing,to:addresses(addressText.to),cc:addresses(addressText.cc),bcc:addresses(addressText.bcc)};
        await personalGoogleRequest(clientId,'/drafts','POST',{...draft,...(updatedAt ? {expectedUpdatedAt:updatedAt} : {})});
        setEditing(undefined);await refresh();
      }
    } catch(error) {setError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  const items = mail.filter(message=>(tab !== 'unread' || message.unread) && `${message.sender} ${message.subject} ${message.body}`.toLowerCase().includes(query.toLowerCase()));
  const matchingDrafts = drafts.filter(draft=>`${draft.to.join(' ')} ${draft.subject} ${draft.body}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-5">
    <div className="flex items-center gap-3"><Input variant="bordered" labelPlacement="outside" aria-label={t('personalGoogleSearchMail')} placeholder={t('personalGoogleSearchMail')} value={query} onValueChange={setQuery} startContent={<Icon icon="lucide:search" />} /><Button color="secondary" onPress={()=>{setError('');openEditor({...emptyDraft});}}>{t('personalGoogleCompose')}</Button></div>
    <div className="rounded-3xl border border-default-200 bg-white p-5 dark:bg-[#20201f]">
      <div className="mb-4 flex flex-wrap gap-2">{(['all','unread','drafts'] as const).map(value=><Button key={value} size="sm" variant={value === tab ? 'flat' : 'light'} onPress={()=>setTab(value)}>{t(`personalGoogleMail_${value}`)}</Button>)}<Button size="sm" variant="light" isLoading={busy} onPress={()=>void refresh()}>{t('refresh')}</Button></div>
      {error && !selected && !editing && <p className="mb-3 text-sm text-danger" role="alert">{error}</p>}
      {tab === 'drafts' ? matchingDrafts.map(draft=><button key={draft.id} type="button" className="block w-full border-t border-default-200 py-5 text-left" onClick={()=>{setError('');openEditor(draft);}}><span className="block text-sm font-medium">{draft.subject}</span><span className="mt-1 block text-xs text-default-500">{draft.to.join(', ')}</span></button>) : items.map(message=><button key={message.id} type="button" className="flex w-full gap-3 border-t border-default-200 py-5 text-left" onClick={()=>void openThread(message)}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e8edf2] text-sm text-[#38414a]">{message.sender.slice(0,1)}</span>
        <span className="min-w-0 flex-1"><span className="flex justify-between gap-3"><span className={`text-sm ${message.unread ? 'font-semibold' : ''}`}>{message.sender}</span><span className="text-xs text-default-500">{formatDate(message.date,i18n.language)}</span></span><span className="mt-1 block text-sm font-medium">{message.subject}</span><span className="mt-1 block truncate text-xs text-default-500">{message.body.replace(/\n/g,' ')}</span>{message.attachments.length>0 && <Icon icon="lucide:paperclip" className="mt-2 h-3 w-3" />}</span>
        {message.unread && <span className="mt-2 h-1.5 w-1.5 rounded-full bg-[#83b5d3]" />}
      </button>)}
      {(tab === 'drafts' ? !matchingDrafts.length : !items.length) && <p className="py-8 text-center text-sm text-default-500">{t(tab === 'drafts' ? 'personalGoogleNoDrafts' : 'personalGoogleNoMail')}</p>}
    </div>
    <Modal isOpen={Boolean(selected)} onClose={()=>{setSelected(undefined);setThread(undefined);}} size="2xl" scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{selected?.subject}</ModalHeader><ModalBody>
      {busy && <Spinner />}
      {thread?.map(message=><article key={message.id} className="space-y-4 rounded-3xl border border-default-200 p-5"><header><p className="text-sm font-semibold">{message.sender}</p><p className="text-xs text-default-500">{message.from}</p><p className="text-xs text-default-500">{t('personalGoogleTo')}: {message.to.join(', ')}</p><p className="text-xs text-default-500">{formatDate(message.date,i18n.language)}</p></header><p className="whitespace-pre-wrap break-words border-t border-default-200 pt-4 text-sm leading-6">{message.body}</p>{message.attachments.map(ref=><Button key={ref} size="sm" variant="light" isDisabled={busy} onPress={()=>void importAttachment(ref)}>{files.find(file=>file.id === ref)?.name || decodeURIComponent(ref.split(':').slice(2).join(':')) || t('personalGoogleAttachments')}</Button>)}</article>)}
      {error && <><p className="text-sm text-danger" role="alert">{error}</p>{selected && <Button onPress={()=>void openThread(selected)}>{t('retry')}</Button>}</>}
    </ModalBody><ModalFooter><Button color="secondary" onPress={()=>{if (selected) {openEditor({...emptyDraft,to:[selected.from],subject:/^re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`,threadId:selected.threadId,replyToMessageId:selected.id});setSelected(undefined);setError('');}}}>{t('personalGoogleReply')}</Button></ModalFooter></ModalContent></Modal>
    <Modal isOpen={Boolean(editing)} onClose={()=>setEditing(undefined)} size="2xl" scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{t(editing?.threadId ? 'personalGoogleReply' : 'personalGoogleCompose')}</ModalHeader><ModalBody className="space-y-4">
      {editing && <>
        {(['to','cc','bcc'] as const).map(field=><Input variant="bordered" labelPlacement="outside" key={field} label={t(`personalGoogle${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}`)} value={addressText[field]} onValueChange={value=>setAddressText({...addressText,[field]:value})} />)}
        <Input variant="bordered" labelPlacement="outside" label={t('personalGoogleSubject')} value={editing.subject} onValueChange={subject=>setEditing({...editing,subject})} />
        <Textarea variant="bordered" labelPlacement="outside" label={t('personalGoogleMessage')} minRows={7} value={editing.body} onValueChange={body=>setEditing({...editing,body})} />
        {files.length>0 && <section className="space-y-3"><h3 className="text-sm font-medium">{t('personalGoogleAttachments')}</h3>{files.map(file=><Checkbox key={file.id} isSelected={editing.attachmentIds.includes(file.id)} onValueChange={selected=>setEditing({...editing,attachmentIds:selected ? [...editing.attachmentIds,file.id] : editing.attachmentIds.filter(id=>id !== file.id)})}>{file.name}</Checkbox>)}</section>}
      </>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </ModalBody><ModalFooter><Button isDisabled={busy} onPress={()=>void saveDraft(false)}>{t('personalGoogleSaveDraft')}</Button><Button color="secondary" isLoading={busy} onPress={()=>void saveDraft(true)}>{t('personalGoogleReviewEmail')}</Button></ModalFooter></ModalContent></Modal>
    {action && <PersonalAgentGoogleReview clientId={clientId} action={action} onClose={()=>setAction(undefined)} onDone={()=>void refresh()} onEdit={value=>{setAction(undefined);openEditor(value.data as unknown as PersonalEmailDraft);}} />}
  </section>;
};
