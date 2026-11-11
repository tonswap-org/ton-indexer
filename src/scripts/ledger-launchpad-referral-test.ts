import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, beginCell, Cell, Dictionary, loadMessage, loadShardAccount, loadTransaction } from '@ton/core';
import { readFixedSaleState } from '../ledger/launchpadState';
import { readBondingSaleState } from '../ledger/launchpadBondingState';
import { readAuctionSaleState } from '../ledger/launchpadAuctionState';
import { readLaunchpadDirectFeeConfig, readLaunchpadReferralTerms } from '../ledger/launchpadStateCommon';
import { readLaunchpadReferralCredits, readLaunchpadSharedSettlement } from '../ledger/launchpadSharedJournal';
import { launchpadCommand } from '../ledger/launchpadWire';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { tokenWire } from '../ledger/wire';

const parsers = {fixed: readFixedSaleState, bonding: readBondingSaleState, auction: readAuctionSaleState};
const h = (cell: Cell) => cell.hash().toString('hex');
const body = (row:any) => row.incoming ? Cell.fromBase64(row.incoming.bodyBoc) : null;
const opcode = (row:any) => { const cell = body(row); return cell && cell.bits.length >= 32 ? cell.beginParse().preloadUint(32) : null; };
const wallet = (boc:string) => readCurrentJettonWalletStorage(Cell.fromBase64(boc));
function walletDelta(rows:any[], address:string) {
  const r=rows.filter(row=>row.account===address); assert(r.length, 'Physical wallet transaction required');
  return wallet(r.at(-1).afterDataBoc).balance - (r[0].beforeDataBoc ? wallet(r[0].beforeDataBoc).balance : 0n);
}
function validateRaw(row:any) {
  const raw=Cell.fromBase64(row.boc), tx=loadTransaction(raw.beginParse());
  assert.equal(h(raw),row.hash); assert.equal(tx.lt.toString(),row.lt); assert.equal(tx.prevTransactionLt.toString(),row.prevTxLt);
  assert.equal(tx.prevTransactionHash.toString(16).padStart(64,'0'),row.prevTxHash);
  for(const [state,expected] of [[row.before,tx.stateUpdate.oldHash],[row.after,tx.stateUpdate.newHash]] as const) {
    const shard=Cell.fromBase64(state.originalShardAccount), account=shard.refs[0], decoded=loadShardAccount(shard.beginParse());
    assert.equal(h(account),expected.toString('hex')); assert.equal(h(Cell.fromBase64(state.accountBoc)),h(account));
    assert.equal(decoded.lastTransactionLt.toString(),state.lastTxLt);
    assert.equal(decoded.lastTransactionHash.toString(16).padStart(64,'0'),state.lastTxHash);
    if(decoded.account) { assert.equal(decoded.account.storage.balance.coins.toString(),state.balance);
      if(decoded.account.storage.state.type==='active') assert.equal(h(decoded.account.storage.state.state.data!),h(Cell.fromBase64(state.dataBoc))); }
  }
  assert.equal(row.beforeDataBoc,row.before.dataBoc); assert.equal(row.afterDataBoc,row.after.dataBoc);
  for(const message of [row.incoming,...row.outgoing].filter(Boolean)) {
    const cell=Cell.fromBase64(message.messageBoc), decoded=loadMessage(cell.beginParse());
    assert.equal(h(cell),message.messageHash); assert.equal(h(decoded.body),message.bodyHash);
    assert.equal(h(Cell.fromBase64(message.bodyBoc)),message.bodyHash);
  }
  let sent=0n;
  for(const message of tx.outMessages.values()) if(message.info.type==='internal') sent+=message.info.value.coins+message.info.forwardFee+message.info.ihrFee;
  const received=tx.inMessage?.info.type==='internal'?tx.inMessage.info.value.coins:0n;
  assert.equal(BigInt(row.before.balance)+received-sent-tx.totalFees.coins,BigInt(row.after.balance),'Actual native conservation including all outgoing forward fees');
  return tx;
}
function rejectLegacyCredit(cell:Cell) {
  const out=cell.beginParse(), nonce=out.loadUintBig(64), cursor=out.loadUintBig(64);
  const values={serialize:(value:Cell,b:any)=>b.storeSlice(value.beginParse()),parse:(s:any):Cell=>{const c=s.asCell();s.skip(s.remainingBits);while(s.remainingRefs)s.loadRef();return c;}};
  const entries=out.loadDict(Dictionary.Keys.BigUint(64),values), ready=out.loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Uint(8));
  const [id,entry]=[...entries][0]; assert(entry);
  const fake=beginCell().storeUint(0x43524544,32).storeUint(id,64).storeUint(1,32).storeAddress(Address.parse('0:'+'11'.repeat(32))).storeCoins(1).storeAddress(null).endCell();
  const b=beginCell().storeBits(entry.bits); entry.refs.forEach((ref,i)=>b.storeRef(i===0?fake:ref)); entries.set(id,b.endCell());
  assert.throws(()=>readLaunchpadReferralCredits(beginCell().storeUint(nonce,64).storeUint(cursor,64).storeDict(entries).storeDict(ready).endCell()),/RFFL/);
}
let assertions=0;
for(const model of ['fixed','bonding','auction'] as const) for(const outcome of ['delivered','refunded','rejected']) {
  const trace=JSON.parse(readFileSync(resolve(__dirname,`fixtures/launchpad-direct-fee-${model}-${outcome}.json`),'utf8'));
  assert.equal(trace.schema,'tonswap.launchpad-current-direct-fee-proof.v1');
  assert.equal(trace.environment,'sandbox-canonical-vm15-gas400-production-code');
  const parse=parsers[model], saleRows=trace.transactions.filter((t:any)=>t.account===trace.addresses.sale);
  assert(saleRows.length>5); for(const row of trace.transactions) validateRaw(row);
  let seenAwaiting=false, seenFunding=false;
  for(const row of saleRows) for(const boc of [row.beforeDataBoc,row.afterDataBoc].filter(Boolean)) {
    const state=parse(boc), journal=state.journal; assert.deepEqual(state.referral,{registry:null,key:0});
    let native=0n;
    for(const record of journal.entries.values()) native+=BigInt(record.deliveryReservedRaw)+BigInt(record.finalizeReservedRaw);
    for(const credit of journal.referralCredits.entries.values()) {
      native+=BigInt(credit.context.nativeBudgetRaw);
      assert.equal(credit.registry,trace.addresses.feeRouter); assert.equal(credit.context.feeRouter,trace.addresses.feeRouter);
      assert.equal(credit.totalRewardedRaw,'0'); assert.equal(credit.actualReferrer,null);
      assert.equal(credit.creditId,h(beginCell().storeAddress(Address.parse(trace.addresses.sale)).storeUint(BigInt(credit.operationId),64).endCell()));
      assert.equal(credit.context.tokenRoot,trace.addresses.t3); assert.equal(credit.context.sourceWallet,trace.addresses.sale_t3_wallet);
      const prerequisite=journal.entries.get(credit.context.prerequisiteId)!; assert(prerequisite);
      assert.equal(prerequisite.kind,2); assert.equal(prerequisite.recipientOwner,trace.addresses.trader);
      assert.equal(prerequisite.referralOperationId,credit.operationId);
      if(credit.status===0){seenAwaiting=true;assert.notEqual(prerequisite.status,5);assert.equal(credit.context.settlementId,'0');}
      else { seenFunding=true;assert.equal(prerequisite.status,5);const fee=journal.entries.get(credit.context.settlementId)!;assert(fee);
        assert.equal(fee.kind,1);assert.equal(fee.amountRaw,credit.amountRaw);assert.equal(fee.recipientOwner,trace.addresses.feeRouter);
        assert.equal(fee.nativeRefundOwner,trace.addresses.trader);assert.equal(credit.context.nativeBudgetRaw,'0');
        if(credit.status===4){assert.equal(fee.status,5);assert.equal(fee.accountingAck,1);}
      }
    }
    assert.equal(journal.reservedNativeRaw,native.toString(),'Every retained native coin belongs to an exact action or direct fee');
  }
  const final=parse(saleRows.at(-1).afterDataBoc);
  if(outcome==='refunded') {
    assert.equal(final.journal.referralCredits.entries.size,0);assert(!seenFunding);assert.equal(final.metrics.totalFeesRaw,'0');
    assert.equal(walletDelta(trace.transactions,trace.addresses.trader_t3_wallet),0n,'Full original T3 returned physically');
  } else {
    assert(seenAwaiting&&seenFunding);assert.equal(final.journal.referralCredits.entries.size,1);
    const credit=[...final.journal.referralCredits.entries.values()][0];assert.equal(credit.status,4);
    assert.equal(final.journal.reservedPaymentRaw,'0');assert.equal(final.journal.reservedNativeRaw,'0');
    assert.equal(walletDelta(trace.transactions,trace.addresses.feeRouter_t3_wallet),BigInt(credit.amountRaw));
    assert.equal(walletDelta(trace.transactions,trace.addresses.trader_x_wallet),model==='auction'?50_000_000_000n:100_000_000_000n);
    const inner=Cell.fromBase64(saleRows.at(-1).afterDataBoc).refs[3], journal=inner.refs[model==='auction'?2:3];
    rejectLegacyCredit(journal.refs.at(-1)!);
  }
  assert(!trace.transactions.some((row:any)=>[trace.addresses.inviter_ts_wallet,trace.addresses.registry,trace.addresses.distributor].includes(row.account)),'No referral credit or TS payout graph');
  if(outcome==='rejected') {
    const bad=saleRows.find((row:any)=>opcode(row)===0x5352464c);assert(bad);
    const tx=loadTransaction(Cell.fromBase64(bad.boc).beginParse());assert(tx.description.type==='generic'&&tx.description.aborted);
    assert.equal(bad.beforeDataBoc,bad.afterDataBoc,'Nonzero configuration changed no sale business state');
    const request=trace.transactions.find((row:any)=>row.account===trace.addresses.trader_t3_wallet&&tokenWire({body:row.incoming?.bodyBoc})?.queryId==='912');assert(request);
    const requested=tokenWire({body:request.incoming.bodyBoc})!, command=launchpadCommand({body:requested.forward.toBoc().toString('base64')});
    assert(command&&'referrer'in command);assert.equal(command.referrer,trace.addresses.inviter);
    const nextValid=trace.transactions.findIndex((row:any)=>row.account===trace.addresses.trader_t3_wallet&&tokenWire({body:row.incoming?.bodyBoc})?.queryId==='901');assert(nextValid>0);
    const rejected=trace.transactions.slice(0,nextValid), before=wallet(request.beforeDataBoc).balance;
    const returned=rejected.filter((row:any)=>row.account===trace.addresses.trader_t3_wallet).at(-1);assert(returned);assert.equal(wallet(returned.afterDataBoc).balance,before);
    const last=rejected.filter((row:any)=>row.account===trace.addresses.sale).at(-1), state=parse(last.afterDataBoc);
    assert.equal(state.journal.referralCredits.entries.size,0);assert.equal(state.metrics.totalFeesRaw,'0');
    const refund=[...state.journal.entries.values()].find(record=>record.kind===3&&record.amountRaw==='100000000000');assert(refund);assert.equal(refund.status,5);
    assert.equal(('contributions'in state?state.contributions:state.bids).size,0,'Inviter request created no entitlement');
  }
  assertions++;console.log(`ok ${assertions} - ${model} ${outcome}: authentic VM accounts, native conservation, physical direct fee/refund and no TS reward`);
}
for(const registry of [null,Address.parse('0:'+'11'.repeat(32))])for(const key of [0,1]) {
  const cell=beginCell().storeAddress(registry).storeUint(key,32).endCell();
  if(registry===null&&key===0)assert.deepEqual(readLaunchpadDirectFeeConfig(cell.beginParse()),{registry:null,key:0});
  else assert.throws(()=>readLaunchpadDirectFeeConfig(cell.beginParse()),/direct fees/);
}
assert.throws(()=>readLaunchpadReferralTerms(beginCell().storeCoins(1).storeAddress(Address.parse('0:'+'11'.repeat(32))).endCell()),/cannot have a referrer/);
for(const opcode of [0x434e5452,0x50424944]) {
  let b=beginCell().storeUint(opcode,32).storeUint(1,64);if(opcode===0x50424944)b=b.storeCoins(1).storeCoins(1);
  const prefix=b.storeAddress(null).storeAddress(null).endCell();assert.equal(launchpadCommand({body:prefix.toBoc().toString('base64')}),null);
  assert(launchpadCommand({body:beginCell().storeSlice(prefix.beginParse()).storeRef(beginCell().storeAddress(null).endCell()).endCell().toBoc().toString('base64')}));
  assert.equal(launchpadCommand({body:beginCell().storeSlice(prefix.beginParse()).storeRef(beginCell().storeAddress(null).storeBit(1).endCell()).endCell().toBoc().toString('base64')}),null);
}
console.log('Current Launchpad direct-fee ABI and actual token-delivery/rejection proofs passed. Sandbox evidence only.');
