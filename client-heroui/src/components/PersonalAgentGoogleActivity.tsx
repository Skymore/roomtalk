// ActivityScreen port; original MIT notice retained in personalAgentDateTime.ts.
import React from 'react';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { PersonalGoogleAction,personalGoogleRequest } from '../utils/personalAgent';
import { PersonalAgentGoogleReview } from './PersonalAgentGoogleReview';

interface ActionsResponse {actions:PersonalGoogleAction[]}
interface ActivityResponse {activity:WorkspaceActivity[]}
interface WorkspaceActivity {id:string;title:string;detail:string;date:string;status:string}
export const PersonalAgentGoogleActivity: React.FC<{clientId:string;showError:(message:string)=>void}> = ({clientId,showError}) => {
  const {t} = useTranslation();
  const [actions,setActions] = React.useState<PersonalGoogleAction[]>([]);
  const [activity,setActivity]=React.useState<WorkspaceActivity[]>([]);
  const [reviewOnly,setReviewOnly] = React.useState(false);
  const [selected,setSelected] = React.useState<PersonalGoogleAction>();
  const refresh = React.useCallback(async()=>{
    try {
      const actionsRequest=personalGoogleRequest<ActionsResponse>(clientId,'/actions');
      const timelineRequest=personalGoogleRequest<ActivityResponse>(clientId,'/activity');
      const [result,timeline]=await Promise.all([actionsRequest,timelineRequest]);
      setActions(result.actions);setActivity(timeline.activity);
    }
    catch(error) {showError(error instanceof Error ? error.message : String(error));}
  },[clientId,showError]);
  React.useEffect(()=>{void refresh();const timer=window.setInterval(()=>{if(!document.hidden)void refresh();},15000);return()=>window.clearInterval(timer);},[refresh]);
  return <section className="space-y-4">
    <div className="flex gap-2"><Button size="sm" variant={reviewOnly ? 'light' : 'flat'} onPress={()=>setReviewOnly(false)}>{t('personalGoogleAllActivity')}</Button><Button size="sm" variant={reviewOnly ? 'flat' : 'light'} onPress={()=>setReviewOnly(true)}>{t('personalGoogleNeedsReview')} · {actions.filter(action=>action.status === 'awaiting_review').length}</Button></div>
    {actions.some(action=>!reviewOnly || action.status==='awaiting_review') && <div className="rounded-[22px] bg-content2 p-5"><h4 className="mb-2 font-semibold">{t('personalWorkspaceYourActions')}</h4>{actions.filter(action=>!reviewOnly || action.status === 'awaiting_review').map(action=><button key={action.id} type="button" className="flex w-full items-center gap-4 border-b border-default-200 py-4 text-left" onClick={()=>setSelected(action)}>
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${action.status === 'awaiting_review' ? 'bg-warning/15 text-warning-700' : 'bg-success/15 text-success-700'}`}><Icon icon={action.status === 'awaiting_review' ? 'lucide:shield-check' : 'lucide:check-check'} className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1"><span className="block text-sm">{action.title}</span><span className="mt-1 block text-xs text-default-500">{new Date(action.createdAt).toLocaleString()}</span></span><span className="text-xs text-default-500">{t(`personalGoogleAction_${action.status}`)}</span>
    </button>)}</div>}
    {!reviewOnly && <div className="rounded-[22px] bg-content2 p-5"><h4 className="font-semibold">{t('personalWorkspaceTimeline')}</h4>{activity.map((item,index)=><article key={item.id} className={`flex items-start gap-4 py-4 ${index?'border-t border-default-200':''}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-default-100"><Icon icon="lucide:clock-3" className="text-default-500"/></span><div className="min-w-0 flex-1 space-y-1"><p className="text-sm">{item.title}</p><p className="whitespace-pre-wrap break-words text-sm text-default-500">{item.detail}</p><time className="block text-xs text-default-500">{new Date(item.date).toLocaleString()}</time></div><span className="rounded-full bg-default-100 px-2 py-1 text-xs">{t(`personalGoogleAction_${item.status}`)}</span></article>)}{!activity.length && <div className="space-y-2 py-6 text-center"><Icon icon="lucide:clock-3" className="mx-auto text-default-400"/><p className="font-medium">{t('personalWorkspaceBeginning')}</p><p className="text-sm text-default-500">{t('personalWorkspaceTimelineEmpty')}</p></div>}</div>}
    {reviewOnly && !actions.some(action=>action.status==='awaiting_review') && <div className="space-y-2 rounded-[22px] bg-content2 p-6 text-center"><Icon icon="lucide:shield-check" className="mx-auto text-default-400"/><p className="font-medium">{t('personalNotificationCaughtUp')}</p><p className="text-sm text-default-500">{t('personalWorkspaceReviewEmpty')}</p></div>}
    {selected && <PersonalAgentGoogleReview clientId={clientId} action={selected} onClose={()=>setSelected(undefined)} onDone={()=>void refresh()} />}
  </section>;
};
