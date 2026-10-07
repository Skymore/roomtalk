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
// CalendarScreen and EventEditor port; original MIT notice retained in personalAgentDateTime.ts.
import React from 'react';
import { Button,Checkbox,Input,Modal,ModalBody,ModalContent,ModalFooter,ModalHeader,Spinner,Textarea } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { PersonalCalendarChoice,PersonalCalendarEvent,PersonalGoogleAction,personalGoogleRequest } from '../utils/personalAgent';
import { localDateTime,zonedInstant } from '../utils/personalAgentDateTime';
import { PersonalAgentGoogleReview } from './PersonalAgentGoogleReview';

const plusDays = (date:string,days:number) => {const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);};
interface EventFields {
  id?:string;calendarId:string;title:string;startDate:string;startTime:string;endDate:string;endTime:string;
  allDay:boolean;timeZone:string;location:string;description:string;attendees:string;
}
function eventFields(event:PersonalCalendarEvent): EventFields {
  const start = event.allDay ? {date:event.start,time:'09:00'} : localDateTime(event.start,event.timeZone);
  const end = event.allDay ? {date:event.end,time:'10:00'} : localDateTime(event.end,event.timeZone);
  return {...event,startDate:start.date,startTime:start.time,endDate:end.date,endTime:end.time,attendees:event.attendees.join(', ')};
}
export const PersonalAgentCalendar: React.FC<{clientId:string}> = ({clientId}) => {
  const {t,i18n} = useTranslation();
  const [date,setDate] = React.useState(()=>localDateTime(new Date().toISOString(),Intl.DateTimeFormat().resolvedOptions().timeZone).date);
  const [calendars,setCalendars] = React.useState<PersonalCalendarChoice[]>([]);
  const [calendarId,setCalendarId] = React.useState('primary');
  const [events,setEvents] = React.useState<PersonalCalendarEvent[]>([]);
  const [all,setAll] = React.useState(false);
  const [busy,setBusy] = React.useState(false);
  const [error,setError] = React.useState('');
  const [retry,setRetry] = React.useState(0);
  const [editing,setEditing] = React.useState<EventFields>();
  const [action,setAction] = React.useState<PersonalGoogleAction>();
  const selected = calendars.find(item=>item.id === calendarId),zone = selected?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const writable = Boolean(selected && ['owner','writer'].includes(selected.accessRole));
  React.useEffect(()=>{
    let active = true;
    void personalGoogleRequest<{calendars:PersonalCalendarChoice[]}>(clientId,'/calendars').then(result=>{
      if (!active) return;setCalendars(result.calendars);
      setCalendarId(current=>result.calendars.some(item=>item.id === current) ? current : result.calendars[0]?.id || 'primary');
    }).catch(error=>{if(active)setError(error.message);});
    return ()=>{active=false;};
  },[clientId,retry]);
  React.useEffect(()=>{
    let active = true;setBusy(true);setError('');
    void Promise.resolve().then(()=>{
      const query = new URLSearchParams({calendarId,timeMin:zonedInstant(date,'00:00',zone),timeMax:zonedInstant(plusDays(date,all ? 30 : 1),'00:00',zone)});
      return personalGoogleRequest<{events:PersonalCalendarEvent[]}>(clientId,`/calendar/events?${query}`);
    }).then(result=>{if(active)setEvents(result.events.sort((a,b)=>a.start.localeCompare(b.start)));})
      .catch(error=>{if(active){setEvents([]);setError(error.message);}}).finally(()=>{if(active)setBusy(false);});
    return ()=>{active=false;};
  },[clientId,calendarId,date,all,zone,retry]);
  const conflicts=React.useMemo(()=>{
    if(!editing)return [];
    try{
      const start=Date.parse(editing.allDay?editing.startDate:zonedInstant(editing.startDate,editing.startTime,editing.timeZone));
      const end=Date.parse(editing.allDay?editing.endDate:zonedInstant(editing.endDate,editing.endTime,editing.timeZone));
      return events.filter(item=>item.id!==editing.id && start<Date.parse(item.end) && end>Date.parse(item.start));
    }catch{return [];}
  },[editing,events]);
  const propose = async (remove = false) => {
    if (!editing) return;setBusy(true);setError('');
    try {
      const data = {calendarId:editing.calendarId,title:editing.title,
        start:editing.allDay ? editing.startDate : zonedInstant(editing.startDate,editing.startTime,editing.timeZone),
        end:editing.allDay ? editing.endDate : zonedInstant(editing.endDate,editing.endTime,editing.timeZone),
        allDay:editing.allDay,timeZone:editing.timeZone,location:editing.location,description:editing.description,
        attendees:editing.attendees.split(/[,;\n]/).map(value=>value.trim()).filter(Boolean),...(editing.id ? {eventId:editing.id} : {})};
      const result = await personalGoogleRequest<{action:PersonalGoogleAction}>(clientId,'/actions','POST',{
        kind:remove ? 'calendar.delete' : editing.id ? 'calendar.update' : 'calendar.create',
        data:remove ? {calendarId:editing.calendarId,eventId:editing.id,title:editing.title} : data,
      });
      setEditing(undefined);setAction(result.action);
    } catch(error) {setError(error instanceof Error ? error.message : String(error));}
    finally {setBusy(false);}
  };
  const weekStart = plusDays(date,-new Date(`${date}T12:00:00Z`).getUTCDay());
  const newEvent = () => {setError('');setEditing({calendarId,title:'',startDate:date,startTime:'09:00',endDate:date,endTime:'10:00',allDay:false,timeZone:zone,location:'',description:'',attendees:''});};
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h2 className="font-serif text-2xl">{new Date(`${date}T12:00:00Z`).toLocaleDateString(i18n.language,{month:'long',year:'numeric',timeZone:'UTC'})}</h2><Button isIconOnly size="sm" variant="light" aria-label={t('personalGooglePreviousWeek')} onPress={()=>setDate(plusDays(date,-7))}>‹</Button><Button isIconOnly size="sm" variant="light" aria-label={t('personalGoogleNextWeek')} onPress={()=>setDate(plusDays(date,7))}>›</Button></div><Button color="secondary" isDisabled={!writable} onPress={newEvent}>{t('personalGoogleNewEvent')}</Button></div>
    {calendars.length>0 && <div className="flex flex-wrap gap-2">{calendars.map(item=><Button key={item.id} size="sm" variant={item.id === calendarId ? 'flat' : 'light'} onPress={()=>setCalendarId(item.id)}>{item.name}{!['owner','writer'].includes(item.accessRole) && ` · ${t('personalGoogleReadOnly')}`}</Button>)}</div>}
    <div className="flex justify-around rounded-3xl border border-default-200 bg-content1 p-3">{Array.from({length:7},(_,index)=>{
      const day=plusDays(weekStart,index);
      return <button key={day} type="button" onClick={()=>setDate(day)} className={`flex flex-1 flex-col items-center rounded-2xl py-3 ${day === date ? 'bg-secondary/15 text-foreground' : ''}`}><span className="text-xs text-default-500">{new Date(`${day}T12:00:00Z`).toLocaleDateString(i18n.language,{weekday:'short',timeZone:'UTC'})}</span><span className="mt-2 text-sm">{Number(day.slice(-2))}</span></button>;
    })}</div>
    <div className="flex items-center justify-between gap-3"><Button size="sm" variant="light" aria-pressed={all} onPress={()=>setAll(!all)}>{t(all ? 'personalGoogleToday' : 'personalGoogleUpcoming')}</Button><Button size="sm" variant="light" onPress={()=>setRetry(value=>value+1)}>{t('refresh')}</Button></div>
    {busy && <Spinner />}{error && !editing && <p className="break-words text-sm text-danger [overflow-wrap:anywhere]" role="alert">{error}</p>}
    {events.map(event=><button key={`${event.calendarId}:${event.id}`} type="button" className="flex w-full gap-4 rounded-3xl border border-default-200 bg-content1 p-5 text-left" onClick={()=>{setError('');setEditing(eventFields(event));}}><span className="text-xs text-default-500">{event.allDay ? t('personalGoogleAllDay') : new Date(event.start).toLocaleTimeString(i18n.language,{hour:'2-digit',minute:'2-digit',timeZone:event.timeZone})}</span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{event.title}</span><span className="mt-1 block text-xs text-default-500">{event.location}</span></span></button>)}
    {!busy && !error && !events.length && <p className="py-8 text-center text-sm text-default-500">{t('personalGoogleNoEvents')}</p>}
    <Modal isOpen={Boolean(editing)} onClose={()=>setEditing(undefined)} size="2xl" scrollBehavior="inside"><ModalContent className="personal-agent-theme"><ModalHeader>{t(editing?.id ? 'personalGoogleEditEvent' : 'personalGoogleNewEvent')}</ModalHeader><ModalBody className="space-y-4">{editing && <>
      <Input variant="bordered" labelPlacement="outside" label={t('personalGoogleTitle')} value={editing.title} onValueChange={title=>setEditing({...editing,title})} />
      <Checkbox isSelected={editing.allDay} onValueChange={allDay=>setEditing({...editing,allDay})}>{t('personalGoogleAllDay')}</Checkbox>
      <div className="grid grid-cols-2 gap-3"><Input variant="bordered" labelPlacement="outside" type="date" label={t('personalGoogleStart')} value={editing.startDate} onValueChange={startDate=>setEditing({...editing,startDate})} /><Input variant="bordered" labelPlacement="outside" type="date" label={t('personalGoogleEnd')} value={editing.endDate} onValueChange={endDate=>setEditing({...editing,endDate})} />{!editing.allDay && <><Input variant="bordered" labelPlacement="outside" type="time" label={t('personalGoogleStartTime')} value={editing.startTime} onValueChange={startTime=>setEditing({...editing,startTime})} /><Input variant="bordered" labelPlacement="outside" type="time" label={t('personalGoogleEndTime')} value={editing.endTime} onValueChange={endTime=>setEditing({...editing,endTime})} /></>}</div>
      <Input variant="bordered" labelPlacement="outside" label={t('personalGoogleTimeZone')} value={editing.timeZone} onValueChange={timeZone=>setEditing({...editing,timeZone})} />
      <Input variant="bordered" labelPlacement="outside" label={t('personalGoogleLocation')} value={editing.location} onValueChange={location=>setEditing({...editing,location})} />
      <Textarea variant="bordered" labelPlacement="outside" label={t('personalGoogleDescriptionField')} value={editing.description} onValueChange={description=>setEditing({...editing,description})} />
      <Input variant="bordered" labelPlacement="outside" label={t('personalGoogleAttendees')} value={editing.attendees} onValueChange={attendees=>setEditing({...editing,attendees})} />
    {conflicts.length>0 && <section className="space-y-2 rounded-2xl bg-warning/10 p-4"><h3 className="font-semibold">{t('personalGoogleTimeOverlaps')}</h3>{conflicts.map(event=><p key={event.id} className="text-sm text-default-600">{event.title} · {new Date(event.start).toLocaleTimeString(i18n.language,{hour:'2-digit',minute:'2-digit',timeZone:event.timeZone})}–{new Date(event.end).toLocaleTimeString(i18n.language,{hour:'2-digit',minute:'2-digit',timeZone:event.timeZone})}</p>)}</section>}
    </>}{error && <p className="break-words text-sm text-danger [overflow-wrap:anywhere]" role="alert">{error}</p>}</ModalBody><ModalFooter>{editing?.id && <Button color="danger" variant="light" isDisabled={!writable || busy} onPress={()=>void propose(true)}>{t('delete')}</Button>}<Button color="secondary" isLoading={busy} isDisabled={!writable} onPress={()=>void propose()}>{t('personalGoogleReviewEvent')}</Button></ModalFooter></ModalContent></Modal>
    {action && <PersonalAgentGoogleReview clientId={clientId} action={action} onClose={()=>setAction(undefined)} onDone={()=>setRetry(value=>value+1)} onEdit={value=>{setAction(undefined);const data=value.data as unknown as PersonalCalendarEvent;setEditing(eventFields({...data,id:value.kind === 'calendar.update' ? String(value.data.eventId) : ''}));}} />}
  </section>;
};
