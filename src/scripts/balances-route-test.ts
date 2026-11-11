import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';
import { registerRoutes } from '../api/routes';
import { BalanceService } from '../balances/balanceService';
import { BalanceStreamHub } from '../balances/balanceStream';
import { ChainReadError, type ChainHead } from '../data/dataSource';
import { fixtureHead } from './support/chainFixture';
import type { HeadFeed } from '../runtime/headFeed';
async function main(){
  const owners=[1,2,3].map(n=>`0:${String(n).repeat(64)}`),root=`0:${'4'.repeat(64)}`,wallet=`0:${'5'.repeat(64)}`;
  let head=fixtureHead(),listener:((head:ChainHead)=>void)|undefined,unavailable=false,nativeFailure=false,amount='10',calls=0;
  const heads:HeadFeed={current:()=>head,subscribe(fn){listener=fn;return()=>{listener=undefined;};}};
  const balances=new BalanceService({network:'testnet',roots:[{master:root,symbol:'TEST',decimals:6}],reader:{async wallets(_roots,_owner,options){calls++;assert(options?.signal);if(nativeFailure)throw new ChainReadError('upstream_unavailable');return{head:options?.at??head,owner:{balance:'123'},rows:[unavailable?{status:'unavailable' as const,root,wallet,reason:'upstream' as const}:{status:'ok' as const,root,wallet,balanceRaw:amount,lastTxLt:'1',lastTxHash:'a'.repeat(64)}]};}}});
  const streams=new BalanceStreamHub({service:balances,heads}),app=Fastify();registerRoutes(app,{network:'testnet'},{} as any,undefined,undefined,undefined,undefined,undefined,undefined,{balances,streams});
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert(address&&typeof address!=='string');const events:any[]=[];let buffer='';const abort=new AbortController();let pump:Promise<void>|undefined;
  const until=async(predicate:()=>boolean)=>{for(let i=0;i<100;i++){if(predicate())return;await delay(10);}throw Error('Balance stream did not settle');};
  try{
    const response=await app.inject(`/api/indexer/v1/accounts/${owners[0]}/balances`);assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{address:owners[0],network:'testnet',head_seqno:1,head_utime:head.utime,complete:true,assets:[{kind:'native',symbol:'GRAM',status:'ok',balance_raw:'123',decimals:9},{kind:'jetton',symbol:'TEST',root,wallet,decimals:6,status:'ok',balance_raw:'10'}]});
    unavailable=true;const partial=await app.inject(`/api/indexer/v1/accounts/${owners[0]}/balances`);assert.equal(partial.json().complete,false);assert.deepEqual(partial.json().assets[1],{kind:'jetton',symbol:'TEST',root,wallet,decimals:6,status:'unavailable',balance_raw:null,reason:'upstream'});
    nativeFailure=true;const failed=await app.inject(`/api/indexer/v1/accounts/${owners[0]}/balances`);assert.equal(failed.statusCode,503);assert.equal(failed.json().code,'upstream_unavailable');assert(Number(failed.headers['retry-after'])>=1);nativeFailure=false;unavailable=false;
    const stream=await fetch(`http://127.0.0.1:${address.port}/api/indexer/v1/stream/balances?address=${owners[0]}&wallet=${owners[2]}&addresses=${owners[1]},${owners[0]}`,{signal:abort.signal});assert.equal(stream.status,200);
    pump=(async()=>{const reader=stream.body!.getReader();try{while(true){const chunk=await reader.read();if(chunk.done)return;buffer+=Buffer.from(chunk.value).toString();let split:number;while((split=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,split);buffer=buffer.slice(split+2);const data=event.split('\n').find(line=>line.startsWith('data: '));if(data)events.push(JSON.parse(data.slice(6)));}}}catch(error){if(!abort.signal.aborted)throw error;}})();
    await until(()=>events.filter(e=>e.type==='balances_snapshot').length===2);assert.deepEqual(events.find(e=>e.type==='subscribed').addresses,owners.slice(0,2));assert(!events.some(e=>e.address===owners[2]));
    for(let i=2;i<=5;i++){unavailable=i%2===0;head=fixtureHead(i);listener!(head);await until(()=>calls>=3+2*i);await delay(20);}
    assert.equal(events.filter(e=>e.type==='balances_changed').length,0);assert.equal(events.filter(e=>e.type==='balances_snapshot').length,2);
    amount='11';head=fixtureHead(6);listener!(head);await until(()=>events.filter(e=>e.type==='balances_changed').length===2);
    assert.equal(events.filter(e=>e.type==='balances_snapshot').length,4);
    console.log('Explicit balance rows, native503, combined address/addresses, ignored wallet alias and availability-silent shared SSE passed.');
  }finally{abort.abort();await pump;streams.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
