/** Cross-consumer native cells; synthetic sandbox head identity is explicit. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Cell, serializeTuple, type TupleItem } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { boundaryState, type PhysicalEvidenceStore } from '../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { fakeChainSource } from './support/fakeChainSource';
import { collectOptionsOperationEvidence, readOptionsOperationRequest } from '../runtime/optionsOperationEvidence';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function stack(items:any[]):TupleItem[]{return items.map(([type,value])=>{
  if(type==='num'||type==='int')return {type:'int',value:BigInt(value)};
  if(type==='null')return {type:'null'};
  if(type==='tuple')return {type:'tuple',items:stack(value)};
  assert(['cell','slice','builder'].includes(type));return {type,cell:Cell.fromBase64(value.bytes??value)};
});}
export function optionsCaptureAdapter(c:any){
  const rows=c.completeTransactions as OrderTransactionEvidence[],checked=rows.map(evidence=>({evidence,tx:verifyOrderTransaction(evidence)}));
  const seqno=c.observation.head.seqno,head={workchain:-1,shard:c.observation.head.shard,seqno,utime:c.unixTime,
    rootHashHex:Buffer.from(c.observation.head.root_hash,'base64').toString('hex'),fileHashHex:Buffer.from(c.observation.head.file_hash,'base64').toString('hex')};
  const states=new Map<string,ReturnType<typeof boundaryState>['state']>(),retained=new Map(checked.map(({evidence,tx})=>[`${evidence.account}:${tx.tx.lt}:${tx.hash}`,{evidence,seqno}]));
  const refusedAccounts: Array<{account:string;reason:string}>=[];
  for(const observed of c.observation.accounts){
    const latest=checked.filter(r=>r.evidence.account===observed.account).sort((a,b)=>a.tx.tx.lt>b.tx.tx.lt?-1:1)[0];if(!latest)continue;
    const state=boundaryState(observed.account,latest.evidence.afterShardAccountBoc,seqno).state,r=observed.response;
    try {
    assert.deepEqual(r.block_id,c.observation.head,`Mixed observed account head at ${observed.account}`);
    assert.equal(state.accountState,r.state==='uninit'?'uninitialized':r.state,`Current original account state mismatch at ${observed.account}`);
    assert.equal(state.lastTxLt,String(r.last_transaction_id.lt));assert.equal(Buffer.from(state.lastTxHash!,'base64').toString('hex'),Buffer.from(r.last_transaction_id.hash,'base64').toString('hex'));
    assert.equal(state.balance,String(r.balance),`Current original balance mismatch at ${observed.account}`);
    for(const [actual,value] of [[state.codeBoc,r.code],[state.dataBoc,r.data]])if(actual||value)assert(actual&&value&&Cell.fromBase64(actual).equals(Cell.fromBase64(value)));
    states.set(observed.account,{...state,anchor:{shardBlock:{...head,workchain:0},genUtime:c.unixTime}});
    } catch(error) { refusedAccounts.push({account:observed.account,reason:String(error)}); }
  }
  const control={missingAccount:'',missingBoundary:'',reads:0};
  const source=fakeChainSource({network:'localnet',head:async()=>head,getAccountState:async(address,options)=>{
    assert.deepEqual(options?.at,head);control.reads++;const state=states.get(address);assert(state,`Missing original current account ${address}`);return state;
  },runGetMethod:async(address,method,args=[],options)=>{
    assert.deepEqual(options?.at,head);
    const candidates=c.observation.getters.filter((g:any)=>g.request.address===address&&g.request.method===method&&serializeTuple(g.request.args.map((v:any)=>v.type==='int'?{type:'int',value:BigInt(v.value)}:{type:v.type,cell:Cell.fromBase64(v.cellBoc)})).equals(serializeTuple(args)));
    assert.equal(candidates.length,1,`Missing exact observed getter ${method}`);assert.deepEqual(candidates[0].response.block_id,c.observation.head,'Mixed observed getter head');return {exitCode:candidates[0].response.exit_code,stack:stack(candidates[0].response.stack)};
  }});
  const store:PhysicalEvidenceStore={evidenceBoundary:async(account,lt,hash)=>control.missingAccount===account||control.missingBoundary===`${account}:${lt}:${hash}`?null:retained.get(`${account}:${lt}:${hash}`)??null,
    retain:async()=>{throw Error('Read-only original fixture');}};
  const b=c.binding.options,base=runtimeManifestFixture(),manifest={...base,network:'ton:localnet' as const,releaseId:c.request.releaseId,manifestHash:c.request.manifestHash,
    contracts:{...base.contracts,OptionFactory:{address:b.factory,codeHash:b.factoryHash},OptionVault:{address:b.vault,codeHash:b.vaultHash},
      OptionSeriesManager:{address:b.manager,codeHash:b.managerHash},Governance:{...base.contracts.Governance!,address:b.governance},FeeRouter:{...base.contracts.FeeRouter!,address:b.feeSink},
      Treasury:{...base.contracts.Treasury!,address:b.treasury},T3Hub:{address:b.t3Root,codeHash:b.t3MasterHash}},
    templates:{...base.templates,ShoutOption:b.shoutHash,OutperformanceOption:b.outperfHash,T3Wallet:b.t3WalletHash,T3RecoveryProof:c.binding.proofCodeHash},
    tokens:[{symbol:'T3',root:b.t3Root,decimals:9,masterCodeHash:b.t3MasterHash,walletCodeHash:b.t3WalletHash}]};
  return {source,store,manifest,head,control,refusedAccounts};
}
async function main(){
  const dir=process.argv[2],output=process.argv[3],diagnostic=process.argv[4]==='--diagnostic';assert(dir&&isAbsolute(dir));const exported:unknown[]=[],originalNow=Date.now;
  try{for(const file of readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){
    const bytes=readFileSync(join(dir,file)),c=JSON.parse(bytes.toString());Date.now=()=>c.unixTime*1000;
    const a=optionsCaptureAdapter(c),parsed=readOptionsOperationRequest(c.request,a.manifest),response=await collectOptionsOperationEvidence(a.manifest,a.source,a.store,parsed);
    if (!diagnostic) assert(response.coverage.complete,`${file}: ${JSON.stringify(response.coverage)}`);response.transactions.forEach(verifyOrderTransaction);
    assert(response.transactions.some(row=>row.account===c.request.owner&&verifyOrderTransaction(row).hash===c.request.dispatch.hash));
    a.control.missingAccount=c.request.vault;const missing=await collectOptionsOperationEvidence(a.manifest,a.source,a.store,parsed);assert(!missing.coverage.complete);a.control.missingAccount='';
    const wrong=readOptionsOperationRequest({...c.request,dispatch:{...c.request.dispatch,hash:'0'.repeat(64)}},a.manifest);
    assert(!(await collectOptionsOperationEvidence(a.manifest,a.source,a.store,wrong)).coverage.complete);
    const abort=new AbortController();abort.abort();await assert.rejects(collectOptionsOperationEvidence(a.manifest,a.source,a.store,parsed,abort.signal));
    exported.push({file,sourceSha256:sha(bytes),request:c.request,binding:c.binding,manifest:a.manifest,refusedAccounts:a.refusedAccounts,response});console.log(file,response.coverage.complete?'complete':JSON.stringify(response.coverage.gaps),response.transactions.length,a.refusedAccounts.length?'unrelated invalid current observations excluded: '+a.refusedAccounts.length:'');
  }
  if(output){assert(isAbsolute(output));writeFileSync(output,JSON.stringify({schema:'tonswap-native-options-collector-test-v1',qualification:'Original full native transaction/account histories and actual observed getters under synthetic sandbox head/release identity. Current account envelopes are unchanged original final boundaries cross-checked against same-head native observations. No deployment/consensus qualification.',sourceDirectory:dir,cases:exported},null,2)+'\n',{flag:'wx'});}
  console.log(diagnostic?'Native Options diagnostic collection finished; explicit gaps retained.':'Native current Options full histories, exact original owner dispatch and missing/wrong/abort refusals passed.');
  }finally{Date.now=originalNow;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
