import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cell, Dictionary, loadMessage, loadTransaction, type Slice } from '@ton/core';
import { readFixedSaleState } from '../ledger/launchpadState';
import { readBondingSaleState } from '../ledger/launchpadBondingState';
import { readAuctionSaleState } from '../ledger/launchpadAuctionState';
import { launchpadCommand } from '../ledger/launchpadWire';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';

const parsers = {fixed: readFixedSaleState, bonding: readBondingSaleState, auction: readAuctionSaleState};
const h = (cell: Cell) => cell.hash().toString('hex');
let assertions = 0;
for (const model of ['fixed', 'bonding', 'auction'] as const) for (const outcome of ['delivered', 'refunded']) {
  const file = resolve(__dirname, `fixtures/launchpad-referral-${model}-${outcome}.json`), trace = JSON.parse(readFileSync(file,'utf8'));
  const parse = parsers[model], saleRows = trace.transactions.filter((t:any) => t.account === trace.addresses.sale);
  assert(saleRows.length > 5);
  for (const row of trace.transactions) {
    const raw = Cell.fromBase64(row.boc), tx = loadTransaction(raw.beginParse());
    assert.equal(h(raw),row.hash); assert.equal(tx.lt.toString(),row.lt); assert.equal(tx.prevTransactionLt.toString(),row.prevTxLt);
    assert.equal(tx.prevTransactionHash.toString(16).padStart(64,'0'),row.prevTxHash);
    for (const message of [row.incoming,...row.outgoing].filter(Boolean)) {
      const cell = Cell.fromBase64(message.messageBoc), decoded = loadMessage(cell.beginParse());
      assert.equal(h(cell),message.messageHash); assert.equal(h(decoded.body),message.bodyHash);
      assert.equal(h(Cell.fromBase64(message.bodyBoc)),message.bodyHash);
    }
  }
  let seenAwaiting = false, seenCredit = false, seenFunding = false;
  for (const row of saleRows) for (const boc of [row.beforeDataBoc,row.afterDataBoc].filter(Boolean)) {
    const state = parse(boc), journal = state.journal;
    let native = 0n;
    for (const record of journal.entries.values()) native += BigInt(record.deliveryReservedRaw) + BigInt(record.finalizeReservedRaw);
    for (const credit of journal.referralCredits.entries.values()) {
      native += BigInt(credit.context.nativeBudgetRaw);
      assert.equal(credit.user,trace.addresses.trader); assert.equal(credit.referrer,trace.addresses.inviter);
      assert.equal(credit.registry,trace.addresses.registry); assert.equal(credit.context.feeRouter,trace.addresses.feeRouter);
      assert.equal(credit.context.tokenRoot,trace.addresses.t3); assert.equal(credit.context.sourceWallet,trace.addresses.sale_t3_wallet);
      const prerequisite = journal.entries.get(credit.context.prerequisiteId)!;
      assert(prerequisite); assert.equal(prerequisite.kind,2); assert.equal(prerequisite.referralOperationId,credit.operationId);
      if (credit.status === 0) {seenAwaiting = true; assert.notEqual(prerequisite.status,5); assert.equal(credit.context.settlementId,'0');}
      if (credit.status >= 1) {seenCredit = true; assert.equal(prerequisite.status,5);}
      if (credit.status >= 3) {
        seenFunding = true; const fee = journal.entries.get(credit.context.settlementId)!; assert(fee);
        assert.equal(fee.kind,1); assert.equal(fee.amountRaw,credit.amountRaw); assert.equal(fee.recipientOwner,trace.addresses.feeRouter);
        assert.equal(credit.context.nativeBudgetRaw,'0');
        if (credit.status === 4) {assert.equal(fee.status,5); assert.equal(fee.accountingAck,1);}
      }
    }
    assert.equal(journal.reservedNativeRaw,native.toString(),'Every retained native coin belongs to an exact unsent action or original referral');
  }
  const final = parse(saleRows.at(-1).afterDataBoc);
  if (outcome === 'delivered') {
    assert(seenAwaiting && seenCredit && seenFunding);
    assert.equal(final.journal.referralCredits.entries.size,1); const credit = [...final.journal.referralCredits.entries.values()][0];
    assert.equal(credit.status,4); assert.equal(final.journal.reservedPaymentRaw,'0'); assert.equal(final.journal.reservedNativeRaw,'0');
    const directRewardRaw = (BigInt(credit.amountRaw) * 500n / 10000n).toString();
    assert(BigInt(credit.totalRewardedRaw) >= BigInt(directRewardRaw));
    const mintRow = trace.transactions.filter((t:any) => t.account === trace.addresses.inviter_ts_wallet).at(-1); assert(mintRow);
    const wallet = readCurrentJettonWalletStorage(Cell.fromBase64(mintRow.afterDataBoc));
    assert.equal(wallet.balance.toString(),directRewardRaw); assert.equal(wallet.owner.toRawString(),trace.addresses.inviter);
    assert.equal(wallet.root.toRawString(),trace.addresses.ts);
    const receipts = Dictionary.loadDirect(Dictionary.Keys.BigUint(64), {serialize:():never=>{throw Error('read only');},parse:(s:Slice)=>{
      const status=s.loadUint(8),wire=s.loadUintBig(64),query=s.loadUintBig(64),amount=s.loadCoins(),requestHash=s.loadUintBig(256);
      assert.equal(s.remainingBits+s.remainingRefs,0); return {status,wire,query,amount,requestHash};
    }}, wallet.mintReceipts);
    assert.equal(receipts.size,1); const [wire,receipt]=[...receipts][0]; assert.equal(receipt.status,2); assert.equal(receipt.wire,wire);
    assert.equal(receipt.amount.toString(),directRewardRaw); assert(receipt.requestHash>0n);
  } else { assert.equal(final.journal.referralCredits.entries.size,0); assert(!seenCredit); assert.equal(final.metrics.totalFeesRaw,'0'); }
  assertions++; console.log(`ok ${assertions} - ${model} ${outcome}: authentic raw evidence, exact retained native reserve, purchase-before-credit and immutable token receipt`);
}
// Missing or changed inviter bytes are not silently interpreted as no referral.
for (const opcode of [0x434e5452,0x50424944]) {
  const {beginCell}=require('@ton/core'); let b=beginCell().storeUint(opcode,32).storeUint(1,64);
  if(opcode===0x50424944)b=b.storeCoins(1).storeCoins(1);
  b=b.storeAddress(null).storeAddress(null);const old=b.endCell();
  assert.equal(launchpadCommand({body:old.toBoc().toString('base64')}),null);
  const canonical=beginCell().storeSlice(old.beginParse()).storeRef(beginCell().storeAddress(null).endCell()).endCell();
  assert(launchpadCommand({body:canonical.toBoc().toString('base64')}));
  const trailing=beginCell().storeSlice(old.beginParse()).storeRef(beginCell().storeAddress(null).storeBit(1).endCell()).endCell();
  assert.equal(launchpadCommand({body:trailing.toBoc().toString('base64')}),null);
}
console.log('Current Launchpad referral ABI and actual automatic token-delivery proofs passed. Sandbox evidence only.');
