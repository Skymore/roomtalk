import React from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { actInPersonalBrowser, takePersonalBrowserControl, releasePersonalBrowserControl,
  readPersonalBrowserObservations, readPersonalBrowserImage,
  type PersonalBrowserControl, type PersonalBrowserFrame, type PersonalBrowserObservation } from '../utils/personalAgent';
import type { RoomAgentTurn } from '../utils/types';

export const PersonalAgentBrowserControl: React.FC<{ clientId: string; roomId: string; initialUrl?:string; isOpen: boolean; onClose: () => void }> = ({ clientId, roomId, initialUrl, isOpen, onClose }) => {
  const { t } = useTranslation();
  const [frame, setFrame] = React.useState<PersonalBrowserFrame>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [address, setAddress] = React.useState('');
  const [text, setText] = React.useState('');
  const [savedDownloads,setSavedDownloads] = React.useState<string[]>([]);
  const [zoomed, setZoomed] = React.useState(false);
  const control = React.useRef<PersonalBrowserControl | undefined>(undefined);
  const busy = React.useRef(false);
  const inFlight = React.useRef<Promise<PersonalBrowserFrame> | undefined>(undefined);
  const live = React.useRef(false);
  const addressEdited = React.useRef(false);
  const generation = React.useRef(0);
  const update = React.useCallback(async (action: Record<string, unknown>, background = false) => {
    if (!live.current || !control.current) return false;
    if (busy.current) {
      if (background) return false;
      setLoading(true);
      try { await inFlight.current; } catch { /* The next user action can retry the browser. */ }
      if (!live.current || !control.current) return false;
    }
    const currentGeneration = generation.current;
    busy.current = true;
    if (!background) setLoading(true);
    try {
      const pending = actInPersonalBrowser(clientId, roomId, control.current, action);
      inFlight.current = pending;
      const observed = await pending;
      if (!live.current || generation.current !== currentGeneration) return false;
      setFrame(observed); setError('');
      if (action.action === 'import_pdf' && observed.file) setSavedDownloads(previous=>[...previous,String(action.id)]);
      if (!addressEdited.current) setAddress(observed.session.url === 'about:blank' ? '' : observed.session.url);
      return true;
    } catch (failure) {
      if (live.current && generation.current === currentGeneration) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally { if (generation.current === currentGeneration) { busy.current = false; inFlight.current = undefined; if (live.current && !background) setLoading(false); } }
  }, [clientId, roomId]);
  React.useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const effectGeneration = generation.current + 1; generation.current = effectGeneration; busy.current = false; live.current = true; setFrame(undefined); setSavedDownloads([]); setError(''); setLoading(true); setAddress(''); setText(''); setZoomed(false); addressEdited.current = false;
    void takePersonalBrowserControl(clientId, roomId).then(async saved => {
      if (!active) { await releasePersonalBrowserControl(clientId, roomId, saved.control); return; }
      control.current = saved.control;
      await update(initialUrl ? {action:'open',url:initialUrl} : { action: 'read' });
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (active) setLoading(false); });
    const timer = window.setInterval(() => { if (!document.hidden) void update({ action: 'read' }, true); }, 2500);
    return () => {
      active = false; generation.current = effectGeneration + 1; busy.current = false; live.current = false; window.clearInterval(timer);
      const held = control.current; control.current = undefined;
      if (held) void releasePersonalBrowserControl(clientId, roomId, held).catch(() => {});
    };
  }, [clientId, roomId, isOpen, update, initialUrl]);
  const close = async () => {
    if (loading) return;
    try { await inFlight.current; } catch { /* Release still works after a failed preview. */ }
    const held = control.current;
    if (!held) { onClose(); return; }
    live.current = false; generation.current++; setLoading(true);
    try {
      await releasePersonalBrowserControl(clientId, roomId, held);
      control.current = undefined; onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setLoading(false);
    }
  };
  const available = Boolean(frame?.screenshot) && !loading;
  return <Modal isOpen={isOpen} onClose={() => void close()} size="5xl" scrollBehavior="inside" classNames={{ base: 'bg-white dark:bg-[#252522]', wrapper: 'px-2 sm:px-4' }}>
    <ModalContent className="personal-agent-theme"><ModalHeader className="flex items-center gap-2"><Icon icon="lucide:globe" />{t('personalBrowser')}<span className="ml-2 min-w-0 truncate text-xs font-normal text-default-500">{frame?.session.title}</span></ModalHeader>
      <ModalBody className="gap-3 pb-5">
        <p className="text-xs text-default-500">{t('personalBrowserControlHint')}</p>
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); addressEdited.current = false; void update({ action: 'open', url: /^https?:\/\//i.test(address) ? address : `https://${address}` }); }}>
          <Input variant="bordered" labelPlacement="outside" aria-label={t('personalBrowserAddress')} placeholder="https://" value={address} onValueChange={value => { addressEdited.current = true; setAddress(value); }} isDisabled={!control.current || loading} />
          <Button type="submit" isDisabled={!control.current || !address.trim() || loading}>{t('personalResultOpen')}</Button>
        </form>
        {error && <p role="alert" className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="max-h-[50vh] overflow-auto rounded-xl border border-default-200 bg-default-50" data-testid="personal-browser-screen">
          {frame?.screenshot ? <img src={`data:image/jpeg;base64,${frame.screenshot}`} alt={t('personalBrowserLivePage')} style={{ width: zoomed ? '200%' : '100%', maxWidth: 'none' }} className={`block h-auto ${loading ? 'opacity-60' : 'cursor-crosshair'}`} draggable={false}
            onClick={event => {
              if (!available) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const width = frame.viewport?.width || 1280, height = frame.viewport?.height || 800;
              void update({ action: 'click', x: Math.min(width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * width / rect.width))), y: Math.min(height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * height / rect.height))) });
            }} /> : <p className="p-8 text-center text-sm text-default-500" role="status">{loading ? t('loading') : t('personalBrowserReconnect')}</p>}
        </div>
        {Boolean(frame?.downloads?.length) && <section className="space-y-2 rounded-xl border border-default-200 p-3"><h3 className="text-sm font-medium">{t('personalBrowserDownloads')}</h3>{frame?.downloads?.map(file => <div key={file.id} className="flex items-center justify-between gap-2"><span className="min-w-0 break-all text-xs">{file.name}</span><Button size="sm" variant="flat" isDisabled={loading || savedDownloads.includes(file.id)} onPress={()=>void update({action:'import_pdf',id:file.id})}>{t(savedDownloads.includes(file.id) ? 'personalBrowserPdfSaved' : 'personalBrowserImportPdf')}</Button></div>)}</section>}
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const value = text; void update({ action: 'text', text: value }).then(success => { if (success) setText(current => current === value ? '' : current); }); }}>
          <Input variant="bordered" labelPlacement="outside" aria-label={t('personalBrowserText')} placeholder={t('personalBrowserText')} value={text} onValueChange={setText} isDisabled={!available} autoComplete="off" />
          <Button type="submit" isDisabled={!available || !text}>{t('sendMessage')}</Button>
        </form>
        <div className="flex flex-wrap gap-2 [&_button]:min-h-11">
          {['Enter', 'Tab', 'Backspace'].map(key => <Button key={key} size="sm" variant="flat" isDisabled={!available} onPress={() => void update({ action: 'key', key })}>{key === 'Backspace' ? '⌫' : key}</Button>)}
          <Button size="sm" variant="flat" isDisabled={!available} aria-label={t('personalBrowserScrollUp')} onPress={() => void update({ action: 'scroll', deltaY: -600 })}><Icon icon="lucide:arrow-up" /></Button>
          <Button size="sm" variant="flat" isDisabled={!available} aria-label={t('personalBrowserScrollDown')} onPress={() => void update({ action: 'scroll', deltaY: 600 })}><Icon icon="lucide:arrow-down" /></Button>
          <Button size="sm" isIconOnly variant="flat" aria-label={t(zoomed ? 'personalBrowserZoomOut' : 'personalBrowserZoomIn')} onPress={() => setZoomed(value => !value)}><Icon icon={zoomed ? 'lucide:zoom-out' : 'lucide:zoom-in'} /></Button>
          <Button size="sm" variant="flat" isDisabled={!control.current || loading} onPress={() => void update({ action: 'read' })}>{t('refresh')}</Button>
          <Button size="sm" variant="flat" className="ml-auto" isDisabled={loading} onPress={() => void close()}>{t('personalBrowserReturn')}</Button>
        </div>
      </ModalBody>
    </ModalContent>
  </Modal>;
};

export const PersonalAgentBrowserVisits: React.FC<{ clientId: string; turn: RoomAgentTurn; canInteract: boolean }> = ({ clientId, turn, canInteract }) => {
  const { t } = useTranslation();
  const [visits, setVisits] = React.useState<PersonalBrowserObservation[]>([]);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState('');
  const [image, setImage] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    setVisits([]); setError(''); setTotal(0); setOpen(false); setExpanded(false);
    const refresh = async () => {
      try { const found = await readPersonalBrowserObservations(clientId, turn.roomId, turn.id); if (active) { setVisits(found.observations); setTotal(found.total); setError(''); } }
      catch (failure) { if (active) setError(failure instanceof Error ? failure.message : String(failure)); }
    };
    if (!canInteract) return () => { active = false; };
    void refresh();
    const timer = turn.status === 'running' ? window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000) : undefined;
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [clientId, turn.roomId, turn.id, turn.status, canInteract]);
  const latest = visits[0];
  const latestId = latest?.id;
  React.useEffect(() => {
    let active = true, objectUrl = '';
    setImage('');
    if (latestId && canInteract) void readPersonalBrowserImage(clientId, latestId).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setImage(objectUrl);
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [clientId, latestId, canInteract]);
  if (!canInteract || (!latest && !error)) return null;
  return <div className="mx-auto w-full max-w-3xl rounded-2xl border border-default-200 bg-white p-4 dark:bg-[#252522]" data-testid="personal-browser-visit">
    {latest && <>
      <div className="flex min-w-0 items-center gap-2"><Icon icon="lucide:globe" /><span className="min-w-0 truncate text-sm font-medium">{latest.title || t('personalBrowser')}</span></div>
      <p className="mt-1 break-all text-xs text-default-500">{latest.url}</p>
      <p className="mt-1 text-xs text-default-400">{t('personalBrowserVisited', { time: new Date(latest.createdAt).toLocaleString() })}</p>
      {image && <img src={image} alt={latest.title || latest.url} className="mt-3 w-full rounded-xl" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="flat" isDisabled={turn.status === 'running'} onPress={() => setOpen(true)}>{t('personalBrowserTakeControl')}</Button>
        {(visits.length > 1 || total > visits.length) && <Button size="sm" variant="light" onPress={() => setExpanded(value => !value)}>{t('personalBrowserHistory')}</Button>}
      </div>
      {expanded && <div className="mt-3 space-y-2 text-xs">{visits.slice(1).map(visit => <p key={visit.id} className="break-all text-default-500">{visit.title} · {visit.url} · {new Date(visit.createdAt).toLocaleString()}</p>)}
        {total > visits.length && <Button size="sm" variant="light" isLoading={loadingMore} onPress={() => {
          if (loadingMore) return; setLoadingMore(true);
          void readPersonalBrowserObservations(clientId, turn.roomId, turn.id, visits.length).then(found => { setVisits(previous => [...previous, ...found.observations]); setTotal(found.total); }).catch(failure => setError(failure.message)).finally(() => setLoadingMore(false));
        }}>{t('personalResultMore')}</Button>}
      </div>}
    </>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    <PersonalAgentBrowserControl clientId={clientId} roomId={latest?.browserRoomId || turn.roomId} isOpen={open} onClose={() => setOpen(false)} />
  </div>;
};
