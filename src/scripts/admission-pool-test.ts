import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Cell, TupleItem } from '@ton/core';
import { AdmissionWorkerDiagnostic, NativeAdmissionPool } from '../data/admission/nativePool';
import { AdmissionError } from '../data/admission/protocol';
import { publicAdmissionError } from '../api/errors';
import type { Logger } from '../utils/logger';
import { setTimeout as delay } from 'node:timers/promises';

const fixturePath = join(__dirname,'fixtures/native-admission/captured.json'), fixture = JSON.parse(readFileSync(fixturePath,'utf8'));
const args: TupleItem[] = fixture.request.stack.map((v: any) => v.number ? { type: 'int', value: BigInt(v.number.number) } :
  v.cell ? { type: 'cell', cell: Cell.fromBase64(v.cell.bytes) } : { type: 'slice', cell: Cell.fromBase64(v.slice.bytes) });
const originalNow = Date.now; Date.now = () => fixture.historicalAt;
const directory = mkdtempSync(join(tmpdir(),'ton-admission-pool-test-'));
const binaryPath=join(directory,'offline-fixture-worker'), hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
// Local protocol fixture only. This executable has no TON client, network,
// signer or proof-verification capability; it exercises supervisor lifecycle.
writeFileSync(binaryPath,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
const c=JSON.parse(fs.readFileSync(process.argv[2])),f=JSON.parse(fs.readFileSync(c.fixture));
fs.writeFileSync(path.join(c.directory,String(process.pid)+'.pid'),'owned fixture');
if(c.mode==='one-warm-one-failed'||c.mode==='one-warm-one-cold'||c.mode==='one-dead-one-warm'){
  const claim=suffix=>{try{fs.closeSync(fs.openSync(c.attempts+suffix,'wx'));return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}};
  if(claim('.first'))c.mode=c.mode==='one-dead-one-warm'?'ready-then-failure':c.mode==='one-warm-one-failed'?'delayed-ready':'busy';
  else if(claim('.second'))c.mode=c.mode==='one-dead-one-warm'?'delayed-ready':c.mode==='one-warm-one-failed'?'startup-failure':'cold';
  else c.mode='busy';
}
if(c.mode==='recover'){const attempts=path.join(c.directory,'recovery-attempts');fs.appendFileSync(attempts,'x');if(fs.readFileSync(attempts).length<=4)c.mode='startup-failure';}
if(c.mode==='recover-after-loss'||c.mode==='close-in-backoff'){
  fs.appendFileSync(c.attempts+'.pids',String(process.pid)+'\\n');
  fs.appendFileSync(c.attempts,'x');const attempt=fs.readFileSync(c.attempts).length;
  if(attempt<=2)c.mode='die-on-request';
  else if(c.mode==='close-in-backoff'||attempt<=6)c.mode='startup-failure';
}
if(c.mode==='exit-before-ready'){process.stderr.write(Buffer.concat([Buffer.alloc(5000,120),Buffer.from('ADMISSION_WORKER: stale clock\\n\\u001b[31m\\u202e')]),()=>process.exit(70));}
else if(c.mode==='stderr-overflow'){process.stderr.write(Buffer.alloc(1024*1024+1,65));setInterval(()=>{},1000);}
else if(c.mode==='cold'){setInterval(()=>{},1000);}
else if(c.mode==='startup-failure'){process.stdout.write(JSON.stringify({'@type':'error',message:'fixture failure'})+'\\n');setInterval(()=>{},1000);}
else{const ready=()=>{process.stdout.write(JSON.stringify({'@type':'smc.verifiedAdmissionReady',block_id:f.response.block_id,master_utime:f.response.master_utime,shard_utime:f.response.shard_utime,code_hash:f.response.code_hash})+'\\n'+(c.mode==='ready-then-failure'?'private-stdout-marker invalid json\\n':''));let pending='';process.stdin.on('data',b=>{pending+=b;while(pending.includes('\\n')){let n=pending.indexOf('\\n');pending=pending.slice(n+1);fs.appendFileSync(c.requests,'x');if(c.mode==='die-on-request')process.exit(70);if(c.mode==='timeout')continue;setTimeout(()=>{if(c.mode==='malformed')process.stdout.write('invalid json\\n');else process.stdout.write(JSON.stringify(f.response)+'\\n');},c.mode==='busy'?150:0);}});};if(c.mode==='delayed-ready')setTimeout(ready,200);else if(c.mode==='stderr-at-cap')process.stderr.write(Buffer.alloc(1024*1024,65),ready);else ready();}
`,{mode:0o700});
let serial=0; const pools:NativeAdmissionPool[]=[];
const make=(mode:string,sink?:Pick<Logger,'info'|'warn'>)=>{
  const configPath=join(directory,'config-'+(++serial)+'.json'), attempts=configPath+'.attempts', requests=configPath+'.requests';
  writeFileSync(configPath,JSON.stringify({mode,fixture:fixturePath,directory,attempts,requests}),{mode:0o600});
  const config={engine:fixture.request.account_address.account_address,codeHash:Buffer.from(fixture.request.expected_code_hash,'base64').toString('hex'),binaryPath,binarySha256:hash(binaryPath),configPath,configSha256:hash(configPath)};
  const diagnostics:Array<{level:'info'|'warn';value:AdmissionWorkerDiagnostic}>=[];
  const record=(level:'info'|'warn')=>(message:string,extra?:Record<string,unknown>)=>{
    assert.equal(message,'perps admission worker closed');
    diagnostics.push({level,value:extra?.admissionWorker as AdmissionWorkerDiagnostic});
    return sink?.[level](message,extra);
  };
  const pool=new NativeAdmissionPool(config,{info:record('info'),warn:record('warn')});pools.push(pool);return {pool,config,attempts,requests,diagnostics};
};
const count=(path:string)=>existsSync(path)?readFileSync(path).length:0;
const isAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function waitUntil(predicate:()=>boolean,message:string,timeout=12_000){
  const deadline=performance.now()+timeout;
  while(!predicate()&&performance.now()<deadline)await delay(25);
  assert(predicate(),message);
}
async function warmWorkers(pool:NativeAdmissionPool, expected=2){
  await waitUntil(()=>[...(Reflect.get(pool,'workers') as Set<{warm:boolean}>)].filter(worker=>worker.warm).length===expected,
    `Exactly ${expected} authenticated workers must be available`);
}
async function failBothWorkers(pool:NativeAdmissionPool){
  await warmWorkers(pool);
  await Promise.all([0,1].map(()=>assert.rejects(pool.run('close_order_preflight',args),
    (e:any)=>e.code==='admission_worker_failure')));
  assert.equal(pool.ready,false,'A pool without an authenticated live worker is unavailable');
  await assert.rejects(pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_unavailable');
}
async function recoverAfterWorkerLoss(){
  const recovering=make('recover-after-loss');await recovering.pool.start();await warmWorkers(recovering.pool);
  assert.equal(recovering.pool.ready,true);assert.equal(count(recovering.attempts),2);
  await failBothWorkers(recovering.pool);
  await waitUntil(()=>count(recovering.attempts)>=6,'Four replacement workers must fail authentication');
  assert.equal(recovering.pool.ready,false,'Failed replacement authentication never exposes readiness');
  await assert.rejects(recovering.pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_unavailable');
  await waitUntil(()=>recovering.pool.ready,'A healthy pool recovers after more than three failed replacements');
  assert(count(recovering.attempts)>=7);
  assert.equal(count(recovering.requests),2,'Replacement workers never replay failed or unavailable requests');
  assert.equal((await recovering.pool.run('close_order_preflight',args)).execution.outcome,'accepted');
  assert.equal(count(recovering.requests),3,'Only the new explicit request is executed after recovery');
  await recovering.pool.close();
}
async function closeDuringBackoff(){
  const closing=make('close-in-backoff');await closing.pool.start();await failBothWorkers(closing.pool);
  await waitUntil(()=>count(closing.attempts)>=4,'Replacement failures schedule the next backoff');
  await waitUntil(()=>readFileSync(closing.attempts+'.pids','utf8').trim().split('\n').every(pid=>!isAlive(Number(pid))),
    'Every failed replacement exits before shutdown during backoff');
  await closing.pool.close();const attempts=count(closing.attempts);
  await delay(2_500);
  assert.equal(count(closing.attempts),attempts,'Shutdown cancels replacement work during backoff');
  assert.equal(closing.pool.ready,false);
  await assert.rejects(closing.pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_unavailable');
  assert.equal(count(closing.requests),2,'Shutdown cannot replay either failed request');
}
async function partialStartup(){
  for(const mode of ['one-warm-one-failed','one-dead-one-warm']){
    const mixed=make(mode);
    await mixed.pool.start();
    assert.equal(mixed.pool.ready,true,'A failed sibling cannot discard authenticated startup capacity');
    assert.equal((await mixed.pool.run('close_order_preflight',args)).execution.outcome,'accepted');
    await warmWorkers(mixed.pool);
    assert.equal((Reflect.get(mixed.pool,'workers') as Set<unknown>).size,2,'Replacement preserves the two-process bound');
    assert.equal(count(mixed.requests),1,'Replacement cannot replay the successful request');
    await mixed.pool.close();
  }

  const slow=make('one-warm-one-cold');
  await slow.pool.start();
  assert.equal((Reflect.get(slow.pool,'workers') as Set<unknown>).size,2,'The cold sibling remains owned');
  await warmWorkers(slow.pool,1);
  const first=slow.pool.run('close_order_preflight',args);
  await assert.rejects(slow.pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_busy');
  await first;
  assert.equal(count(slow.requests),1,'The cold sibling cannot execute admission work');
  await slow.pool.close();
  assert.equal(slow.pool.ready,false);
}
async function constructorFailureAndColdShutdown(){
  const partial=make('busy');
  const create=Reflect.get(partial.pool,'create').bind(partial.pool);let creates=0;
  // Inject only the synchronous second-slot construction failure. The first
  // and all replacement workers are real owned fixture child processes.
  Reflect.set(partial.pool,'create',()=>{if(++creates===2)throw Error('fixture constructor failure');return create();});
  await partial.pool.start();
  assert.equal(partial.pool.ready,true,'A constructor failure cannot lose the already owned sibling');
  assert.equal((await partial.pool.run('close_order_preflight',args)).execution.outcome,'accepted');
  await warmWorkers(partial.pool);
  assert.equal(creates,3);
  assert.equal((Reflect.get(partial.pool,'workers') as Set<unknown>).size,2);
  await partial.pool.close();

  for(const failSecond of [false,true]){
    const cold=make('cold').pool;
    if(failSecond){
      const createCold=Reflect.get(cold,'create').bind(cold);let slots=0;
      Reflect.set(cold,'create',()=>{if(++slots===2)throw Error('fixture constructor failure');return createCold();});
    }
    const pending=cold.start();let settled=false;
    const rejected=assert.rejects(pending,(e:any)=>e.code==='admission_unavailable').then(()=>{settled=true;});
    await delay(100);
    assert.equal(settled,false,'A cold startup waits for its owned authentication attempts');
    assert.equal(cold.ready,false);
    await cold.close();await rejected;
    assert.equal((Reflect.get(cold,'workers') as Set<unknown>).size,0,'Shutdown reaps cold workers even after a sibling constructor failure');
    assert.equal(cold.ready,false);
  }
}
async function diagnosticFailures(){
  const cold=make('exit-before-ready');
  await assert.rejects(cold.pool.start(),(e:any)=>e.code==='admission_unavailable');
  await cold.pool.close();
  assert.equal(cold.diagnostics.length,2,'Each owned exited worker emits one terminal record');
  for(const {level,value:d} of cold.diagnostics){
    assert.equal(level,'warn');assert.equal(d.origin,'worker_exit');assert.equal(d.phase,'startup');
    assert.equal(d.closeCode,70);assert.equal(d.closeSignal,null);assert.equal(d.parentKillRequested,false);
    assert.equal(d.expected,false);assert.equal(d.authenticated,false);assert.equal(d.startupMs,null);
    assert.equal(d.stdoutBytes,0);assert.equal(d.requests,0);assert(d.stderrBytes>5000);
    assert.equal(d.stderrTailBytes,4096);assert.equal(Buffer.byteLength(d.stderrTail),4096);assert.equal(d.stderrTruncated,true);
    assert.match(d.stderrTail,/ADMISSION_WORKER: stale clock/);assert.match(d.stderrTail,/^[\x20-\x7e]*$/);
  }
  assert.equal(new Set(cold.diagnostics.map(d=>d.value.pid)).size,2);
  assert.equal(new Set(cold.diagnostics.map(d=>d.value.workerId)).size,2);

  const sameChunk=make('ready-then-failure');
  await assert.rejects(sameChunk.pool.start(),AdmissionError);await sameChunk.pool.close();
  assert.equal(sameChunk.diagnostics.length,2);
  for(const {value:d} of sameChunk.diagnostics){
    assert.equal(d.origin,'output_invalid','Close and shutdown preserve the first failure origin');
    assert.equal(d.authenticated,true);assert.equal(d.phase,'idle');assert.equal(d.stdoutFrames,2);
    assert.equal(d.closeSignal,'SIGKILL');assert.equal(d.parentKillRequested,true);assert.equal(d.expected,false);
    assert(!JSON.stringify(d).includes('private-stdout-marker'),'Stdout body must not enter operator diagnostics');
  }

  const warm=make('die-on-request');await warm.pool.start();await warmWorkers(warm.pool);
  await Promise.all([0,1].map(()=>assert.rejects(warm.pool.run('close_order_preflight',args),(error:any)=>{
    assert.deepEqual(publicAdmissionError(error),{status:502,code:'admission_worker_failure',message:'admission_worker_failure'});
    assert(!JSON.stringify(error).includes('admissionWorker'));return true;
  })));
  await warm.pool.close();assert.equal(warm.diagnostics.length,2);assert.equal(count(warm.requests),2);
  for(const {value:d} of warm.diagnostics){
    assert.equal(d.origin,'worker_exit');assert.equal(d.phase,'request');assert.equal(d.requests,1);
    assert.equal(d.completedJobs,0);assert.equal(d.closeCode,70);assert.equal(d.expected,false);
  }
}
async function diagnosticOutputBounds(){
  const overflow=make('stderr-overflow');
  await assert.rejects(overflow.pool.start(),AdmissionError);await overflow.pool.close();
  assert.equal(overflow.diagnostics.length,2);
  for(const {value:d} of overflow.diagnostics){
    assert.equal(d.origin,'stderr_limit');assert(d.stderrBytes>1024*1024);
    assert.equal(d.stderrTailBytes,4096);assert.equal(d.stderrTail,'A'.repeat(4096));
    assert.equal(d.closeSignal,'SIGKILL');assert.equal(d.expected,false);
  }
  const boundary=make('stderr-at-cap');await boundary.pool.start();await warmWorkers(boundary.pool);
  await waitUntil(()=>[...(Reflect.get(boundary.pool,'workers') as Set<object>)].every(w=>Reflect.get(w,'errorBytes')===1024*1024),
    'Both workers drain exactly the original lifetime stderr limit');
  assert.equal((await boundary.pool.run('close_order_preflight',args)).execution.outcome,'accepted');
  await boundary.pool.close();assert.equal(boundary.diagnostics.length,2);
  for(const {value:d} of boundary.diagnostics){
    assert.equal(d.stderrBytes,1024*1024);assert.equal(d.origin,'shutdown');assert.equal(d.expected,true);
  }
}
async function diagnosticExpectedExitAndSinkFailure(){
  const retiring=make('normal');await retiring.pool.start();await warmWorkers(retiring.pool);
  for(let request=0;request<128;request++)await retiring.pool.run('close_order_preflight',args);
  await waitUntil(()=>retiring.diagnostics.some(d=>d.value.origin==='job_limit'),'Completed worker retires after exactly128 jobs');
  const retired=retiring.diagnostics.find(d=>d.value.origin==='job_limit')!;
  assert.equal(retired.level,'info');assert.equal(retired.value.phase,'retiring');assert.equal(retired.value.expected,true);
  assert.equal(retired.value.closeCode,0);assert.equal(retired.value.closeSignal,null);
  assert.equal(retired.value.requests,128);assert.equal(retired.value.completedJobs,128);
  assert.equal(retired.value.parentKillRequested,false);assert.equal(count(retiring.requests),128);
  await retiring.pool.close();

  for(const asynchronous of [false,true]){
    const failingSink=()=>{if(asynchronous)return Promise.reject(Error('fixture async diagnostic sink failure'));throw Error('fixture diagnostic sink failure');};
    const closing=make('busy',{info:failingSink,warn:failingSink});await closing.pool.start();await warmWorkers(closing.pool);
    const rejected=assert.rejects(closing.pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_unavailable');
    await closing.pool.close();await rejected;await delay(0);
    assert.equal(closing.diagnostics.length,2,'Logging failure does not prevent exactly one terminal attempt per worker');
    assert.equal((Reflect.get(closing.pool,'workers') as Set<unknown>).size,0,'Throwing sinks cannot prevent reaping');
    for(const {level,value:d} of closing.diagnostics){
      assert.equal(level,'info');assert.equal(d.origin,'shutdown');assert.equal(d.expected,true);
      assert.equal(d.closeSignal,'SIGKILL');assert.equal(d.parentKillRequested,true);assert(d.pid && !isAlive(d.pid));
    }
  }
}
async function run(){
  await diagnosticFailures();
  await diagnosticOutputBounds();
  await diagnosticExpectedExitAndSinkFailure();
  await partialStartup();
  await constructorFailureAndColdShutdown();
  const {pool,config:ownedConfig}=make('busy');ownedConfig.binarySha256='0'.repeat(64);assert.equal(pool.ready,false);await pool.start();await warmWorkers(pool);assert.equal(pool.ready,true);
  const first=pool.run('close_order_preflight',args),second=pool.run('close_order_preflight',args);
  assert.equal(pool.ready,true,'Busy warm workers remain healthy');
  await assert.rejects(pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_busy');
  assert.equal((await first).gasUsed,507666);assert.equal((await second).execution.outcome,'accepted');
  const interrupted=assert.rejects(pool.run('close_order_preflight',args),AdmissionError);await pool.close();await interrupted;assert.equal(pool.ready,false);
  const failed=make('startup-failure').pool;await assert.rejects(failed.start(),AdmissionError);assert.equal(failed.ready,false);await failed.close();
  const recovering=make('recover').pool;await assert.rejects(recovering.start(),AdmissionError);
  const recoverDeadline=performance.now()+12_000;
  while(!recovering.ready&&performance.now()<recoverDeadline)await delay(25);
  assert.equal(recovering.ready,true,'authentication still retries after four failed starts');
  assert(readFileSync(join(directory,'recovery-attempts')).length>=5);
  await recovering.close();
  await recoverAfterWorkerLoss();
  await closeDuringBackoff();
  const malformed=make('malformed').pool;await malformed.start();await assert.rejects(malformed.run('close_order_preflight',args),AdmissionError);await malformed.close();
  const timeout=make('timeout').pool;await timeout.start();const started=performance.now();await assert.rejects(timeout.run('close_order_preflight',args),(e:any)=>e.code==='admission_timeout');assert(performance.now()-started>=4900&&performance.now()-started<6000);await timeout.close();
  const bad=make('busy');const badPool=new NativeAdmissionPool({...bad.config,binarySha256:'0'.repeat(64)});pools.push(badPool);await assert.rejects(badPool.start(),AdmissionError);
  const link=make('busy'),symlink=join(directory,'config-link');symlinkSync(link.config.configPath,symlink);const linkedPool=new NativeAdmissionPool({...link.config,configPath:symlink});pools.push(linkedPool);await assert.rejects(linkedPool.start(),AdmissionError);
  const writable=make('busy');chmodSync(writable.config.configPath,0o666);await assert.rejects(writable.pool.start(),AdmissionError);
  await Promise.all(pools.map(p=>p.close()));
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.pid')))assert.throws(()=>process.kill(Number(file.slice(0,-4)),0),'Every owned fixture process must have been reaped');
  console.log('Native admission private bounded exit diagnostics, partial startup, cold/constructor-failure cleanup, readiness, busy bound, no retry, malformed output, timeout, pin/ownership guards and owned cleanup PASS');
}
void run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await Promise.all(pools.map(p=>p.close()));Date.now=originalNow;rmSync(directory,{recursive:true,force:true});});
