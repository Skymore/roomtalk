import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { PersonalAgentFileService } from './personalAgentFiles';
import { inspectPdf } from './personalAgentPdf';
import { PersonalAgentFile } from '../types';

export async function formPdf() {
  const doc=await PDFDocument.create(),page=doc.addPage();
  doc.getForm().createTextField('Full name').addToPage(page,{ x: 30,y: 650,width: 200,height: 30 });
  doc.getForm().createCheckBox('Confirmed').addToPage(page,{ x: 30,y: 590,width: 20,height: 20 });
  doc.getForm().createDropdown('Choice').addOptions(['One','Two']);
  return Buffer.from(await doc.save());
}
const fixture=()=>{
  const rows: PersonalAgentFile[]=[],objects=new Map<string,Buffer>();let ended=false;
  const service=new PersonalAgentFileService({
    async savePersonalAgentFile(file: PersonalAgentFile) { if(ended)return null;rows.push(file);return file; },
    async readPersonalAgentFiles(owner: string,options: { id?: string }={}) { const files=rows.filter(file=>file.clientId===owner&&(!options.id||file.id===options.id));return { files,total: files.length }; },
  } as any,{
    async putMediaObject(input: { objectKey: string;body: Buffer }) { objects.set(input.objectKey,input.body); },
    async getMediaObject(key: string) { return { body: objects.get(key) }; },
    async deleteMediaObject(key: string) { objects.delete(key); },
  } as any,{ error(){} } as any);
  return { service,rows,objects,end(){ ended=true; } };
};
describe('OpenMuse personal PDF files',()=>{
  it('inspects real form fields and preserves original bytes when saving a typed filled copy',async()=>{
    const { service }=fixture(),original=await formPdf();
    const saved=(await service.import('owner','form.pdf',original)).file;
    assert.equal(saved.pageCount,1);assert.equal(saved.fields.find(field=>field.name==='Choice')!.type,'unsupported');
    assert.equal('objectKey' in saved,false);assert.equal('clientId' in saved,false);
    const filled=(await service.fill('owner',saved.id,{ 'Full name':'Confirmed User',Confirmed:true })).file;
    assert.equal(filled.parentId,saved.id);assert.notEqual(filled.id,saved.id);
    assert.deepEqual((await service.get('owner',saved.id)).body,original);
    const fields=(await inspectPdf((await service.get('owner',filled.id)).body)).fields;
    assert.equal(fields.find(field=>field.name==='Full name')!.value,'Confirmed User');
    assert.equal(fields.find(field=>field.name==='Confirmed')!.value,'true');
    assert.equal((await service.list('owner')).total,2);
    assert.equal((await service.list('other')).total,0);
    await assert.rejects(service.get('other',saved.id),/not found/);
    await assert.rejects(service.fill('other',saved.id,{}),/not found/);
  });
  it('rejects unknown, unsupported and incorrectly typed fields without creating a filled copy',async()=>{
    const { service,objects }=fixture(),saved=(await service.import('owner','form.pdf',await formPdf())).file;
    for(const fields of [{ Unknown:'bad' },{ 'Full name':true },{ Confirmed:'true' },{ Choice:'One' }]) await assert.rejects(service.fill('owner',saved.id,fields));
    assert.equal(objects.size,1);assert.equal((await service.list('owner')).total,1);
    await assert.rejects(service.import('owner','fake.pdf',Buffer.from('not PDF')),/Invalid PDF/);
  });
  it('removes an uploaded object when an active source claim expires before metadata commit',async()=>{
    const test=fixture();test.end();
    await assert.rejects(test.service.import('owner','form.pdf',await formPdf(),'Saved in conversation',undefined,{ roomId:'room',turnId:'ended' }),/no longer available/);
    assert.equal(test.objects.size,0);assert.equal(test.rows.length,0);
  });
});
