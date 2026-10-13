import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setTimeout as delay } from 'node:timers/promises';
import { LedgerService, type OwnerCycleResult } from '../ledger/service';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { createRuntimeMetrics } from '../runtimeMetrics';
import { releasePoolConfig } from '../ledger/releasePool';
import { fixtureChainSource } from './support/chainFixture';
import { fakeChainSource } from './support/fakeChainSource';
import { loadOpcodes } from '../utils/opcodes';
const address = (id: number) => `0:${id.toString(16).padStart(64,'0')}`;
const logger = {info(){},warn(){},error(){},debug(){}};
const until = async (condition: () => boolean) => {const end=Date.now()+5_000;while(!condition()){assert(Date.now()<end,'runtime made no progress');await delay(5);}};
const result = (): OwnerCycleResult => ({status:'quiet',generation:null,retry:false,pendingAccounts:[],confirmedRegressions:0,
  timings:{sourceMs:1,databaseMs:2,headMs:1,chainMs:2,graphMs:3,projectMs:4,publishMs:5,totalMs:15}});
async function database() {
  const db=new PGlite(); const pool: LedgerSqlPool={query:async(sql,args)=>!args&&sql.includes(';')?{rows:(await db.exec(sql)).at(-1)?.rows??[]}:db.query(sql,args),connect:async()=>pool,end:()=>db.close()};
  const store=new PostgresLedgerStore(pool);await store.initialize();return {pool,store};
}
async function priorityAndReadIsolation() {
  const {pool,store:readStore}=await database();const metrics=createRuntimeMetrics();
  const busy:LedgerSqlPool={query:async()=>{throw Error('API touched exhausted worker pool');},connect:async()=>{throw Error('API touched exhausted worker pool');},end:async()=>{}};
  const service=new LedgerService('localnet',new PostgresLedgerStore(busy),fakeChainSource(),loadOpcodes(),logger,2,{readStore,metrics});
  const calls:string[]=[], release:Array<()=>void>=[];
  service.runOwnerCycle=async account=>{calls.push(account);await new Promise<void>(resolve=>release.push(resolve));return result();};
  try {
    for(let id=1;id<=50;id++)(service as any).enqueue(address(id),'background');
    await until(()=>calls.length===1);assert.equal(calls[0],address(1));
    const person=address(101),poll=address(102);
    const page=await service.page(person);assert(!page.coverage.issues.includes('watch_capacity_reached'));
    await until(()=>calls.length===2);assert.equal(calls[1],person,'foreground uses the reserved worker ahead of fifty background owners');
    await service.discoveries(poll,{since:new Date(0).toISOString()});assert.equal(calls.length,2);
    release.shift()!();await until(()=>calls.length===3);assert.equal(calls[2],address(2),'discoveries does not jump the background queue');
    const text=metrics.prometheus();assert.match(text,/ledger_cycle_phase_ms.*phase="database"/);assert.match(text,/ledger_scheduler_depth/);assert.match(text,/ledger_foreground_oldest_ms/);
  }finally{const stopping=service.stop();for(const done of release.splice(0))done();await stopping;await pool.end();}
}
async function sweepAndPrewarm() {
  const {pool,store}=await database();const metrics=createRuntimeMetrics(), reads:string[]=[];
  const now=Math.floor(Date.now()/1000);
  const source=fixtureChainSource({physicalCurrentReads:true,head:async()=>({seqno:10,utime:now}),getAccountState:async account=>{
    reads.push(account);return {accountState:'uninitialized',balance:'0'};
  }});
  const singletons=Array.from({length:7},(_,i)=>address(i+201));
  const service=new LedgerService('localnet',store,source,loadOpcodes(),logger,2,{metrics,t3Hub:singletons[0],t3Root:singletons[1],perpsEngine:singletons[2],optionFactory:singletons[3],optionVault:singletons[4],router:singletons[5],marketBindings:[{pool:singletons[6]} as any]});
  try{
    service.start();await until(()=>singletons.every(a=>reads.includes(a)));
    await until(()=>!(service as any).scheduled.size);
    for(const account of singletons)assert.equal((await store.physicalAccount('localnet',account)).complete,true);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM ledger_watch_accounts')).rows[0].count),0,'prewarm consumes no watch allowance');
    const quiet=address(301),unresolved=address(302),recent=address(303);
    for(const account of [quiet,unresolved,recent])await store.admitWatch('localnet',account,1000);
    await pool.query("UPDATE ledger_watch_accounts SET requested_at=now()-interval '16 minutes' WHERE account<>$1",[recent]);
    await store.saveOwnerCheck('localnet',unresolved,{checkedAt:new Date().toISOString(),boundary:{seqno:10,utime:now},headVector:[],pendingAccounts:[unresolved],bindings:{},unresolved:true,errorCode:'source_unavailable'});
    const swept:string[]=[];const oldEnqueue=(service as any).enqueue;
    (service as any).enqueue=(account:string,priority:string)=>{assert.equal(priority,'background');swept.push(account);};
    await (service as any).sweep();assert.deepEqual(swept.sort(),[recent,unresolved].sort());(service as any).enqueue=oldEnqueue;
    await service.stop();
    const measured=new LedgerService('localnet',store,source,loadOpcodes(),logger,2,{metrics});
    try {const value=await measured.runOwnerCycle(address(401));assert.equal(value.status,'published');assert(value.timings.sourceMs>0);assert(value.timings.databaseMs>0);}
    finally{await measured.stop();}
  }finally{await service.stop();await pool.end();}
}
async function main(){
  await priorityAndReadIsolation();await sweepAndPrewarm();
  assert.equal(releasePoolConfig('postgres://127.0.0.1/test','a'.repeat(64),{size:19}).max,19);
  assert.equal(releasePoolConfig('postgres://127.0.0.1/test','a'.repeat(64),{size:10}).max,10);
  assert.throws(()=>releasePoolConfig('postgres://127.0.0.1/test','a'.repeat(64),{size:0}));
  console.log('Ledger foreground priority, discovery class, recent/unresolved sweep, singleton prewarm, isolated API reads and cycle/scheduler metrics passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
