import {basename,dirname} from 'node:path';
import {Store} from '../personalComputer/store';
import {createPostgresPool} from '../../repositories/postgresPool';
import {PostgresStore} from '../../repositories/postgresStore';
import type {RoomStore} from '../../repositories/store';

// Test-only host adapter: the upstream restart/race tests use real PostgreSQL CAS.
export async function createStore({dataDir}:{dataDir:string}) {
  const url=process.env.ROOM_EVENT_TEST_DATABASE_URL;
  if(!url || !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1)))throw new Error('Choices persistence tests require a test/e2e database');
  const prefix=`jev-test-${basename(dirname(dataDir))}:`;
  const logger={debug(){},info(){},warn(){},error(){}};
  const pool=createPostgresPool(url,logger as any);
  const database=new PostgresStore(pool,logger as any);
  await database.initializeSchema();
  const ownerId=(owner:string)=>prefix+owner;
  const prepare=async(owner:string)=>{
    const clientId=ownerId(owner);
    if(!await database.getAccountByClientId(clientId))await database.createPasswordAccountForClient({clientId,accountId:clientId,now:new Date().toISOString()});
    await database.ensurePersonalAgentProfile(clientId);
  };
  const rooms={
    readPersonalComputerRecords:(owner:string,kind:string,id?:string)=>database.readPersonalComputerRecords(ownerId(owner),kind,id),
    putPersonalComputerRecord:async(owner:string,kind:string,id:string,data:Record<string,unknown>,insertOnly?:boolean)=>{await prepare(owner);return database.putPersonalComputerRecord(ownerId(owner),kind,id,data,insertOnly);},
    patchPersonalComputerRecord:(owner:string,kind:string,id:string,expected:Record<string,unknown>,patch:Record<string,unknown>)=>database.patchPersonalComputerRecord(ownerId(owner),kind,id,expected,patch),
  } as RoomStore;
  return Object.assign(new Store(rooms),{close:async(cleanup=true)=>{
    if(cleanup){await pool.query('DELETE FROM rooms WHERE creator_id LIKE $1',[prefix+'%']);await pool.query('DELETE FROM accounts WHERE id LIKE $1',[prefix+'%']);}
    await pool.end?.();
  }});
}
