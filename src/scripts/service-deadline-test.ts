import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ChainReadError, type AccountStateResponse, type ChainHead } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { loadConfig } from '../config';
import { loadOpcodes } from '../utils/opcodes';
import { MemoryStore } from '../store/memoryStore';
import { BlockFollower } from '../workers/blockFollower';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import type { HeadFeed } from '../runtime/headFeed';
const config = {...loadConfig(),network:'testnet' as const,healthCacheTtlMs:0,initialHistoryTimeoutMs:30};
const address = `0:${'1'.repeat(64)}`;
const head = fixtureHead(101,1_700_000_100);
const anchor = {shardBlock:{...fixtureHead(91),workchain:0,rootHashHex:'c'.repeat(64)},genUtime:1_700_000_050};
const state: AccountStateResponse = {balance:'70',accountState:'uninitialized',anchor};
const typed = (code:string) => (error:unknown) => error instanceof ChainReadError && error.code===code;
const make = (source:ReturnType<typeof fakeChainSource>) => new IndexerService(config,new MemoryStore(config),source,loadOpcodes(),[]);
async function main() {
  let calls=0,signal:AbortSignal|undefined;
  const service=make(fakeChainSource({head:async()=>head,runGetMethod:async(_address,_method,_args,options)=>{
    signal=options?.signal;assert.equal(options?.at,head);calls++;
    if(calls===1)return new Promise(()=>{});
    return {exitCode:0,stack:[{type:'int',value:7n}]};
  }}));
  await assert.rejects(service.runGetMethod(address,'read',[],{signal:AbortSignal.timeout(15)}),typed('upstream_timeout'));
  assert(signal!.aborted);assert.equal((await service.runGetMethod(address,'read')).stack[0][1],'7');assert.equal(calls,2);
  const failure=new ChainReadError('upstream_unavailable');
  await assert.rejects(make(fakeChainSource({head:async()=>head,runGetMethod:async()=>{throw failure;}})).runGetMethod(address,'read'),error=>error===failure);
  const anchored=make(fakeChainSource({head:async()=>head,getAccountState:async(_address,options)=>{assert.equal(options?.at,head);assert(options?.signal);return state;},
    read:async(calls,options)=>{assert(options?.signal);return {head,results:calls.map(call=>({kind:'account' as const,address:call.address,state}))};}}));
  const observation=await anchored.getAccountAnchor(address);assert.deepEqual(observation,{head,state,anchor});
  const fresh=await anchored.readFresh([{kind:'account',address}]);
  assert.equal(fresh.readContext.head.utime,head.utime);assert.deepEqual(fresh.results[0].shard_block,anchor.shardBlock);assert.equal(fresh.results[0].shard_utime,anchor.genUtime);
  assert.equal((await anchored.getState(address)).last_confirmed_seqno,head.seqno);
  for(const invalid of [undefined,{...anchor,genUtime:0},{...anchor,shardBlock:{...anchor.shardBlock,rootHashHex:'0'.repeat(64)}}])
    await assert.rejects(make(fakeChainSource({head:async()=>head,getAccountState:async()=>({...state,anchor:invalid})})).getAccountAnchor(address),typed('upstream_unavailable'));
  await assert.rejects(make(fakeChainSource({head:async()=>head,getAccountState:async()=>{throw failure;}})).getAccountAnchor(address),error=>error===failure);
  let accountSignal:AbortSignal|undefined;
  await assert.rejects(make(fakeChainSource({head:async()=>head,getAccountState:async(_address,options)=>{accountSignal=options?.signal;return new Promise(()=>{});}}))
    .getAccountAnchor(address,{signal:AbortSignal.timeout(15)}),typed('upstream_timeout'));assert(accountSignal!.aborted);
  const historyStore=new MemoryStore(config);let histories=0;
  const history=new IndexerService(config,historyStore,fakeChainSource({getAccountState:async(_address,options)=>{
    histories++;if(histories===1){accountSignal=options?.signal;return new Promise(()=>{});}return state;
  }}),loadOpcodes(),[]);
  await assert.rejects(history.getTransactions(address,1),typed('upstream_timeout'));assert(accountSignal!.aborted);
  assert.equal((await history.getTransactions(address,1)).history_complete,true,'expired source work releases the address lock');
  const health=make(fakeChainSource({health:()=>({peersConfigured:3,peersReady:2,head,peers:[]})})).getHealth();
  assert.deepEqual(health.chain,{peersConfigured:3,peersReady:2,headSeqno:101,headAgeSec:Math.max(0,Math.floor(Date.now()/1000)-head.utime)});
  assert.equal(health.ledger,'disabled');assert.equal(health.disk,'ok');assert(!('liteserverPoolStatus' in health));
  let listener:((head:ChainHead)=>void)|undefined,unsubscribed=false,polled=0;
  const feed:HeadFeed={current:()=>head,subscribe(fn){listener=fn;fn(head);return()=>{unsubscribed=true;listener=undefined;};}};
  const followerService=make(fakeChainSource());const received:ChainHead[]=[];
  followerService.setMasterchainInfo=value=>{received.push(value);};
  const follower=new BlockFollower(config,new MemoryStore(config),fakeChainSource({head:async()=>{polled++;return head;}}),loadOpcodes(),{warn(){},error(){},info(){},debug(){}} as any,followerService,undefined,feed);
  follower.start();listener!({...head,seqno:102});await delay(0);follower.stop();
  assert.equal(polled,0);assert.deepEqual(received.map(value=>value.seqno),[101,102]);assert(unsubscribed);
  console.log('Service deadlines, retry after hanging work, honest anchors, fresh-read times, typed errors, health and shared HeadFeed passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
