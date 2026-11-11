import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Cell,Dictionary,beginCell} from '@ton/core';
import {readDlmmRouterState,readDlmmRouterSettlementRecord,readDlmmRouterSettlementGroup,readDlmmRouterSwapReceipt} from '../ledger/dlmmRouterState';
const fixture=JSON.parse(readFileSync(resolve(__dirname,'fixtures/dlmm-referral-liquidity-current/dlmm-liquidity-settlements.json'),'utf8'));
const states:Cell[]=fixture.boundaries.filter((b:any)=>b.account===fixture.accounts.router).flatMap((b:any)=>[b.before,b.after])
  .filter((s:any)=>s.dataBoc&&Cell.fromBase64(s.dataBoc).bits.length===32).map((s:any)=>Cell.fromBase64(s.dataBoc));
const boc=(c:Cell)=>c.toBoc().toString('base64');
const replace=(cell:Cell,index:number,value:Cell)=>{const b=beginCell().storeBits(cell.bits);cell.refs.forEach((ref,i)=>b.storeRef(i===index?value:ref));return b.endCell();};
const tail=(cell:Cell)=>{const b=beginCell().storeBits(cell.bits).storeBit(0);cell.refs.forEach(ref=>b.storeRef(ref));return b.endCell();};
let checks=0;const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS',name);};
test('all exact current routed historical boundaries parse their immutable code, custody journals and receipts',()=>{
  const historical=fixture.boundaries.filter((b:any)=>b.account===fixture.accounts.router);
  const initialized=historical.flatMap((b:any)=>[b.before,b.after]).filter((s:any)=>s.dataBoc);
  const bootstrap=initialized.filter((s:any)=>Cell.fromBase64(s.dataBoc).beginParse().preloadUint(32)===0x44524231);
  assert.equal(bootstrap.length,2);assert.equal(states.length,initialized.length-bootstrap.length);
  assert(states.length>0);let settlements=0,groups=0,receipts=0;
  for(const cell of states){const s=readDlmmRouterState(boc(cell));assert.equal(s.dataHash,cell.hash().toString('hex'));
    settlements+=s.settlements.size;groups+=s.groups.size;receipts+=s.swapReceipts.size;
    assert.equal(s.walletCodeHash,fixture.compiler.find((c:any)=>c.entrypointFileName.endsWith('/jetton_wallet.tolk')).codeHash);
  }assert(settlements>0&&groups>0&&receipts>0);
});
const current=states.at(-1)!;
for(const mutation of ['root-tail','extras-version','missing-wallet','missing-referral','missing-canary-owner','durable-tail','journal-tag','journal-hash','journal-tail','primary-tail','secondary-tail'] as const)test('rejects '+mutation,()=>{
  const extras=current.refs[3],tailCell=extras.refs[3],durable=tailCell.refs[3],journal=durable.refs[1];let changed=current;
  if(mutation==='root-tail')changed=tail(current);
  else if(mutation==='extras-version'){
    const b=beginCell().storeUint(4,8).storeBits(extras.bits.substring(8,extras.bits.length-8));extras.refs.forEach(ref=>b.storeRef(ref));changed=replace(current,3,b.endCell());
  }else{
    let changedDurable=durable;
    if(mutation==='missing-wallet')changedDurable=replace(durable,3,Cell.EMPTY);
    else if(mutation==='missing-referral')changedDurable=replace(durable,2,Cell.EMPTY);
    else if(mutation==='missing-canary-owner') {const b=beginCell();durable.refs.forEach(ref=>b.storeRef(ref));changedDurable=b.endCell();}
    else if(mutation==='durable-tail')changedDurable=tail(durable);
    else{
      let j=journal;
      if(mutation==='journal-tag') {const b=beginCell().storeUint(0x52534a37,32).storeBits(j.bits.substring(32,j.bits.length-32));j.refs.forEach(ref=>b.storeRef(ref));j=b.endCell();}
      if(mutation==='journal-hash'){const s=j.beginParse();s.skip(32);s.loadUintBig(64);s.loadCoins();s.loadCoins();const offset=j.bits.length-s.remainingBits;const b=beginCell().storeBits(j.bits.substring(0,offset)).storeUint(0,256);j.refs.forEach(ref=>b.storeRef(ref));j=b.endCell();}
      if(mutation==='journal-tail')j=tail(j);
      if(mutation==='primary-tail')j=replace(j,0,tail(j.refs[0]));
      if(mutation==='secondary-tail')j=replace(j,1,tail(j.refs[1]));
      changedDurable=replace(durable,1,j);
    }changed=replace(current,3,replace(extras,3,replace(tailCell,3,changedDurable)));
  }assert.throws(()=>readDlmmRouterState(boc(changed)));
});
for (const kind of ['missing-creation-journal','creation-journal-tail','missing-owner-index'] as const) test('rejects current TWAP journal '+kind,()=>{
  const extras=current.refs[3],tailCell=extras.refs[3],twap=tailCell.refs[0];
  let changedTwap:Cell;
  if(kind==='missing-creation-journal') {
    const builder=beginCell().storeBits(twap.bits);twap.refs.slice(0,3).forEach(ref=>builder.storeRef(ref));changedTwap=builder.endCell();
  } else {
    const creation=twap.refs[3];
    const changed=kind==='creation-journal-tail'?tail(creation):beginCell().storeDict(Dictionary.empty(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell())).endCell();
    changedTwap=replace(twap,3,changed);
  }
  const changed=replace(current,3,replace(extras,3,replace(tailCell,0,changedTwap)));
  assert.throws(()=>readDlmmRouterState(boc(changed)));
});
test('record, group and original receipt reject tailed custody encodings',()=>{
  const extras=current.refs[3],durable=extras.refs[3].refs[3],journal=durable.refs[1].beginParse();journal.skip(96);journal.loadCoins();journal.loadCoins();journal.skip(256);
  const primary=journal.loadRef().beginParse();
  const records=primary.loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Cell()),groups=primary.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell());
  for(const cell of records.values()){readDlmmRouterSettlementRecord(cell);assert.throws(()=>readDlmmRouterSettlementRecord(tail(cell)));}
  for(const cell of groups.values()){
    const group=readDlmmRouterSettlementGroup(cell);assert.throws(()=>readDlmmRouterSettlementGroup(tail(cell)));
    const missingOwner=beginCell().storeBits(cell.bits.substring(0,cell.bits.length-(group.refundOwner===null?2:267)));
    cell.refs.forEach(ref=>missingOwner.storeRef(ref));assert.throws(()=>readDlmmRouterSettlementGroup(missingOwner.endCell()));
  }
  const referral=durable.refs[2].beginParse();referral.loadUint(32);referral.loadCoins();referral.loadRef();referral.loadRef();referral.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.BigUint(256));
  const swaps=referral.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell());assert(swaps.size>0);
  for(const cell of swaps.values()){readDlmmRouterSwapReceipt(cell);assert.throws(()=>readDlmmRouterSwapReceipt(tail(cell)));}
});
console.log(`PASS ${checks} strict router-state groups (${states.length} historical boundaries)`);
