import assert from 'node:assert/strict';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address,beginCell,Cell,Dictionary,serializeTuple,type TupleItem } from '@ton/core';
import { validateReleaseManifest } from '../config/runtimeManifest';
import { verifyOrderTransaction,type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState } from '../runtime/physicalEvidence';
import { spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';
import { collectT3OperationEvidence } from '../runtime/t3OperationEvidence';
import { currentT3BasketFixture } from './support/currentT3BasketFixture';
import { deriveT3RedemptionBinding } from '../ledger/runtimeT3Binding';
import { readCurrentT3Hub } from '../ledger/currentT3State';
import { readT3OperationRequest } from '../runtime/t3OperationRequest';

function stack(items:any[]):TupleItem[]{return items.map(([type,value])=>type==='int'||type==='num'?{type:'int',value:BigInt(value)}:type==='null'?{type:'null'}:type==='tuple'?{type:'tuple',items:stack(value)}:{type,cell:Cell.fromBase64(value.bytes??value)});}
/** Original state/getter adapter only; synthetic heads do not qualify consensus. */
export function t3BasketCaptureAdapter(c:any){
 const valid=validateReleaseManifest(c.manifest);assert(valid.ok,JSON.stringify(valid));
 const scope=new Set<string>([...c.transactions.map((t:any)=>t.account),...c.readSnapshots.flatMap((s:any)=>s.calls.map((call:any)=>call.address))]);
 const current=new Map<string,string>(c.currentAccounts.map((a:any)=>[a.address,a.originalShardAccountBoc])),latest=new Map<string,OrderTransactionEvidence>();
 for(const row of c.completeTransactions as OrderTransactionEvidence[]){const tx=verifyOrderTransaction(row),prior=latest.get(row.account);if(!prior||verifyOrderTransaction(prior).tx.lt<tx.tx.lt)latest.set(row.account,row);}
 for(const[address,boc]of current){boundaryState(address,boc,1);const prior=latest.get(address);if(prior&&scope.has(address))assert(Cell.fromBase64(prior.afterShardAccountBoc).equals(Cell.fromBase64(boc)),address);}
 const head=c.head,getters=new Map<string,any>();
 for(const snapshot of c.readSnapshots){if(snapshot.response.head.seqno!==head.seqno)continue;assert.equal(snapshot.response.head.rootHashHex,head.rootHashHex);
  snapshot.calls.forEach((call:any,index:number)=>{if(call.kind!=='getter')return;const result=snapshot.response.results[index];assert.equal(result.kind,'getter');
   const args=serializeTuple((call.args??[]).map((a:any)=>a.type==='int'?{type:'int',value:BigInt(a.value)}:{type:a.type,cell:Cell.fromBase64(a.cellBoc)}));
   const key=`${call.address}:${call.method}:${args.hash().toString('hex')}`,value={address:call.address,method:call.method,argsBoc:args.toBoc().toString('base64'),exitCode:result.exitCode,resultBoc:serializeTuple(stack(result.stack)).toBoc().toString('base64')};
   const prior=getters.get(key);if(prior)assert.deepEqual(prior,value);getters.set(key,value);
  });
 }
 for(const token of c.manifest.tokens)if(['T3','USDT','USDC','KUSD'].includes(token.symbol))assert([...getters.values()].some(g=>g.address===token.root&&g.method==='get_jetton_data'),'original native master getter');
 const a=spotEvidenceFixtureAdapter(c.manifest,[...current].map(([address,shardAccountBoc])=>({address,shardAccountBoc})),c.completeTransactions,c.unixTime,[...getters.values()]);Object.assign(a.head,{seqno:head.seqno,rootHashHex:head.rootHashHex,utime:head.utime});return a;
}
/** Synthetic refusals mutate only the test adapter. Positive admission above
 * and below always uses the unchanged native account/getter originals. */
async function coldOptionalRefusals(c:any){
 const a=t3BasketCaptureAdapter(c),hub=a.states.get(c.request.hub)!,original=hub.dataBoc!;
 const parsed=readCurrentT3Hub(original),cold=parsed.slots.get(2)!;assert(cold.optional&&cold.wallet);assert.equal(parsed.backing[2],0n);assert.equal(parsed.pending[2],0n);
 const valid=await deriveT3RedemptionBinding(c.manifest,a.source,{at:a.head});assert.equal(valid!.reserveRoutes[2].vault,cold.wallet);
 const raw={parse:(s:any)=>s.asCell(),serialize:(value:Cell,b:any)=>b.storeSlice(value.beginParse())};
 const changed=(edit:(state:any)=>void)=>{const refs=Cell.fromBase64(original).refs,ledger=refs[1].beginParse(),economy=refs[2].beginParse();
  const state={slots:ledger.loadDict(Dictionary.Keys.Uint(8),raw),owed:ledger.loadDict(Dictionary.Keys.Uint(8),raw),backing:[economy.loadCoins(),economy.loadCoins(),economy.loadCoins()],pending:readCurrentT3Hub(original).pending.slice(),supply:economy.loadRef()&&economy.loadCoins(),fee:economy.loadUint(16),admitted:economy.loadUint(3),frozen:economy.loadUint(3),withdrawals:economy.loadBit(),clears:economy.loadRef()};edit(state);
  const l=beginCell().storeDict(state.slots).storeDict(state.owed).endCell(),e=beginCell();for(const value of state.backing)e.storeCoins(value);e.storeRef(beginCell().storeUint(state.pending[0],256).storeUint(state.pending[1],256).storeUint(state.pending[2],256)).storeCoins(state.supply).storeUint(state.fee,16).storeUint(state.admitted,3).storeUint(state.frozen,3).storeBit(state.withdrawals).storeRef(state.clears);
  return beginCell().storeRef(refs[0]).storeRef(l).storeRef(e).storeRef(refs[3]).endCell().toBoc().toString('base64');
 };
 const owed=(total=0n,entry=0n,archiveTotal:bigint|null=null)=>{const entries=Dictionary.empty(Dictionary.Keys.Address(),Dictionary.Values.BigVarUint(4));if(entry)entries.set(Address.parse(c.request.owner),entry);return beginCell().storeCoins(total).storeUint(entries.size,16).storeDict(entries).storeMaybeRef(archiveTotal===null?null:beginCell().storeUint(1,65).storeUint(1,256).storeCoins(archiveTotal).storeDict(null).endCell()).endCell();};
 const profile=(cell:Cell,optional:boolean,wallet?:string)=>{const s=cell.beginParse(),master=s.loadAddress(),old=s.loadMaybeAddress(),gas=s.loadUint(32),gram=s.loadCoins();s.loadBit();const budget=s.loadRef();s.endParse();return beginCell().storeAddress(master).storeAddress(wallet?Address.parse(wallet):old).storeUint(gas,32).storeCoins(gram).storeBit(optional).storeRef(budget).endCell();};
 const cases:Array<[string,(state:any)=>void]>=[['backing',s=>s.backing[2]=1n],['pending',s=>s.pending[2]=1n],['owed-total',s=>s.owed.set(2,owed(1n))],['direct-entry',s=>s.owed.set(2,owed(0n,1n))],['archive-total',s=>s.owed.set(2,owed(0n,0n,1n))],['admitted-mask',s=>s.admitted|=4],['frozen-mask',s=>s.frozen|=4],['missing-slot',s=>s.slots.delete(2)],['extra-slot',s=>s.slots.set(3,s.slots.get(2))],['required-slot',s=>s.slots.set(2,profile(s.slots.get(2),false))],['identity',s=>s.slots.set(2,profile(s.slots.get(2),true,c.request.owner))],['unknown-owed-slot',s=>s.owed.set(3,owed())]];
 for(const[name,edit]of cases){hub.dataBoc=changed(edit);await assert.rejects(()=>deriveT3RedemptionBinding(c.manifest,a.source,{at:a.head}),/.*/,name);hub.dataBoc=original;}
 for(const state of ['frozen','unknown']){const source={...a.source,getAccountState:async(address:string,options:any)=>{if(address===cold.wallet){if(state==='unknown')throw Error('Unavailable original boundary');return{accountState:'frozen' as const,balance:'0',codeBoc:null,dataBoc:null};}return a.source.getAccountState(address,options);}};await assert.rejects(()=>deriveT3RedemptionBinding(c.manifest,source,{at:a.head}));}
 console.log('Native canonical cold KUSD admitted only with zero backing, pending, direct/archive owed; identity/count/mask/frozen/unknown refusals passed');
}
async function main(){
 const root=process.argv[2],output=process.argv[3];const cases=root?readdirSync(root).filter(f=>f.endsWith('.json')).sort().map(file=>({file,capture:JSON.parse(readFileSync(join(root,file),'utf8'))})):[...currentT3BasketFixture().cases()];assert.equal(cases.length,8);const exported=[];
 const previousNow=Date.now;
 try{for(const {file,capture:c} of cases){Date.now=()=>c.unixTime*1000;
  if(file===cases[0].file)await coldOptionalRefusals(c);
  const a=t3BasketCaptureAdapter(c),p=readT3OperationRequest(c.request,c.manifest),read=()=>collectT3OperationEvidence(c.manifest,a.source,a.store,p);
  const result=await read();assert(result.coverage.complete,`${file}: ${JSON.stringify(result.coverage)}`);assert.equal(result.receipts.length,c.request.kind==='pair'?2:1);assert(result.transactions.length<=256);assert(Buffer.byteLength(JSON.stringify(result))<=8*1024*1024);
  const originals=new Set(c.completeTransactions.map((row:OrderTransactionEvidence)=>verifyOrderTransaction(row).hash));for(const row of result.transactions)assert(originals.has(verifyOrderTransaction(row).hash));
  for(const action of c.actions.filter((a:any)=>a.kind.startsWith('deposit')))assert(result.transactions.some(row=>verifyOrderTransaction(row).hash===action.ownerDispatch.hash),'original owner authority retained');
  exported.push({file,capture:c,response:result});
  const count=a.control.reads;await read();assert(a.control.reads>count,'No completed current cache');
  a.control.missingAccount=c.request.hub;const missing=await read();assert(!missing.coverage.complete);assert.equal(missing.receipts.length,0);a.control.missingAccount='';
  a.control.missingAccount=c.request.owner;const noOwner=await read();assert(!noOwner.coverage.complete);a.control.missingAccount='';
  const wrong=structuredClone(c.request);wrong.dispatch.hash='a'.repeat(64);const absent=await collectT3OperationEvidence(c.manifest,a.source,a.store,readT3OperationRequest(wrong,c.manifest));assert(!absent.coverage.complete);assert(absent.coverage.gaps.some(g=>g.code==='original_request_unobserved'));
  a.control.wrongCode=c.request.hub;await assert.rejects(read());a.control.wrongCode='';
  console.log(file,result.receipts.length,result.transactions.length,'current source-bound collection and omissions passed');
 }
 if(output)writeFileSync(output,JSON.stringify({schema:'tonswap-current-t3-basket-collector-v1',cases:exported}));
 }finally{Date.now=previousNow;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
