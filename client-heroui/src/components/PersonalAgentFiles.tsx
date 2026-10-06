import React from 'react';
import { Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { readPersonalAgentFiles, importPersonalAgentFile, readPersonalAgentFile, fillPersonalAgentFile, type PersonalAgentFile } from '../utils/personalAgent';
import { formatDate } from '../utils/formatters';

interface FileAction { (): Promise<void> }

// Port of OpenMuse FilesScreen / FileDetail; personal account APIs replace its workspace API.
export const PersonalAgentFiles: React.FC<{ clientId: string; initialFileId?:string; detailOnly?:boolean;onFileClose?:()=>void;showError: (message: string) => void }> = ({ clientId,initialFileId,detailOnly,onFileClose,showError }) => {
  const { t,i18n } = useTranslation();
  const [files,setFiles] = React.useState<PersonalAgentFile[]>([]),[total,setTotal] = React.useState(0);
  const [busy,setBusy] = React.useState(false),[selected,setSelected] = React.useState<PersonalAgentFile>();
  const [values,setValues] = React.useState<Record<string,string | boolean>>({});
  const [url,setUrl] = React.useState('');
  const picker = React.useRef<HTMLInputElement>(null),version = React.useRef(0);
  React.useEffect(() => () => { version.current++; },[]);
  React.useEffect(() => () => { if (url) URL.revokeObjectURL(url); },[url]);
  React.useEffect(() => {
    const current = ++version.current;
    void readPersonalAgentFiles(clientId).then(result => {
      if (current === version.current) { setFiles(result.files); setTotal(result.total); }
    }).catch(error => { if (current === version.current) showError(error.message); });
    return () => { version.current++; };
  },[clientId,showError]);
  const open = React.useCallback(async (file: PersonalAgentFile) => {
    const current = version.current;
    const blob = await readPersonalAgentFile(clientId,file.id);
    if (current !== version.current) return;
    setSelected(file);setUrl(URL.createObjectURL(blob));
    setValues(Object.fromEntries(file.fields.filter(field => field.type !== 'unsupported')
      .map(field => [field.name,field.type === 'checkbox' ? field.value === 'true' || field.value === 'Yes' : field.value])));
  },[clientId]);
  React.useEffect(()=>{
    if(!initialFileId)return;let alive=true;
    void readPersonalAgentFiles(clientId,0,initialFileId).then(value=>{const file=value.files.find(file=>file.id===initialFileId);if(file && alive)return open(file);}).catch(error=>{if(alive)showError(error.message);});
    return()=>{alive=false;};
  },[clientId,initialFileId,open,showError]);
  const act = async (action: FileAction) => {
    if (busy) return;setBusy(true);
    try { await action(); } catch (error) { showError(error instanceof Error ? error.message : t('personalAgentUpdateFailed')); }
    finally { setBusy(false); }
  };
  return <section className="space-y-5" data-testid="personal-files-view">
    <div className={detailOnly?'hidden':'contents'}>
    <div className="flex items-center justify-between gap-3"><p className="text-sm text-default-600">{t('personalFilesDescription')}</p>
      <Button color="secondary" size="sm" isLoading={busy} onPress={() => picker.current?.click()} startContent={<Icon icon="lucide:upload" />}>{t('personalFilesImport')}</Button>
      <input ref={picker} type="file" accept="application/pdf,.pdf" className="hidden" aria-label={t('personalFilesImport')} onChange={event => {
        const file = event.target.files?.[0];event.target.value='';
        if (file) void act(async () => {
          const saved = await importPersonalAgentFile(clientId,file);
          setFiles(previous => [saved.file,...previous]);setTotal(previous => previous+1);await open(saved.file);
        });
      }} />
    </div>
    {!files.length && <p className="rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-6 text-sm text-default-600 dark:border-[#30302e] dark:bg-[#1d1d1b]">{t('personalFilesEmpty')}</p>}
    <div className="grid gap-4 sm:grid-cols-2">{files.map(file => <button key={file.id} type="button" disabled={busy} onClick={() => void act(() => open(file))}
      className="overflow-hidden rounded-2xl border border-[#dedbd0] bg-[#faf9f5] text-left dark:border-[#30302e] dark:bg-[#1d1d1b]" data-testid="personal-file-card">
      <div className="flex h-36 items-center justify-center bg-[#edefea] dark:bg-[#30302e]"><Icon icon="lucide:file-text" className="h-16 w-16 text-[#697176]" /></div>
      <div className="space-y-2 p-5"><h3 className="break-words text-sm font-semibold">{file.name}</h3><p className="text-xs text-default-500">{t('personalFilesPages',{ count: file.pageCount })} · {Math.max(1,Math.round(file.byteSize/1024))} KB</p>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-default-500"><span>{file.parentId ? t('personalFilesFilledCopy') : t('personalFilesImported')}</span><span>{formatDate(file.createdAt,i18n.language)}</span></div>
      </div>
    </button>)}</div>
    {files.length < total && <Button variant="light" isLoading={busy} onPress={() => void act(async () => { const found=await readPersonalAgentFiles(clientId,files.length);setFiles(previous=>[...previous,...found.files]);setTotal(found.total); })}>{t('loadMore')}</Button>}
    </div>
    <Modal isOpen={Boolean(selected)} onClose={() => { setSelected(undefined);setUrl('');onFileClose?.(); }} isDismissable={!busy} scrollBehavior="inside" size="4xl" classNames={{base:'max-h-[90dvh] bg-white dark:bg-[#252522]'}}>
      <ModalContent>{selected && <><ModalHeader className="break-words">{selected.name}</ModalHeader><ModalBody>
        {url && <iframe src={url} title={selected.name} className="h-[50dvh] w-full rounded-xl border border-default-200" />}
        <Button variant="flat" onPress={() => { const link=document.createElement('a');link.href=url;link.download=selected.name;link.click(); }} startContent={<Icon icon="lucide:download" />}>{t('personalFilesDownload')}</Button>
        {selected.fields.length > 0 && <section className="space-y-4 rounded-2xl bg-default-50 p-4"><h3 className="font-semibold">{t('personalFilesFill')}</h3><p className="text-sm text-default-600">{t('personalFilesCopyHint')}</p>
          {selected.fields.map(function (field) {
            if (field.type === 'text') return <Input key={field.name} label={field.name} value={String(values[field.name] ?? '')} onValueChange={value => setValues(previous => ({ ...previous,[field.name]: value }))} />;
            if (field.type === 'checkbox') return <Checkbox key={field.name} isSelected={values[field.name] === true} onValueChange={value => setValues(previous => ({ ...previous,[field.name]: value }))}>{field.name}</Checkbox>;
            return <p key={field.name} className="text-sm text-default-500">{field.name} · {t('personalFilesUnsupported')}</p>;
          })}
          {selected.fields.some(field => field.type !== 'unsupported') && <Button color="secondary" isLoading={busy} onPress={() => void act(async () => {
            const saved=await fillPersonalAgentFile(clientId,selected.id,values);setFiles(previous=>[saved.file,...previous]);setTotal(previous=>previous+1);await open(saved.file);
          })}>{t('personalFilesSaveCopy')}</Button>}
        </section>}
      </ModalBody><ModalFooter><Button variant="light" onPress={() => { setSelected(undefined);setUrl('');onFileClose?.(); }}>{t('close')}</Button></ModalFooter></> }</ModalContent>
    </Modal>
  </section>;
};
