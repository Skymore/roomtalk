import React from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { PersonalAgentStructuredResult } from './PersonalAgentStructuredResult';
import { MarkdownContent } from './MarkdownContent';
import { readPersonalAgentResultFile, readPersonalAgentResults, type PersonalAgentResult } from '../utils/personalAgent';
import type { RoomAgentTurn } from '../utils/types';

// The opaque frame keeps generated HTML away from the app's account credentials.
const privateWebPolicy = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline'; font-src data: https:; connect-src 'none'; base-uri 'none'; form-action 'none'";
const privateWebPreview = (html: string) => {
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy'; policy.content = privateWebPolicy;
  return `${policy.outerHTML}${html}`;
};

export const PersonalAgentResults: React.FC<{ clientId: string; turn: RoomAgentTurn; canInteract: boolean }> = ({ clientId, turn, canInteract }) => {
  const { t } = useTranslation();
  const [results, setResults] = React.useState<PersonalAgentResult[]>([]);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [preview, setPreview] = React.useState<{ result: PersonalAgentResult; text?: string; url?: string }>();
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  React.useEffect(() => {
    let live = true;
    setResults([]); setTotal(0); setError(''); setPreview(undefined);
    if (!canInteract) return;
    const load = async () => {
      try {
        const found = await readPersonalAgentResults(clientId, turn.roomId, turn.id);
        if (live) { setResults(found.results); setTotal(found.total); setError(''); }
      } catch (failure) { if (live) setError(failure instanceof Error ? failure.message : t('personalAgentLoadFailed')); }
    };
    void load();
    const interval = turn.status === 'running' ? window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000) : undefined;
    return () => { live = false; window.clearInterval(interval); };
  }, [clientId, turn.roomId, turn.id, turn.status, canInteract, attempt, t]);

  const open = async (result: PersonalAgentResult, download = false) => {
    if (busy || !canInteract) return;
    setBusy(result.id); setError(''); setCopied(false);
    try {
      const file = await readPersonalAgentResultFile(clientId, result.id);
      if (!mounted.current) return;
      if (download) {
        const url = URL.createObjectURL(file);
        const link = document.createElement('a'); link.href = url; link.download = result.filename; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (result.mimeType.startsWith('text/')) {
        const text = await file.text();
        if (mounted.current) setPreview({ result, text });
      } else if (result.mimeType === 'application/pdf' || result.mimeType.startsWith('image/')) {
        setPreview({ result, url: URL.createObjectURL(file) });
      } else setPreview({ result });
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : t('personalAgentLoadFailed')); }
    finally { if (mounted.current) setBusy(''); }
  };
  return <div className="mx-auto w-full max-w-3xl space-y-3 px-1">
    {results.map(result => <article key={result.id} className="space-y-3 rounded-[22px] bg-content2 p-[18px]" data-testid="personal-result-card">
      {result.kind!=='finance' && <><div className="flex items-start justify-between gap-3"><h3 className="break-words text-base font-semibold">{result.title}</h3><span className="shrink-0 rounded-full bg-default-100 px-2 py-1 text-xs text-default-500">{t(`personalResultKind_${result.kind}`)}</span></div>{result.summary && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-default-600">{result.summary}</p>}</>}
      {result.data?<div className="mt-3"><PersonalAgentStructuredResult clientId={clientId} result={result}/></div>:<div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" color="secondary" variant="flat" isDisabled={!canInteract || Boolean(busy)} isLoading={busy === result.id} onPress={() => void open(result)}>{t('personalResultOpen')}</Button>
        <Button size="sm" variant="light" isDisabled={!canInteract || Boolean(busy)} onPress={() => void open(result, true)} startContent={<Icon icon="lucide:download" />}>{t('personalResultDownload')}</Button>
      </div>}
    </article>)}
    {results.length < total && <Button size="sm" variant="light" isDisabled={!canInteract || Boolean(busy)} onPress={() => {
      setBusy('more'); void readPersonalAgentResults(clientId, turn.roomId, turn.id, results.length)
        .then(found => { if (mounted.current) { setResults(previous => [...previous, ...found.results]); setTotal(found.total); } })
        .catch(failure => { if (mounted.current) setError(failure.message); }).finally(() => { if (mounted.current) setBusy(''); });
    }}>{t('personalResultMore')}</Button>}
    {error && <div className="text-sm" role="alert"><p className="text-danger">{error}</p><Button size="sm" variant="light" onPress={() => setAttempt(value => value + 1)}>{t('retry')}</Button></div>}
    <Modal isOpen={Boolean(preview)} onClose={() => setPreview(undefined)} size="4xl" scrollBehavior="inside" classNames={{ base: 'max-h-[90dvh] bg-content1' }}>
      <ModalContent className="personal-agent-theme">{preview && <><ModalHeader className="min-w-0 break-words">{preview.result.title}</ModalHeader>
        <ModalBody>
          {preview.result.data ? <PersonalAgentStructuredResult clientId={clientId} result={preview.result} />
            : preview.result.kind === 'web' ? <iframe title={preview.result.title} srcDoc={privateWebPreview(preview.text || '')} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[60dvh] min-h-72 w-full rounded-xl border border-default-200 bg-white" />
            : preview.result.mimeType === 'text/markdown' ? <MarkdownContent content={preview.text || ''} />
            : preview.text !== undefined ? <pre className="whitespace-pre-wrap break-words text-sm leading-7">{preview.text}</pre>
            : preview.result.mimeType === 'application/pdf' && preview.url ? <iframe title={preview.result.title} src={preview.url} className="h-[60dvh] w-full rounded-xl border border-default-200" />
            : preview.url ? <img src={preview.url} alt={preview.result.title} className="max-h-[60dvh] max-w-full object-contain" />
            : <p className="text-default-500">{t('personalResultDownloadHint')}</p>}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          {preview.text !== undefined && preview.result.kind !== 'web' && <Button variant="light" onPress={() => { void navigator.clipboard.writeText(preview.text!).then(() => setCopied(true)).catch(failure => setError(failure.message)); }}>{t(copied ? 'personalResultCopied' : 'personalResultCopy')}</Button>}
          <Button variant="flat" isDisabled={Boolean(busy)} onPress={() => void open(preview.result, true)}>{busy ? <Spinner size="sm" /> : t('personalResultDownload')}</Button>
          <Button variant="light" onPress={() => setPreview(undefined)}>{t('close')}</Button>
        </ModalFooter></> }</ModalContent>
    </Modal>
  </div>;
};
