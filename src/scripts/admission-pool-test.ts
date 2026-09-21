import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Cell, TupleItem } from '@ton/core';
import { NativeAdmissionPool } from '../data/admission/nativePool';
import { AdmissionError } from '../data/admission/protocol';

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
if(c.mode==='startup-failure'){process.stdout.write(JSON.stringify({'@type':'error',message:'fixture failure'})+'\\n');setInterval(()=>{},1000);}
else{process.stdout.write(JSON.stringify({'@type':'smc.verifiedAdmissionReady',block_id:f.response.block_id,master_utime:f.response.master_utime,shard_utime:f.response.shard_utime,code_hash:f.response.code_hash})+'\\n');let pending='';process.stdin.on('data',b=>{pending+=b;while(pending.includes('\\n')){let n=pending.indexOf('\\n');pending=pending.slice(n+1);if(c.mode==='timeout')continue;setTimeout(()=>{if(c.mode==='malformed')process.stdout.write('invalid json\\n');else process.stdout.write(JSON.stringify(f.response)+'\\n');},c.mode==='busy'?150:0);}});}
`,{mode:0o700});
let serial=0; const pools:NativeAdmissionPool[]=[];
const make=(mode:string)=>{
  const configPath=join(directory,'config-'+(++serial)+'.json');writeFileSync(configPath,JSON.stringify({mode,fixture:fixturePath,directory}),{mode:0o600});
  const config={engine:fixture.request.account_address.account_address,codeHash:Buffer.from(fixture.request.expected_code_hash,'base64').toString('hex'),binaryPath,binarySha256:hash(binaryPath),configPath,configSha256:hash(configPath)};
  const pool=new NativeAdmissionPool(config);pools.push(pool);return {pool,config};
};
async function run(){
  const {pool,config:ownedConfig}=make('busy');ownedConfig.binarySha256='0'.repeat(64);assert.equal(pool.ready,false);await pool.start();assert.equal(pool.ready,true);
  const first=pool.run('close_order_preflight',args),second=pool.run('close_order_preflight',args);
  assert.equal(pool.ready,true,'Busy warm workers remain healthy');
  await assert.rejects(pool.run('close_order_preflight',args),(e:any)=>e.code==='admission_busy');
  assert.equal((await first).gasUsed,507666);assert.equal((await second).execution.outcome,'accepted');
  const interrupted=assert.rejects(pool.run('close_order_preflight',args),AdmissionError);await pool.close();await interrupted;assert.equal(pool.ready,false);
  const failed=make('startup-failure').pool;await assert.rejects(failed.start(),AdmissionError);assert.equal(failed.ready,false);
  const malformed=make('malformed').pool;await malformed.start();await assert.rejects(malformed.run('close_order_preflight',args),AdmissionError);await malformed.close();
  const timeout=make('timeout').pool;await timeout.start();const started=performance.now();await assert.rejects(timeout.run('close_order_preflight',args),(e:any)=>e.code==='admission_timeout');assert(performance.now()-started>=4900&&performance.now()-started<6000);await timeout.close();
  const bad=make('busy');const badPool=new NativeAdmissionPool({...bad.config,binarySha256:'0'.repeat(64)});pools.push(badPool);await assert.rejects(badPool.start(),AdmissionError);
  const link=make('busy'),symlink=join(directory,'config-link');symlinkSync(link.config.configPath,symlink);const linkedPool=new NativeAdmissionPool({...link.config,configPath:symlink});pools.push(linkedPool);await assert.rejects(linkedPool.start(),AdmissionError);
  const writable=make('busy');chmodSync(writable.config.configPath,0o666);await assert.rejects(writable.pool.start(),AdmissionError);
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.pid')))assert.throws(()=>process.kill(Number(file.slice(0,-4)),0),'Every owned fixture process must have been reaped');
  console.log('Native admission supervisor readiness, busy bound, no retry, malformed output, timeout, pin/ownership guards and owned cleanup PASS');
}
void run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await Promise.all(pools.map(p=>p.close()));Date.now=originalNow;rmSync(directory,{recursive:true,force:true});});
