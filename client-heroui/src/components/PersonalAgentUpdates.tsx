import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { PersonalAgentBrowserControl } from './PersonalAgentBrowser';
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
  const [browser,setBrowser]=React.useState<string>();
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
    if(busy)return;setBusy(notice.id);
    try {const saved=await markPersonalAgentNotificationRead(clientId,notice.id);if(!live.current)return;
      receipts.current.set(notice.id,saved.notification);
      setUpdates(previous=>mode==='banner' ? previous.filter(item=>item.id!==notice.id) : previous.map(item=>item.id===notice.id ? saved.notification : item));
      setUnread(previous=>Math.max(0,previous-(notice.readAt ? 0 : 1)));
    }catch(error){if(live.current)showError(error instanceof Error ? error.message : String(error));}finally{if(live.current)setBusy(undefined)}
  };
  if(!enabled||(mode==='banner'&&!updates.length))return null;
  const visible=mode==='banner' ? updates.slice(0,1) : updates;
  return <section className="space-y-3" aria-label={t('personalUpdates')}>
    {mode==='list'&&<div className="flex items-center justify-between gap-3"><h3 className="font-medium">{t('personalUpdates')}</h3><Button size="sm" variant="light" isLoading={loading} onPress={()=>void refresh()}>{t('refresh')}</Button></div>}
    {mode==='list'&&!loading&&!updates.length&&<p className="rounded-2xl bg-default-50 p-6 text-center text-sm text-default-500">{t('personalUpdatesEmpty')}</p>}
    {visible.map(notice=>{
      const room=rooms.find(value=>value.id===notice.roomId);
      return <article key={notice.id} className="space-y-3 rounded-2xl border border-default-200 bg-[#f0f4f1] p-4 dark:bg-[#252d27]" data-testid="personal-update-card">
      <div className="flex items-start gap-2"><Icon icon="lucide:bell" className="mt-1 shrink-0 text-secondary" />
        <div className="min-w-0 flex-1"><span className="block text-xs text-default-500">{t(notice.kind==='watch_match' ? 'personalUpdatePageChanged' : notice.kind==='watch_error' ? 'personalUpdateWatchNeedsAttention' : notice.kind==='task_error' ? 'personalAgentNeedsAttention' : 'personalUpdateTaskDone')}</span><h4 className="mt-1 break-words font-medium">{notice.title}</h4></div>
        {!notice.readAt&&<Button isIconOnly size="sm" variant="light" aria-label={t('personalUpdateDismiss')} isDisabled={Boolean(busy)} onPress={()=>void markRead(notice)}><Icon icon="lucide:x" /></Button>}</div>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm text-default-600">{notice.body}</p>
      {notice.source&&<details className="text-xs text-default-500"><summary className="cursor-pointer">{t('personalIdeaSource')}: {notice.source.title}</summary><p className="mt-2 break-all">{notice.source.url}</p><p className="mt-1">{new Date(notice.source.checkedAt).toLocaleString()}</p></details>}
      <div className="flex flex-wrap items-center gap-2">
        {room&&(notice.watchId ? <Button size="sm" variant="light" onPress={()=>setBrowser(room.id)}>{t('personalWatchOpenPage')}</Button>
          : <Button size="sm" variant="light" onPress={()=>onRoomSelect(room)}>{t('personalUpdateViewTask')}</Button>)}
        {mode==='list'&&!notice.readAt&&<Button size="sm" variant="light" isDisabled={Boolean(busy)} onPress={()=>void markRead(notice)}>{t('personalUpdateRead')}</Button>}
        {mode==='banner'&&unread>1&&<Button size="sm" variant="light" onPress={onOpenUpdates}>{t('personalUpdateMore',{count:unread-1})}</Button>}
        <time className="text-xs text-default-400">{new Date(notice.createdAt).toLocaleString()}</time>
      </div>
    </article>})}
    {mode==='list'&&updates.length<total&&<Button variant="light" isLoading={loading} onPress={()=>void refresh(updates.length)}>{t('loadMore')}</Button>}
    {browser&&<PersonalAgentBrowserControl key={browser} clientId={clientId} roomId={browser} isOpen onClose={()=>setBrowser(undefined)} />}
  </section>;
};
