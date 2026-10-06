import React from 'react';
import {Button, Spinner} from '@heroui/react';
import {useTranslation} from 'react-i18next';
import {readComputer} from '../../utils/personalComputer';

// Port of OpenMuse desktop-stream.tsx: retain the live VNC session through refreshes.
// MIT notice is in drafts.tsx in this directory.
export const DesktopStream=React.memo(function DesktopStream({clientId,running,embed=true}:{clientId:string;running:boolean;embed?:boolean}){
  const {t}=useTranslation();
  const [url,setUrl]=React.useState(''),[error,setError]=React.useState(''),[opening,setOpening]=React.useState(false);
  React.useEffect(()=>{
    if(!running || !embed)return;
    let alive=true,loaded=false,since=Date.now(),retry:ReturnType<typeof setTimeout>|undefined;
    const load=(force=false)=>{
      if(!force && (document.hidden || Date.now()-since>60*60000))return;
      void readComputer<{url:string}>(clientId,'desktop-url').then(value=>{
        if(!alive)return;loaded=true;setUrl(value.url);setError('');
      }).catch(error=>{
        if(!alive || loaded)return;setError(error.message);clearTimeout(retry);retry=setTimeout(()=>load(true),5000);
      });
    };
    const visible=()=>{if(document.hidden)return;since=Date.now();load();};
    load(true);const interval=setInterval(load,120000);document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearInterval(interval);clearTimeout(retry);document.removeEventListener('visibilitychange',visible);};
  },[clientId,running,embed]);
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {running && embed && !url && !error && <Spinner/>}
    {url && embed && <iframe title={t('personalComputerDesktopTitle')} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock" allow="clipboard-read; clipboard-write" className="h-[50dvh] min-h-64 w-full rounded-xl border border-default-200"/>}
    {running && (!embed || url) && <Button isLoading={opening} onPress={()=>{
      const target=window.open('about:blank','_blank');setOpening(true);setError('');
      void (url?Promise.resolve({url}):readComputer<{url:string}>(clientId,'desktop-url')).then(value=>{if(target){target.opener=null;target.location.href=value.url;}})
        .catch(error=>{target?.close();setError(error.message);}).finally(()=>setOpening(false));
    }}>{t('personalComputerOpenDesktop')}</Button>}
  </div>;
});
