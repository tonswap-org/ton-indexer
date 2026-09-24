import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { readRiskVaultPayoutJournal } from '../ledger/perpsCounterparty';
import { normalizeLedgerEvent } from '../ledger/normalize';
import { businessOpcode, nativeFundingRefund, tokenWire, SETTLEMENT_INTERNAL } from '../ledger/wire';
import { loadOpcodes } from '../utils/opcodes';

const directory = join(__dirname, 'fixtures/native-funding-risk-vault-current');
const provenance = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
const bytes = readFileSync(join(directory, 'payout.json'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
const capture = JSON.parse(bytes.toString());
const root = Cell.fromBase64(capture.beforeAccounts.vault.data).refs[1].refs[3].beginParse().loadAddress().toRawString();
const data = (phase: string) => Cell.fromBase64(capture[phase].vault.data);
const read = (cell: Cell) => readRiskVaultPayoutJournal(cell, 1, '10', root, capture.code.walletHash);
const nodes = (rows: any[]) => rows.map(row => {
  const raw = decodeOriginalTransaction(Cell.fromBase64(row.boc), Address.parse(row.address));
  assert.equal(raw.lt, row.lt); assert.equal(Buffer.from(raw.hash, 'base64').toString('hex'), row.hash);
  return { account: row.address as string, raw };
});
const payout = nodes(capture.payoutTransactions), ack = nodes(capture.acknowledgementTransactions);
const checks: string[] = [];
async function check(name: string, run: () => void | Promise<void>) { await run(); checks.push(name); console.log('PASS', name); }

async function main() {
  await check('unchanged current RiskVault states distinguish delivered claim from retired product acknowledgement', () => {
    for (const phase of ['beforeAccounts', 'deliveredAccounts', 'finalAccounts']) {
      assert.equal(Cell.fromBase64(capture[phase].vault.code).hash().toString('hex'), capture.code.vaultHash);
      assert.equal(Cell.fromBase64(capture[phase].sourceWallet.code).hash().toString('hex'), capture.code.walletHash);
    }
    assert.equal(read(data('beforeAccounts')), null);
    const delivered = read(data('deliveredAccounts'))!;
    assert.equal(delivered.status, 3); assert.equal(delivered.amount, '10');
    assert.equal(delivered.requested, '10'); assert.equal(delivered.destination, capture.deliveredAccounts.recipientWallet.address);
    assert.deepEqual(delivered.native, { managed: true, amounts: ['0', '0', '0'], owners: [null, null, null] });
    const final = read(data('finalAccounts'))!;
    assert.equal(final.status, 4); assert.equal(final.requestHash, delivered.requestHash);
    assert.equal(final.destination, null); assert.deepEqual(final.native, delivered.native);
    const deliveries = payout.flatMap(n => n.raw.outMessages).filter(m => tokenWire(m)?.op === SETTLEMENT_INTERNAL);
    assert.equal(deliveries.length, 1); assert.equal(tokenWire(deliveries[0])!.amountRaw, '10');
    assert(!ack.flatMap(n => n.raw.outMessages).some(m => tokenWire(m)?.op === SETTLEMENT_INTERNAL));
  });
  await check('actual payout and duplicate product acknowledgement preserve all seven account native balances', async () => {
    const opcodes = loadOpcodes();
    for (const [transactions, before, after] of [[payout, 'beforeAccounts', 'deliveredAccounts'], [ack, 'deliveredAccounts', 'finalAccounts']] as const) {
      for (const name of Object.keys(capture[before])) {
        const address = capture[before][name].address;
        let net = 0n;
        for (const n of transactions.filter(n => n.account === address)) {
          const event = await normalizeLedgerEvent('localnet', address, n.raw, opcodes);
          net += event.movements.filter(m => m.asset.kind === 'native')
            .reduce((sum, m) => sum + (m.direction === 'in' ? 1n : -1n) * BigInt(m.amountRaw), 0n);
        }
        assert.equal(net, BigInt(capture[after][name].balance) - BigInt(capture[before][name].balance), `${before}/${name}`);
      }
    }
    const refunds = ack.flatMap(n => n.raw.outMessages).filter(m => nativeFundingRefund(m));
    assert(refunds.length > 0);
    assert(refunds.every(m => m.destination && Address.parse(m.destination).toRawString() === capture.finalAccounts.payerB.address));
    assert(ack.some(n => businessOpcode(n.raw.inMessage) === 0x52565041));
  });
  await check('missing native reference and trailing native data are unsupported current journal shapes', () => {
    const original = data('deliveredAccounts');
    const replaceJournal = (transform: (entry: Cell) => Cell) => {
      const tail = original.refs[3];
      const journal = tail.refs[2].beginParse();
      const entries = journal.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
      const queue = journal.loadRef();
      const key = BigInt('0x' + beginCell().storeUint(0x52564f55, 32).storeUint(2, 8).storeUint(1, 16).storeUint(10, 64).endCell().hash().toString('hex'));
      entries.set(key, transform(entries.get(key)!));
      const nextTail = beginCell().storeBits(tail.bits);
      tail.refs.forEach((ref, i) => nextTail.storeRef(i === 2 ? beginCell().storeDict(entries).storeRef(queue).endCell() : ref));
      const next = beginCell().storeBits(original.bits);
      original.refs.forEach((ref, i) => next.storeRef(i === 3 ? nextTail.endCell() : ref));
      return next.endCell();
    };
    assert.throws(() => read(replaceJournal(entry => beginCell().storeBits(entry.bits).storeRef(entry.refs[1]).endCell())));
    assert.throws(() => read(replaceJournal(entry => beginCell().storeBits(entry.bits)
      .storeRef(beginCell().storeSlice(entry.refs[0].beginParse()).storeBit(1).endCell()).storeRef(entry.refs[1]).endCell())));
    assert.throws(() => readRiskVaultPayoutJournal(original, 1, '10', root, '00'.repeat(32)));
    const replaceQueue = (queue: Cell | null) => {
      const tail = original.refs[3], journal = tail.refs[2].beginParse();
      const entries = journal.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
      const replacement = beginCell().storeDict(entries); if (queue) replacement.storeRef(queue);
      const nextTail = beginCell().storeBits(tail.bits);
      tail.refs.forEach((ref, index) => nextTail.storeRef(index === 2 ? replacement.endCell() : ref));
      return beginCell().storeRef(original.refs[0]).storeRef(original.refs[1]).storeRef(original.refs[2]).storeRef(nextTail.endCell()).endCell();
    };
    assert.throws(() => read(replaceQueue(null)), 'Missing current mandatory FIFO is unsupported.');
    assert.throws(() => read(replaceQueue(beginCell().storeUint(1, 64).storeUint(0, 64).storeBit(0).endCell())));
    assert.throws(() => read(replaceQueue(beginCell().storeUint(0, 64).storeUint(1, 64).storeBit(0).endCell())));
    const foreign = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256)); foreign.set(0n, 1n);
    assert.throws(() => read(replaceQueue(beginCell().storeUint(0, 64).storeUint(1, 64).storeDict(foreign).endCell())));

  });
  console.log(`${checks.length} current RiskVault native checks passed; no live or historical-state qualification claimed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
