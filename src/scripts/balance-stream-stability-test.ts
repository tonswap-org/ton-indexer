import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BalanceStreamHub, type BalanceStreamEvent } from '../balances/balanceStream';
import type { BalanceSnapshot } from '../balances/balanceService';
import type { ChainHead } from '../data/dataSource';
import type { HeadFeed } from '../runtime/headFeed';
import { fixtureHead } from './support/chainFixture';
const owner=`0:${'1'.repeat(64)}`, t3=`0:${'2'.repeat(64)}`, usdt=`0:${'3'.repeat(64)}`;
function feed(){
  let value:ChainHead|null=fixtureHead(1),subscribes=0;const listeners=new Set<(head:ChainHead)=>void>();
  return {current:()=>value,subscribe(fn:(head:ChainHead)=>void){subscribes++;listeners.add(fn);if(value)fn(value);return()=>{listeners.delete(fn);};},
    push(seqno:number){value=fixtureHead(seqno);for(const listener of listeners)listener(value);},get subscribes(){return subscribes;},get listeners(){return listeners.size;}} satisfies HeadFeed&Record<string,unknown>;
}
function snapshot(address:string,head:ChainHead,options:{unavailable?:boolean;t3?:string;usdt?:string}={}):BalanceSnapshot{return {
  address,network:'testnet',head_seqno:head.seqno,head_utime:head.utime,complete:!options.unavailable,assets:[
    {kind:'native',symbol:'GRAM',decimals:9,status:'ok',balance_raw:'10'},
    {kind:'jetton',symbol:'T3',root:t3,wallet:`0:${'4'.repeat(64)}`,decimals:9,status:'ok',balance_raw:options.t3??'20'},
    options.unavailable?{kind:'jetton',symbol:'USDT',root:usdt,wallet:null,decimals:6,status:'unavailable',balance_raw:null,reason:'timeout'}:
    {kind:'jetton',symbol:'USDT',root:usdt,wallet:`0:${'5'.repeat(64)}`,decimals:6,status:'ok',balance_raw:options.usdt??'30'}]};}
const tick=()=>delay(0);
const changes=(events:BalanceStreamEvent[])=>events.filter(event=>event.type==='balances_changed');
async function main(){
  const heads=feed(),events:BalanceStreamEvent[]=[],second:BalanceStreamEvent[]=[];let reads=0,fail=false,newValue='20',unknownInitially=false;
  const hub=new BalanceStreamHub({heads,service:{read:async(address,options)=>{reads++;assert(options?.signal);if(fail)throw new Error('unavailable');
    await tick();return snapshot(address,options!.at!,{unavailable:unknownInitially||options!.at!.seqno%2===0,t3:newValue});}}});
  const unsubscribe=hub.subscribe([owner,owner],event=>events.push(event));const unsubscribeTwo=hub.subscribe([owner],event=>second.push(event));
  await delay(5);assert.equal(reads,1);assert.equal(heads.subscribes,1);assert.equal(events.length,1);assert.equal(second.length,1);
  assert.equal(events[0].type,'balances_snapshot');
  for(let seqno=2;seqno<=11;seqno++){heads.push(seqno);await delay(5);}
  assert.equal(reads,11);assert.equal(changes(events).length,0,'availability flapping does not change balances');assert.equal(changes(second).length,0);
  newValue='21';heads.push(12);await delay(5);assert.equal(reads,12);assert.equal(changes(events).length,1);assert.equal(events.at(-2)!.type,'balances_changed');
  const changed=changes(events)[0];assert(changed.type==='balances_changed');assert.deepEqual(changed.hints,{ton:false,jettons:[t3]});
  assert.equal(events.at(-1)!.type,'balances_snapshot');assert.equal(changes(second).length,1);
  const third:BalanceStreamEvent[]=[];const unsubscribeThree=hub.subscribe([owner],event=>third.push(event));assert.equal(reads,12);assert.equal(third.length,1,'new connection gets current snapshot without a new read');
  fail=true;heads.push(13);await delay(5);assert.equal(changes(events).length,1);assert.equal(third.length,1);
  fail=false;heads.push(14);await delay(5);assert.equal(changes(events).length,1,'recovery with the same value is silent');
  assert.deepEqual(events.map(event=>event.seq),[1,2,3]);
  unsubscribe();unsubscribeTwo();unsubscribeThree();assert.equal(heads.listeners,0);heads.push(15);await tick();assert.equal(reads,14);
  hub.close();assert.throws(()=>hub.subscribe([owner],()=>{}));
  // First verified USDT after an initially unavailable row is a change, including zero.
  const freshHeads=feed(),freshEvents:BalanceStreamEvent[]=[];unknownInitially=true;
  const freshHub=new BalanceStreamHub({heads:freshHeads,service:{read:async(address,options)=>snapshot(address,options!.at!,{unavailable:unknownInitially,usdt:'0'})}});
  freshHub.subscribe([owner],event=>freshEvents.push(event));await tick();unknownInitially=false;freshHeads.push(2);await tick();
  assert.equal(changes(freshEvents).length,1);freshHub.close();
  // At most eight reads run concurrently; a busy owner's next refresh uses the newest boundary.
  const boundedHeads=feed(),pending:Array<()=>void>=[];let running=0,peak=0,total=0,aborted=0;
  const bounded=new BalanceStreamHub({heads:boundedHeads,service:{read:async(address,options)=>{running++;peak=Math.max(peak,running);total++;
    await new Promise<void>(resolve=>{pending.push(resolve);options!.signal!.addEventListener('abort',()=>{aborted++;resolve();},{once:true});});running--;
    return snapshot(address,options!.at!);}}});
  const owners=Array.from({length:12},(_,index)=>`0:${(index+10).toString(16).padStart(64,'0')}`),output:BalanceStreamEvent[]=[];
  const stop=bounded.subscribe(owners,event=>output.push(event));assert.equal(total,8);assert.equal(peak,8);
  boundedHeads.push(2);boundedHeads.push(3);pending.splice(0,8).forEach(resolve=>resolve());await tick();assert.equal(peak,8);assert.equal(total,16);
  stop();pending.splice(0).forEach(resolve=>resolve());await tick();assert(aborted>0);assert.equal(boundedHeads.listeners,0);assert.equal(output.filter(e=>e.type==='balances_snapshot').length,8,'unsubscribed work cannot publish');bounded.close();
  // An exception in one connection's sink cannot suppress another connection.
  const sinks=feed(),received:BalanceStreamEvent[]=[];
  const isolated=new BalanceStreamHub({heads:sinks,service:{read:async(address,options)=>snapshot(address,options!.at!)}});
  isolated.subscribe([owner],()=>{throw new Error('socket closed');});isolated.subscribe([owner],event=>received.push(event));await tick();assert.equal(received.length,1);isolated.close();
  console.log('Balance streams: availability stability, exact value changes, first verification, shared subscribers, 8-owner bound, cancellation and sink isolation passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
