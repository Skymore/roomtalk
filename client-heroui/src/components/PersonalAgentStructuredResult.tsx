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

Ported from OpenMuse agent-ui.tsx ArtifactCard / FinanceArtifact (73a7149).
*/
import React from 'react';
import { Button, Input } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { createPersonalAgentGoal, type PersonalAgentResult } from '../utils/personalAgent';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
const display = (value: unknown) => typeof value==='string'?value:typeof value==='number'?value.toLocaleString():typeof value==='boolean'?value?'Yes':'No':value==null?'—':JSON.stringify(value,null,2) || '';

export const PersonalAgentStructuredResult: React.FC<{ clientId: string; result: PersonalAgentResult }> = ({ clientId,result }) => {
  const { t,i18n } = useTranslation();
  const [expanded,setExpanded] = React.useState(false),[details,setDetails] = React.useState(false);
  const [goalTitle,setGoalTitle] = React.useState(''),[saved,setSaved] = React.useState(false),[busy,setBusy] = React.useState(false),[error,setError] = React.useState('');
  const data = result.data || {};
  if (result.kind !== 'finance') return <section className="space-y-4" data-testid="personal-comparison-result">
    {Object.entries(data).slice(0,expanded ? undefined : 4).map(([key,value]) => <div key={key} className="space-y-2">
      <h4 className="text-xs font-semibold text-default-500">{key.replace(/_/g,' ')}</h4>
      {Array.isArray(value) ? value.slice(0,expanded ? 100 : 5).map((item,index) => <p key={index} className="break-words border-b border-default-200 py-2 text-sm">{record(item) ? Object.entries(record(item)!).map(([name,val]) => `${name}: ${display(val)}`).join(' · ') : display(item)}</p>) : record(value)?<div className="space-y-2">{Object.entries(record(value)!).map(([name,val])=><div key={name} className="flex justify-between gap-3 text-sm"><span className="text-default-500">{name}</span><span className="whitespace-pre-wrap break-words">{display(val)}</span></div>)}</div>:<p className={`whitespace-pre-wrap break-words ${typeof value==='number'?'text-2xl':'text-sm'}`}>{display(value)}</p>}
    </div>)}
    <Button size="sm" variant="light" onPress={() => setExpanded(value=>!value)}>{t(expanded ? 'personalResultSummary' : 'personalResultExplore')}</Button>
  </section>;
  const categories = Array.isArray(data.categories) ? data.categories : [],transactions = Array.isArray(data.transactions) ? data.transactions : [],period = record(data.period);
  const amount = (value: unknown) => Number(value ?? 0).toLocaleString(i18n.language,{ minimumFractionDigits: 2,maximumFractionDigits: 2 });
  return <section className="space-y-4" data-testid="personal-finance-result">
    <button type="button" aria-expanded={details} onClick={() => setDetails(value=>!value)} className="w-full rounded-2xl bg-content2 p-2 text-left">
      <div className="rounded-xl bg-primary p-4 text-primary-foreground">
        <p className="mb-5 text-xs text-primary-foreground/80">{t('personalFinanceSource')}<br />{String(period?.from ?? '')} — {String(period?.to ?? '')}<br />{t('personalFinanceCount',{ count: transactions.length })}</p>
        <div className="grid grid-cols-3 gap-2">{(['income','spending','saved'] as const).map(key => <div key={key} className="min-w-0 rounded-xl bg-content1 p-2 text-foreground"><p className="text-[10px] text-default-500">{t(`personalFinance_${key}`)}</p><p className={`mt-1 break-all text-sm font-semibold ${key === 'saved' ? 'text-success-700' : 'text-foreground'}`}>{amount(data[key])}</p><p className="mt-1 text-[8px] text-default-500">{t('personalFinanceCurrency')}</p></div>)}</div>
      </div><p className="p-3 text-sm font-semibold text-foreground">💸 {t('personalResultKind_finance')}</p>
    </button>
    {details && <div className="space-y-4 p-2"><h4 className="text-sm font-semibold">{t('personalFinanceCategories')}</h4>
      {categories.map(function (category) { const row = record(category);if (!row) return null;return <div key={String(row.name)} className="space-y-2"><div className="flex justify-between gap-3 text-sm"><span>{String(row.name)}</span><span>{amount(row.amount)}</span></div><div className="h-2 rounded-lg bg-content3"><div className="h-2 rounded-lg bg-secondary" style={{ width: `${Math.min(100,Number(row.amount)/(Number(data.spending)||1)*100)}%` }} /></div></div>; })}
      <p className="text-xs text-default-500">{t('personalFinanceConvention')}</p>
      {saved ? <p role="status" className="text-sm">{t('personalFinanceGoalSaved')}</p> : <div className="space-y-2"><Input variant="bordered" labelPlacement="outside" label={t('personalFinanceGoal')} value={goalTitle} onValueChange={setGoalTitle} maxLength={100} /><Button size="sm" color="secondary" isLoading={busy} isDisabled={!goalTitle.trim()} onPress={() => {
        setBusy(true);setError('');void createPersonalAgentGoal(clientId,{ title: goalTitle.trim(),category:'Finances',prompt: `Inspired by ${result.title}: ${result.summary}`,schedule:'manual',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,milestones:[{id:crypto.randomUUID(),title:t('personalFinanceTarget'),done:false},{id:crypto.randomUUID(),title:t('personalFinanceReview'),done:false}] })
          .then(()=>setSaved(true)).catch(failure=>setError(failure.message)).finally(()=>setBusy(false));
      }}>{t('personalFinanceCreateGoal')}</Button></div>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button size="sm" variant="light" onPress={()=>setExpanded(value=>!value)}>{t(expanded ? 'personalFinanceHide' : 'personalFinanceTransactions')}</Button>
      {expanded && transactions.slice(0,100).map(function (transaction) { const row = record(transaction);return row ? <div key={String(row.id)} className="flex justify-between gap-3 border-b border-default-200 py-2 text-sm"><div className="min-w-0"><p className="break-words">{String(row.description)}</p><p className="text-xs text-default-500">{String(row.date)} · {String(row.category)}</p></div><span>{amount(row.amount)}</span></div> : null; })}
      {expanded && transactions.length > 100 && <p className="text-xs text-default-500">{t('personalFinanceFirst100')}</p>}
    </div>}
  </section>;
};
