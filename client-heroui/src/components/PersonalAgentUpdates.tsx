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

Ported from OpenMuse NotificationsSheet in agent-ui.tsx (73a7149).
*/
import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { readPersonalAgentNotifications, markPersonalAgentNotificationRead, type PersonalAgentNotification } from '../utils/personalAgent';
import type { Room } from '../utils/types';

export const PersonalAgentUpdates: React.FC<{
  clientId: string; rooms: Room[]; mode: 'banner'|'list'; enabled: boolean;
  onRoomSelect: (room: Room)=>void; onOpenUpdates: ()=>void; showError: (message: string)=>void;
}> = ({clientId,rooms,mode,enabled,onRoomSelect,onOpenUpdates,showError})=>{
  const {t}=useTranslation();
  const [updates,setUpdates]=React.useState<PersonalAgentNotification[]>([]),[total,setTotal]=React.useState(0),[unread,setUnread]=React.useState(0);
  const [busy,setBusy]=React.useState<string>();
  const [loading,setLoading]=React.useState(false);
  const receipts=React.useRef(new Map<string,PersonalAgentNotification>());
  const live=React.useRef(true),pending=React.useRef(false),loaded=React.useRef(50);loaded.current=Math.max(50,updates.length);
  React.useEffect(()=>{live.current=true;return()=>{live.current=false}},[]);
  const refresh=React.useCallback(async(offset=0,background=false)=>{
    if(!enabled||pending.current)return;pending.current=true;if(!background)setLoading(true);
    try {
      const found=await readPersonalAgentNotifications(clientId,mode==='banner',offset);
      if(background&&mode==='list')while(found.notifications.length<loaded.current&&found.notifications.length<found.total){
        const next=await readPersonalAgentNotifications(clientId,false,found.notifications.length);if(!next.notifications.length)break;found.notifications.push(...next.notifications);found.total=next.total;
      }
      if(!live.current)return;
      found.notifications=found.notifications.map(notice=>receipts.current.get(notice.id)||notice).filter(notice=>mode!=='banner'||!notice.readAt);
      setUpdates(previous=>offset ? [...previous,...found.notifications.filter(notice=>!previous.some(item=>item.id===notice.id))] : found.notifications);
      setTotal(found.total);setUnread(found.unread);
    }catch(error){if(live.current&&!background)showError(error instanceof Error ? error.message : String(error));}
    finally{pending.current=false;if(live.current&&!background)setLoading(false)}
  },[clientId,mode,enabled,showError]);
  React.useEffect(()=>{void refresh();if(!enabled)return;const timer=window.setInterval(()=>{if(!document.hidden)void refresh(0,true)},15000);return()=>window.clearInterval(timer)},[enabled,refresh]);
  const markRead=async(notice:PersonalAgentNotification)=>{
    if(busy)return false;setBusy(notice.id);
    try {const saved=await markPersonalAgentNotificationRead(clientId,notice.id);if(!live.current)return false;
      receipts.current.set(notice.id,saved.notification);
      setUpdates(previous=>mode==='banner' ? previous.filter(item=>item.id!==notice.id) : previous.map(item=>item.id===notice.id ? saved.notification : item));
      setUnread(previous=>Math.max(0,previous-(notice.readAt ? 0 : 1)));
      return true;
    }catch(error){if(live.current)showError(error instanceof Error ? error.message : String(error));return false;}finally{if(live.current)setBusy(undefined)}
  };
  if(!enabled||(mode==='banner'&&!updates.length))return null;
  const visible=mode==='banner' ? updates.slice(0,1) : updates;
  return <section className="space-y-3" aria-label={t('personalUpdates')}>
    {mode==='list'&&!loading&&!updates.length&&<div className="space-y-2 py-8 text-center"><Icon icon="lucide:bell" className="mx-auto h-6 w-6 text-default-400"/><p className="font-medium">{t('personalNotificationCaughtUp')}</p><p className="text-sm text-default-500">{t('personalNotificationEmptyHint')}</p></div>}
    {visible.map(notice=>{
      const room=rooms.find(value=>value.id===notice.roomId);
      return <article key={notice.id} className={`space-y-2 rounded-[22px] p-5 ${notice.readAt?'bg-[#f0f1f2] dark:bg-[#292b2d]':'bg-[#d7e9fa] dark:bg-[#263744]'}`} data-testid="personal-update-card">
      <div className="flex items-start justify-between gap-3"><h4 className="break-words font-semibold">{notice.title}</h4>{!notice.readAt && <span className="shrink-0 rounded-full bg-white/60 px-2 py-1 text-xs dark:bg-black/20">{t('personalNotificationNew')}</span>}</div>
      <p className="whitespace-pre-wrap break-words text-sm text-default-500">{notice.body}</p>
      <time className="block text-xs text-default-500">{new Date(notice.createdAt).toLocaleString()}</time>
      <div className="flex flex-wrap gap-2"><Button size="sm" isDisabled={Boolean(busy)} onPress={()=>{void markRead(notice).then(saved=>{if(saved && room)onRoomSelect(room);});}}>{t(room?'personalUpdateViewTask':notice.readAt?'personalNotificationRead':'personalUpdateRead')}</Button>
        {mode==='banner'&&unread>1&&<Button size="sm" variant="light" onPress={onOpenUpdates}>{t('personalUpdateMore',{count:unread-1})}</Button>}
      </div>
    </article>})}
    {mode==='list'&&updates.length<total&&<Button variant="light" isLoading={loading} onPress={()=>void refresh(updates.length)}>{t('loadMore')}</Button>}
  </section>;
};
