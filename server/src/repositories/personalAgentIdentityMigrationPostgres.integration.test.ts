import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createPostgresPool} from './postgresPool';
import {PostgresStore} from './postgresStore';
import {POSTGRES_MIGRATIONS} from './postgresSchema';
const url=process.env.ROOM_EVENT_TEST_DATABASE_URL;
if(url && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1)))throw Error('Identity migration requires a test database');
test('OpenMuse identity migration preserves complete old preferences as sourced memory',{skip:!url},async()=>{
  const logger={info(){},warn(){},error(){},debug(){}};
  const pool=createPostgresPool(url!,logger as any),store=new PostgresStore(pool,logger as any);
  const owner=`identity-migration-${randomUUID()}`;
  await store.initializeSchema();await store.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});
  const profile=await store.ensurePersonalAgentProfile(owner);
  const client=await pool.connect!();
  try{
    await client.query('BEGIN');
    await client.query('ALTER TABLE personal_agent_profiles DROP CONSTRAINT personal_agent_avatar_check');
    const preferences='  用户确认的做事偏好\n保留原文与换行  ',about='原'.repeat(8001);
    await client.query('UPDATE personal_agent_profiles SET avatar=$2,instructions=$3,memory=$4 WHERE client_id=$1',[owner,'🦊',preferences,about]);
    await client.query(POSTGRES_MIGRATIONS.find(migration=>migration.id==='0048_personal_agent_openmuse_identity')!.sql);
    const {rows}=await client.query('SELECT * FROM personal_agent_memories WHERE client_id=$1 ORDER BY id',[owner]);
    const facts=rows.filter(row=>row.kind==='fact');assert.equal(facts.length,2);assert.equal(facts.map(row=>row.content).join(''),about);
    const preference=rows.find(row=>row.kind==='preference');assert.equal(preference.content,preferences);
    assert.equal(preference.source,'User added in Apps');assert.equal(preference.provenance[0].label,'User added in Apps');
    assert.equal(new Date(preference.created_at).toISOString(),profile.createdAt);
    const migrated=(await client.query('SELECT * FROM personal_agent_profiles WHERE client_id=$1',[owner])).rows[0];
    assert.equal(migrated.avatar,'sky');assert.equal(migrated.instructions,'');assert.equal(migrated.memory,'');
  }finally{
    await client.query('ROLLBACK');client.release?.();
    await pool.query('DELETE FROM rooms WHERE creator_id=$1',[owner]);await pool.query('DELETE FROM accounts WHERE id=$1',[owner]);await pool.end?.();
  }
});
