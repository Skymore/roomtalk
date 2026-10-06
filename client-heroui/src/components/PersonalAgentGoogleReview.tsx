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
// ReviewDetail port; original MIT notice is retained in personalAgentDateTime.ts.
import React from 'react';
import { Button,Modal,ModalBody,ModalContent,ModalFooter,ModalHeader } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { PersonalGoogleAction,personalGoogleRequest,PersonalAgentFile,readPersonalAgentFiles } from '../utils/personalAgent';

export const PersonalAgentGoogleReview: React.FC<{
  clientId:string;action:PersonalGoogleAction;onClose:()=>void;onDone:()=>void;onEdit?:(action:PersonalGoogleAction)=>void;
}> = ({clientId,action:initial,onClose,onDone,onEdit}) => {
  const {t} = useTranslation();
  const [action,setAction] = React.useState(initial),[busy,setBusy] = React.useState(false),[error,setError] = React.useState('');
  const [files,setFiles] = React.useState<PersonalAgentFile[]>([]);
  React.useEffect(()=>{void readPersonalAgentFiles(clientId).then(result=>setFiles(result.files)).catch(error=>setError(error.message));},[clientId]);
  const decide = async (decision:'approve'|'deny',edit = false) => {
    setBusy(true);setError('');
    try {
      const result = await personalGoogleRequest<{action:PersonalGoogleAction}>(clientId,`/actions/${encodeURIComponent(action.id)}/decide`,'POST',{expectedUpdatedAt:action.updatedAt,decision});
      setAction(result.action);onDone();
      if (edit && result.action.status === 'denied') onEdit?.(action);
    } catch(error) {setError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  const pending = action.status === 'awaiting_review', data = action.data;
  const labels = action.kind === 'email.send'
    ? [['personalGoogleTo',data.to],['personalGoogleCc',data.cc],['personalGoogleBcc',data.bcc],['personalGoogleSubject',data.subject],['personalGoogleMessage',data.body]]
    : [['personalGoogleTitle',data.title],['personalGoogleStart',data.start],['personalGoogleEnd',data.end],['personalGoogleTimeZone',data.timeZone],['personalGoogleLocation',data.location],['personalGoogleDescriptionField',data.description],['personalGoogleAttendees',data.attendees]];
  return <Modal isOpen onClose={onClose} scrollBehavior="inside" size="2xl"><ModalContent>
    <ModalHeader>{pending ? t('personalGoogleLastLook') : action.title}</ModalHeader>
    <ModalBody className="space-y-4">
      <p className="text-sm text-default-500">{t('personalGoogleReviewDescription')}</p>
      <p className="text-xs text-default-500">{t('personalGoogleAccount')}: {action.account}</p>
      <dl className="space-y-3 rounded-3xl border border-default-200 p-5">{labels.map(([label,value])=><div key={String(label)}><dt className="text-xs text-default-500">{t(String(label))}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{Array.isArray(value) ? value.join(', ') : String(value ?? '')}</dd></div>)}</dl>
      {Array.isArray(data.attachmentIds) && data.attachmentIds.length > 0 && <div><p className="text-xs text-default-500">{t('personalGoogleAttachments')}</p>{data.attachmentIds.map(id=><p key={String(id)} className="text-sm">{files.find(file=>file.id === id)?.name || String(id)}</p>)}</div>}
      {action.target && <section className="rounded-3xl bg-default-100 p-4"><p className="text-xs text-default-500">{t('personalGoogleCurrentEvent')}</p><p className="text-sm">{action.target.title}</p><p className="text-xs">{action.target.start} — {action.target.end}</p></section>}
      {action.result && <p className="text-sm" role="status">{action.result}</p>}
      {(error || action.error) && <p className="whitespace-pre-wrap text-sm text-danger" role="alert">{error || action.error}</p>}
      {!pending && <p className="text-sm text-default-500">{t(`personalGoogleAction_${action.status}`)}</p>}
    </ModalBody>
    <ModalFooter>{pending ? <>
      {onEdit && action.kind !== 'calendar.delete' && <Button variant="light" isDisabled={busy} onPress={()=>void decide('deny',true)}>{t('edit')}</Button>}
      <Button variant="light" isDisabled={busy} onPress={()=>void decide('deny')}>{t('personalGoogleDecline')}</Button>
      <Button color="secondary" isLoading={busy} onPress={()=>void decide('approve')}>{t(action.kind === 'email.send' ? 'personalGoogleSend' : 'personalGoogleConfirm')}</Button>
    </> : <Button onPress={onClose}>{t('close')}</Button>}</ModalFooter>
  </ModalContent></Modal>;
};
