import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PersonalAgentResultService } from './personalAgentResults';
import type { PersonalAgentResult } from '../types';

const source = { clientId: 'owner', roomId: 'private', turnId: 'turn' };
const input = { kind: 'plan', title: 'A usable plan', summary: 'Two confirmed steps', filename: 'plan.md', content: Buffer.from('# Plan\n- [ ] First\n- [ ] Next').toString('base64') };
const fixture = () => {
  const rows: PersonalAgentResult[] = [], objects = new Map<string, Buffer>();
  let ended = false, failSave = false;
  const service = new PersonalAgentResultService({
    async savePersonalAgentResult(row: PersonalAgentResult) { if (failSave) throw new Error('database unavailable'); if (ended) return null; rows.push(row); return row; },
    async readPersonalAgentResults(owner: string, options: { id?: string } = {}) {
      const results = rows.filter(row => row.clientId === owner && (!options.id || options.id === row.id)); return { results, total: results.length };
    },
  } as any, {
    async putMediaObject(object: { objectKey: string; body: Buffer }) { objects.set(object.objectKey, object.body); },
    async getMediaObject(key: string) { const body = objects.get(key); if (!body) throw new Error('file unavailable'); return { body, byteSize: body.length }; },
    async deleteMediaObject(key: string) { objects.delete(key); },
  } as any, { error() {} } as any);
  return { service, rows, objects, end() { ended = true; }, fail() { failSave = true; } };
};
describe('persistent personal results', () => {
  it('retains actual files, strips private object keys and enforces owner reads', async () => {
    const { service, objects } = fixture();
    const saved = await service.save(source, { ...input, clientId: 'forged', roomId: 'forged', turnId: 'forged' });
    assert.equal(saved.result.roomId, source.roomId); assert.equal(saved.result.turnId, source.turnId);
    assert.equal('objectKey' in saved.result, false); assert.equal('clientId' in saved.result, false);
    assert.equal(objects.size, 1);
    assert.equal((await service.get('owner', saved.result.id))!.body.toString(), '# Plan\n- [ ] First\n- [ ] Next');
    assert.equal(await service.get('other', saved.result.id), null);
    assert.equal((await service.list('other', {})).total, 0);
  });
  it('removes uploaded objects if a turn ends or metadata persistence fails', async () => {
    const fixtureEnded = fixture(); fixtureEnded.end();
    await assert.rejects(fixtureEnded.service.save(source, input), /turn ended/); assert.equal(fixtureEnded.objects.size, 0);
    const fixtureFailed = fixture(); fixtureFailed.fail();
    await assert.rejects(fixtureFailed.service.save(source, input), /database unavailable/); assert.equal(fixtureFailed.objects.size, 0);
  });
  it('persists computed finance data with the original CSV and comparison objects', async () => {
    const {service}=fixture();
    const csv='date,description,amount,category\n2026-10-06,Salary,-1000,Income\n2026-10-06,Lunch,12.50,Food';
    const saved=await service.save(source,{...input,kind:'finance',filename:'transactions.csv',content:Buffer.from(csv).toString('base64')});
    assert.equal(saved.result.data!.spending,12.5);assert.equal(saved.result.data!.income,1000);assert.equal(saved.result.data!.saved,987.5);
    assert.equal((await service.get('owner',saved.result.id))!.body.toString(),csv);
    const options={options:[{name:'Train',source:'https://example.org/train'}]};
    const compared=await service.save(source,{...input,kind:'comparison',filename:'options.json',content:Buffer.from(JSON.stringify(options)).toString('base64')});
    assert.deepEqual(compared.result.data,options);
    await assert.rejects(service.save(source,{...input,kind:'finance',filename:'invented.csv'}),/CSV needs/);
    await assert.rejects(service.save(source,{...input,kind:'comparison',filename:'options.json',content:Buffer.from('[]').toString('base64')}),/object/);
  });
  it('validates encoding, names, formats and real byte limits before any upload', async () => {
    const { service, objects } = fixture();
    for (const invalid of [ { filename: '../secret.md' }, { kind: 'web' }, { filename: 'plan.pdf' }, { content: 'not-base64!' },
      { content: Buffer.from([0xff, 0xff]).toString('base64') }, { content: Buffer.alloc(512 * 1024 + 1).toString('base64') } ]) {
      await assert.rejects(service.save(source, { ...input, ...invalid }), RangeError);
    }
    assert.equal(objects.size, 0);
    const pdf = Buffer.alloc(4 * 1024 * 1024, 1);
    const saved = await service.save(source, { ...input, kind: 'document', filename: 'report.pdf', content: pdf.toString('base64') });
    assert.equal(saved.result.byteSize, pdf.length);
    assert.deepEqual((await service.get('owner', saved.result.id))!.body, pdf);
    await assert.rejects(service.save(source, { ...input, kind: 'document', filename: 'report.pdf', content: Buffer.alloc(pdf.length + 1).toString('base64') }), RangeError);
    await assert.rejects(service.list('owner', { limit: 0 }), RangeError);
  });
});
