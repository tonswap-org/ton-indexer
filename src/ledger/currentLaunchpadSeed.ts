import { Cell } from '@ton/core';
import { activeOrderAccount } from '../orders/evidence';
import { isPlatformActivityNotice } from '../runtime/spotEvidenceIdentity';
import { decodeNativeLiqAdd, decodeSwapEvent } from './currentDlmmState';
import { decodeLaunchLp } from './currentLaunchpadState';
import { launchpadChild, linked, need, raw, receives, type CurrentLaunchpadBinding, type CurrentLaunchpadTransaction as Tx } from './currentLaunchpadProof';

export const LP_SEED_REPLY=0x50535250, LP_SEED_QUERY=0x50535159, LP_SEED_ADD=0x4c515341;
type Lp=ReturnType<typeof decodeLaunchLp>;
const sameLeg=(a:{remaining:bigint;id:bigint;sent:bigint},b:typeof a)=>
  a.remaining===b.remaining&&a.id===b.id&&a.sent===b.sent;

export function checkLpIdentity(a:Lp,z:Lp){
  need(raw(a.sale)===raw(z.sale)&&raw(a.lpRecipient)===raw(z.lpRecipient)&&raw(a.dlmmFactory)===raw(z.dlmmFactory)
    &&a.seedBin===z.seedBin&&a.poolId.equals(z.poolId)&&raw(a.pool)===raw(z.pool)&&a.armedAt===z.armedAt&&a.unlockAt===z.unlockAt);
}

/** Manual requests may move just the two outstanding IDs or return the fixed creator's reserve at unlock. */
export function verifyManualLpAutomation(a:Lp,z:Lp,kind:string,query:bigint,executed:Tx){
  checkLpIdentity(a,z);
  const b=a.automation,n=z.automation;need(b&&n&&b.planned===n.planned&&b.nextSide===n.nextSide&&b.sequence===n.sequence);
  if(kind==='lp-release'){
    need(b.fund>0n&&n.fund===0n&&n.closed&&sameLeg(b.t3,n.t3)&&sameLeg(b.project,n.project));
    need(executed.tx.outMessages.values().some(m=>m.info.type==='internal'&&raw(m.info.dest)===raw(a.identity.creator)
      &&m.info.value.coins===b.fund&&m.body.bits.length===0&&m.body.refs.length===0));return;
  }
  need(kind==='lp-seed'&&b.closed===n.closed&&b.fund===n.fund);
  for(const [old,next,amount] of [[b.t3,n.t3,a.t3Bal],[b.project,n.project,a.tokenBal]] as const){
    if(b.planned&&!b.closed&&old.remaining>0n&&amount>0n)need(old.sent===0n&&next.remaining===old.remaining&&next.id===query&&next.sent===amount);
    else need(sameLeg(old,next));
  }
}

export function launchpadSeedAdd(payload:Cell,payer:string,retain:boolean,wrapped:boolean){
  if(!wrapped)return decodeNativeLiqAdd(payload);
  need(!payload.isExotic);const s=payload.beginParse();
  need(s.loadUint(32)===LP_SEED_ADD&&raw(s.loadAddress())===payer&&s.loadBit()===retain);
  const inner=s.loadRef();s.endParse();need(!inner.isExotic);return decodeNativeLiqAdd(inner);
}

export function readSeedPreview(body:Cell,tag:number){
  need(!body.isExotic);const s=body.beginParse();need(s.loadUint(32)===tag);
  const id=s.loadUintBig(64),side=s.loadUint(8),bin=s.loadInt(32),amount=s.loadCoins(),payer=raw(s.loadAddress())!;
  const allowed=tag===LP_SEED_REPLY?s.loadBit():true;s.endParse();need(id>>63n===1n&&side<=1&&amount>0n);
  return {id,side,bin,amount,payer,allowed};
}

export function autoSeedBoundary(a:Lp,z:Lp,r:ReturnType<typeof readSeedPreview>){
  checkLpIdentity(a,z);
  const b=a.automation,n=z.automation;need(b&&n&&b.planned&&n.planned&&!b.closed&&!n.closed&&n.fund<b.fund
    &&n.nextSide===b.nextSide&&b.sequence===n.sequence&&r.id===((1n<<63n)|b.sequence)&&a.seedBin===r.bin&&r.allowed);
  const [current,issued,other,nextOther]=r.side===0?[b.t3,n.t3,b.project,n.project]:[b.project,n.project,b.t3,n.t3];
  need(current.remaining===r.amount&&current.sent===0n&&issued.remaining===r.amount&&issued.sent===r.amount&&issued.id===r.id&&sameLeg(other,nextOther));
  need(a.t3Bal-z.t3Bal===(r.side===0?r.amount:0n)&&a.tokenBal-z.tokenBal===(r.side===1?r.amount:0n));
}

/** Link the immutable pool's answer to an actual ordinary trade through the release relay, vault and factory. */
export function ordinarySeedOrigin(executed:Tx,binding:CurrentLaunchpadBinding,txs:Tx[]){
  const m=binding.manifest,lp=executed.account,response=executed.tx.inMessage;need(response?.info.type==='internal');
  const r=readSeedPreview(response.body,LP_SEED_REPLY),pool=raw(response.info.src)!;
  const parents=(t:Tx,from:string,tag:number)=>{
    const msg=t.tx.inMessage;need(msg?.info.type==='internal'&&raw(msg.info.src)===from&&msg.body.bits.length>=32&&msg.body.beginParse().preloadUint(32)===tag);
    const options=txs.filter(p=>p.account===from&&p.succeeded&&linked(p,t));need(options.length===1);return options[0];
  };
  const read=parents(executed,pool,LP_SEED_REPLY),polled=parents(read,lp,LP_SEED_QUERY);
  const request=readSeedPreview(read.tx.inMessage!.body,LP_SEED_QUERY);
  need(request.id===r.id&&request.side===r.side&&request.bin===r.bin&&request.amount===r.amount&&request.payer===r.payer);
  const factory=m.contracts.SaleFactory!,vault=m.contracts.GasVault!,relay=m.contracts.FeeRouter!;
  need(r.payer===vault.address);
  const scheduled=parents(polled,factory.address,0x53504f4b),work=parents(scheduled,vault.address,0x53464455),relayed=parents(work,relay.address,0x47564143);
  const poke=polled.tx.inMessage!.body.beginParse().skip(32),tick=poke.loadUintBig(64);poke.loadUintBig(64);need(raw(poke.loadAddress())===vault.address);poke.endParse();
  const job=scheduled.tx.inMessage!.body.beginParse().skip(32);need(job.loadUintBig(64)===tick);job.endParse();
  const first=relayed.tx.inMessage;need(first?.info.type==='internal');
  const origin=raw(first.info.src)!;
  need((origin===pool||m.spotMarkets.some(market=>market.pool===origin))&&first.body.equals(work.tx.inMessage!.body));
  need(isPlatformActivityNotice(m,first,origin,[origin]));
  const swap=parents(relayed,origin,0x47564143);
  need(swap.tx.outMessages.values().some(msg=>msg.info.type==='external-out'&&raw(msg.info.src)===origin&&decodeSwapEvent(msg.body)?.status===0));
  for(const [tx,code] of [[swap,m.templates.DlmmPool],[relayed,relay.codeHash],[work,vault.codeHash],[scheduled,factory.codeHash],[polled,m.templates.LpVault],[read,m.templates.DlmmPool]] as const)activeOrderAccount(tx.before,code);
  return [swap.hash,relayed.hash,work.hash,scheduled.hash,polled.hash,read.hash];
}

export function verifySeedConfirmation(poolTx:Tx,lpAccount:string,query:bigint,side:number,amount:bigint,bin:number,shares:bigint,b:CurrentLaunchpadBinding,txs:Tx[]){
  const rows=poolTx.tx.outMessages.values().filter(m=>m.info.type==='internal'&&raw(m.info.dest)===lpAccount&&m.body.bits.length>=32&&m.body.beginParse().preloadUint(32)===0x4c514f33);need(rows.length===1);
  const msg=rows[0],s=msg.body.beginParse().skip(32);
  need(s.loadUintBig(64)===query&&s.loadUint(8)===0&&s.loadUint(8)===0&&s.loadUint(8)===side&&s.loadUint(3)===1&&s.loadCoins()===amount);
  const row=s.loadRef().beginParse();s.endParse();need(row.loadInt(32)===bin&&row.loadUintBig(256)===shares&&row.loadMaybeRef()===null);row.endParse();
  const accepted=txs.filter(t=>t.succeeded&&t.account===lpAccount&&receives(poolTx,msg,t));if(accepted.length!==1)return null;
  const before=decodeLaunchLp(launchpadChild(accepted[0],b)),after=decodeLaunchLp(launchpadChild(accepted[0],b,true));
  checkLpIdentity(before,after);const a=before.automation,z=after.automation;need(a&&z);
  const from=side===0?a.t3:a.project,to=side===0?z.t3:z.project;
  need(from.id===query&&from.sent===amount&&from.remaining===amount&&to.id===query&&to.sent===0n&&to.remaining===0n);
  return accepted[0].hash;
}
