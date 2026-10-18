import assert from 'node:assert/strict';
import { Address, beginCell, type Cell, type TupleItem } from '@ton/core';
import { BalanceService } from '../balances/balanceService';
import { createJettonWalletReader } from '../data/jettonWallet';
import { ChainReadError, type AccountStateResponse, type ReadOptions } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

const owner = Address.parse(`0:${'1'.repeat(64)}`);
const roots = ['T3','USDC','USDT'].map((symbol,index)=>({master:`0:${String(index+2).repeat(64)}`,symbol,decimals:index===0?9:6}));
const walletCode = beginCell().storeUint(0xaabb,16).endCell(), rootCode=beginCell().storeUint(0xccdd,16).endCell();
const boc = (cell:Cell)=>cell.toBoc().toString('base64');
const addresses = roots.map((_, index)=>`0:${String(index+5).repeat(64)}`);
const head = fixtureHead(100,1_700_000_100), next = fixtureHead(101,1_700_000_101);
let unavailable=true, nativeFailure=false, batches=0, getters=0;
const pinned=(options?:ReadOptions)=>{assert(options?.at);assert(options.signal);return options.at;};
const state=async(address:string,options?:ReadOptions):Promise<AccountStateResponse>=>{
  const at=pinned(options);
  if(address===owner.toRawString()) {if(nativeFailure)throw new ChainReadError('upstream_unavailable');return {balance:'5011771086',accountState:'active'};}
  if(roots.some(root=>root.master===address)) return {balance:'0',accountState:'active',codeBoc:boc(rootCode)};
  const index=addresses.indexOf(address);assert(index>=0);
  if(index===1)return {balance:'0',accountState:'uninitialized'};
  if(index===2&&unavailable)throw new ChainReadError('upstream_timeout');
  return {balance:'0',accountState:'active',codeBoc:boc(walletCode),lastTxLt:'1000',lastTxHash:'a'.repeat(64)};
};
const source=fakeChainSource({head:async()=>head,getAccountState:state,
  runGetMethod:async(address,method,_args,options)=>{const at=pinned(options);getters++;
    const addressItem=(value:string):TupleItem=>({type:'slice',cell:beginCell().storeAddress(Address.parse(value)).endCell()});
    if(method==='get_jetton_data')return {exitCode:0,stack:[{type:'int',value:100n},{type:'int',value:-1n},{type:'null'},
      {type:'cell',cell:beginCell().storeUint(0,8).storeBit(false).endCell()},{type:'cell',cell:walletCode}] as TupleItem[]};
    if(method==='get_wallet_address')return {exitCode:0,stack:[addressItem(addresses[roots.findIndex(root=>root.master===address)])]};
    assert.equal(method,'get_wallet_data');const index=addresses.indexOf(address);assert(index>=0);
    return {exitCode:0,stack:[{type:'int',value:BigInt(at.seqno)*(index===0?1000n:1n)},addressItem(owner.toRawString()),
      addressItem(roots[index].master),{type:'cell',cell:walletCode}] as TupleItem[]};},
  read:async(calls,options)=>{batches++;const at=pinned(options);return {head:at,results:await Promise.all(calls.map(async call=>{
    assert.equal(call.kind,'account');return {kind:'account' as const,address:call.address,state:await state(call.address,options)};
  }))};}});
async function main(){
  const reader=createJettonWalletReader({source,tokens:roots.map(root=>({...root,masterCodeHash:rootCode.hash().toString('hex'),walletCodeHash:walletCode.hash().toString('hex')}))});
  const service=new BalanceService({reader,roots,network:'testnet'});
  const first=await service.read(owner.toString(),{at:head});
  assert.deepEqual(first,{address:owner.toRawString(),network:'testnet',head_seqno:100,head_utime:head.utime,complete:false,assets:[
    {kind:'native',symbol:'GRAM',status:'ok',balance_raw:'5011771086',decimals:9},
    {kind:'jetton',symbol:'T3',root:roots[0].master,wallet:addresses[0],status:'ok',balance_raw:'100000',decimals:9},
    {kind:'jetton',symbol:'USDC',root:roots[1].master,wallet:addresses[1],status:'not_deployed',balance_raw:'0',decimals:6},
    {kind:'jetton',symbol:'USDT',root:roots[2].master,wallet:addresses[2],status:'unavailable',balance_raw:null,decimals:6,reason:'timeout'}]});
  unavailable=false;batches=0;getters=0;
  const reads=await Promise.all(Array.from({length:10},()=>service.read(owner.toRawString(),{at:next})));
  assert.equal(batches,1,'one warm batch shared by ten concurrent readers');assert.equal(getters,8,'three root and address getters plus two active wallet getters share one current read');assert(reads.every(value=>value.complete&&value.head_seqno===101));
  assert.deepEqual(reads[0].assets.map(row=>row.balance_raw),['5011771086','101000','0','101']);
  reads[0].assets[0].balance_raw='1';assert.equal(reads[1].assets[0].balance_raw,'5011771086','one caller cannot mutate another answer');
  await service.read(owner.toRawString(),{at:next});assert.equal(batches,2,'no completed balance cache, even at the same head');
  nativeFailure=true;await assert.rejects(service.read(owner.toRawString(),{at:next}),error=>error instanceof ChainReadError&&error.code==='upstream_unavailable');nativeFailure=false;
  const cancelled=new AbortController();cancelled.abort(new DOMException('timeout','TimeoutError'));
  await assert.rejects(service.read(owner.toRawString(),{at:head,signal:cancelled.signal}),error=>error instanceof ChainReadError&&error.code==='upstream_timeout');
  let release!:()=>void, calls=0, signal:AbortSignal|undefined;
  const sharing=new BalanceService({roots,network:'testnet',reader:{wallets:async(...args)=>{calls++;signal=args[2]?.signal;
    await new Promise<void>(resolve=>{release=resolve;});return reader.wallets(...args);}}});
  const one=new AbortController(),two=new AbortController();
  const rejected=sharing.read(owner.toRawString(),{at:head,signal:one.signal});const held=sharing.read(owner.toRawString(),{at:head,signal:two.signal});
  await Promise.resolve();one.abort(new DOMException('timeout','TimeoutError'));
  await assert.rejects(rejected,error=>error instanceof ChainReadError&&error.code==='upstream_timeout');assert(!signal!.aborted);
  release();assert((await held).complete);assert.equal(calls,1,'one cancelling consumer does not cancel the other');
  const last=new AbortController();const abandoned=sharing.read(owner.toRawString(),{at:head,signal:last.signal});await Promise.resolve();
  last.abort();await assert.rejects(abandoned);assert(signal!.aborted);
  const retry=sharing.read(owner.toRawString(),{at:head});await Promise.resolve();release();assert((await retry).complete);assert.equal(calls,3,'last abort removes a stalled flight');
  let wrong=false;
  const strict=new BalanceService({roots,network:'testnet',reader:{wallets:async()=>({head:wrong?next:head,owner:{balance:'1'},rows:[]})}});
  const missing=await strict.read(owner.toRawString(),{at:head});assert.equal(missing.assets.length,4);assert.equal(missing.complete,false);
  assert(missing.assets.slice(1).every(row=>row.status==='unavailable'&&row.balance_raw===null));
  wrong=true;await assert.rejects(strict.read(owner.toRawString(),{at:head}),ChainReadError);
  console.log('Balance completeness, manifest order/precision, native failure, warm batching, exact heads, concurrent sharing and cancellation passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
