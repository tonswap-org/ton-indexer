import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, beginCell, loadTransaction, Dictionary } from '@ton/core';
import { DLMM_SETTLEMENT_START, readDlmmLiquidityRefund, readDlmmSettlementRecord, readDlmmMarketState } from '../ledger/dlmmState';
import { readDlmmPendingLiquidityAdd } from '../ledger/dlmmLiquidityState';
import { dlmmLiquidityNotificationCommitment, NOTIFY, protocolForward, tokenWire } from '../ledger/wire';

// Constructed adversarial ABI cells; these are not historical execution evidence.
const owner = new Address(0, Buffer.alloc(32, 1)), root = new Address(0, Buffer.alloc(32, 2));
const pool = new Address(0, Buffer.alloc(32, 3)), poolWallet = new Address(0, Buffer.alloc(32, 4));
const ownerWallet = new Address(0, Buffer.alloc(32, 5));
const request = beginCell().storeUint(0x444c4144, 32).storeUint(45, 64).storeInt(0, 32).storeAddress(owner).storeUint(1, 256).endCell();
const body = beginCell().storeUint(NOTIFY, 32).storeUint(46, 64).storeCoins(7).storeAddress(owner).storeAddress(ownerWallet).storeCoins(200000000).storeRef(request).endCell();
const message = {source: poolWallet.toRawString(), destination: pool.toRawString(), createdLt: '100', body: body.toBoc().toString('base64'), op: NOTIFY};
const commitment = dlmmLiquidityNotificationCommitment(message)!;
assert.match(commitment, /^[a-f0-9]{64}$/);
assert.equal(commitment, beginCell().storeUint(0x444c5246, 32).storeAddress(pool).storeAddress(poolWallet).storeUint(100, 64).storeUint(BigInt('0x' + body.hash().toString('hex')), 256).endCell().hash().toString('hex'));
for (const changed of [{createdLt: '101'}, {source: ownerWallet.toRawString()}, {destination: owner.toRawString()}, {body: beginCell().storeSlice(body.beginParse()).storeBit(0).endCell().toBoc().toString('base64')}])
  assert.notEqual(dlmmLiquidityNotificationCommitment({...message, ...changed}), commitment, 'identical query/amount does not merge distinct incoming messages');
for (const changed of [{createdLt: '0'}, {createdLt: '-1'}, {createdLt: (1n << 64n).toString()}, {createdLt: undefined}, {destination: undefined}, {op: 1}, {bounced: true}])
  assert.equal(dlmmLiquidityNotificationCommitment({...message, ...changed}), null);
console.log('PASS exact notification commitment binds pool, source wallet, creation LT and body');

const refund = (options: {query?: bigint; predecessor?: bigint; destination?: Address; token?: Address} = {}) => beginCell().storeUint(0x444c5246, 32)
  .storeUint(options.query ?? 45n, 64).storeUint(BigInt('0x' + commitment), 256).storeUint(options.predecessor ?? 0n, 64)
  .storeAddress(options.destination ?? owner).storeAddress(options.token ?? root).endCell();
assert.equal(refund().bits.length, 950);
assert.deepEqual(readDlmmLiquidityRefund(refund()), {businessQueryId: '45', notificationHash: commitment, predecessorId: '0', owner: owner.toRawString(), tokenRoot: root.toRawString()});
assert.equal(readDlmmLiquidityRefund(refund({predecessor: DLMM_SETTLEMENT_START})).predecessorId, DLMM_SETTLEMENT_START.toString());
const oldReceipt = beginCell().storeUint(0x444c5246, 32).storeUint(45, 64).storeAddress(owner).storeAddress(root).endCell();
for (const invalid of [oldReceipt, beginCell().storeSlice(refund().beginParse()).storeBit(0).endCell(), beginCell().storeSlice(refund().beginParse()).storeRef(beginCell().endCell()).endCell()])
  assert.throws(() => readDlmmLiquidityRefund(invalid), /refund_layout/);
const record = (payload = refund(), predecessor = 0n) => beginCell().storeUint(0x44535231, 32).storeUint(DLMM_SETTLEMENT_START + 1n, 64).storeUint(99, 256).storeUint(45, 64)
  .storeUint(predecessor, 64).storeUint(0, 64).storeInt(1000, 64).storeUint(3, 8).storeUint(0, 8).storeUint(1, 8)
  .storeRef(beginCell().storeCoins(7).storeCoins(0).storeCoins(0).endCell()).storeRef(beginCell().storeAddress(poolWallet).storeAddress(owner).storeAddress(ownerWallet).endCell()).storeRef(payload).endCell();
assert.equal(readDlmmSettlementRecord(record()).kind, 3);
assert.equal(readDlmmSettlementRecord(record(refund({predecessor: DLMM_SETTLEMENT_START}), DLMM_SETTLEMENT_START)).predecessorId, DLMM_SETTLEMENT_START.toString());
for (const invalid of [refund({query: 46n}), refund({predecessor: DLMM_SETTLEMENT_START}), refund({destination: pool})])
  assert.throws(() => readDlmmSettlementRecord(record(invalid)), /refund_identity/);
assert.throws(() => readDlmmSettlementRecord(record(oldReceipt)), /refund_layout/);
console.log('PASS current refund receipt binds settlement query, predecessor and destination; old layout rejected');

const pending = (notifications = beginCell().storeUint(BigInt('0x' + commitment), 256).storeUint(0, 256).endCell(), include = true) => {
  const b = beginCell().storeCoins(7).storeCoins(0).storeCoins(200000000).storeCoins(0).storeUint(1, 256)
    .storeRef(beginCell().storeAddress(owner).storeAddress(null).endCell());
  if (include) b.storeRef(notifications);
  return b.endCell();
};
assert.equal(readDlmmPendingLiquidityAdd(pending()).notificationHashT, commitment);
assert.throws(() => readDlmmPendingLiquidityAdd(pending(undefined, false)), /pending_layout/);
for (const invalid of [beginCell().storeUint(0, 512).endCell(), beginCell().storeUint(1, 256).storeUint(2, 256).endCell()])
  assert.throws(() => readDlmmPendingLiquidityAdd(pending(invalid)), /pending_fields/);
for (const invalid of [beginCell().storeUint(1, 511).endCell(), beginCell().storeUint(1, 512).storeRef(beginCell().endCell()).endCell()])
  assert.throws(() => readDlmmPendingLiquidityAdd(pending(invalid)), /pending_notifications/);
console.log('PASS pending add requires exactly one occupied side and its mandatory notification commitment');

const fixtureDir = resolve(__dirname, 'fixtures/dlmm-referral-liquidity-current/refunds');
const provenance = JSON.parse(readFileSync(resolve(fixtureDir, '../provenance.json'), 'utf8'));
const fixtureNames = readdirSync(fixtureDir).filter(name => name.endsWith('.json'));
assert(fixtureNames.includes('refund-finalized.json') && fixtureNames.includes('refund-duplicate-side.json'));
let detachedQueueChecked = false, fundedQueueChecked = false;
function alterQueueRecord(boc: string, record: ReturnType<typeof readDlmmSettlementRecord>, changes: {status?: number; successorId?: string; fundedRaw?: string}, clearLane = false) {
  const cell = Cell.fromBase64(boc), meta = cell.refs[3], position = meta.refs[1], journal = position.refs[3];
  const records = Dictionary.load(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell(), journal.refs[0]);
  const old = records.get(BigInt(record.settlementId))!;
  const next = beginCell().storeUint(0x44535231, 32).storeUint(BigInt(record.settlementId), 64).storeBuffer(Buffer.from(record.requestHash, 'hex'))
    .storeUint(BigInt(record.businessQueryId), 64).storeUint(BigInt(record.predecessorId), 64).storeUint(BigInt(changes.successorId ?? record.successorId), 64)
    .storeInt(BigInt(record.recordedAt), 64).storeUint(record.kind, 8).storeUint(record.tokenSide, 8).storeUint(changes.status ?? record.status, 8)
    .storeRef(beginCell().storeCoins(BigInt(record.amountRaw)).storeCoins(BigInt(record.forwardTonAmountRaw)).storeCoins(BigInt(changes.fundedRaw ?? record.fundedRaw)).endCell())
    .storeRef(old.refs[1]).storeRef(old.refs[2]).endCell();
  records.set(BigInt(record.settlementId), next);
  const replace = (parent: Cell, index: number, child: Cell) => {const b = beginCell().storeBits(parent.bits); parent.refs.forEach((ref, i) => b.storeRef(i === index ? child : ref)); return b.endCell();};
  let changed = replace(journal, 0, beginCell().storeDict(records).endCell());
  if (clearLane) {
    const lanes = Dictionary.load(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(64), journal.refs[1]);
    lanes.delete(BigInt('0x' + beginCell().storeAddress(Address.parse(record.sourceWallet)).endCell().hash().toString('hex')));
    changed = replace(changed, 1, beginCell().storeDict(lanes).endCell());
  }
  return replace(cell, 3, replace(meta, 1, replace(position, 3, changed))).toBoc().toString('base64');
}
for (const name of fixtureNames) {
  const bytes = readFileSync(resolve(fixtureDir, name)), fixture = JSON.parse(bytes.toString());
  assert.equal(Cell.fromBase64(fixture.poolCode).hash().toString('hex'), provenance.poolCodeHash);
  const entries = fixture.transactions.map((row: any) => ({...row, tx: loadTransaction(Cell.fromBase64(row.transaction).beginParse())}));
  const accountHeads = new Map<string, {lt: bigint; hash: bigint}>();
  for (const row of [...entries].sort((a, b) => a.tx.lt < b.tx.lt ? -1 : a.tx.lt > b.tx.lt ? 1 : 0)) {
    assert.equal(row.tx.address, BigInt('0x' + Address.parse(row.account).hash.toString('hex')));
    const previous = accountHeads.get(row.account);
    if (previous) {
      assert.equal(row.tx.prevTransactionLt, previous.lt, 'complete captured account chain has no skipped transaction');
      assert.equal(row.tx.prevTransactionHash, previous.hash, 'raw transaction BOCs preserve original predecessor hashes');
    }
    accountHeads.set(row.account, {lt: row.tx.lt, hash: BigInt('0x' + Cell.fromBase64(row.transaction).hash().toString('hex'))});
  }
  const notifications = new Map<string, {owner: string; amount: string; query: string; token: string; bodyHash: string}>();
  for (const row of entries.filter((row: any) => row.account === fixture.pool)) {
    const message = row.tx.inMessage;
    if (message?.info.type !== 'internal' || message.body.bits.length < 32 || message.body.beginParse().preloadUint(32) !== NOTIFY) continue;
    const info = message.info, raw = {source: info.src.toRawString(), destination: info.dest.toRawString(), createdLt: info.createdLt.toString(), body: message.body.toBoc().toString('base64'), op: NOTIFY, bounced: info.bounced};
    const notification = tokenWire(raw)!, intent = protocolForward(notification.forward)!;
    assert.equal(intent.operation, 'lp_deposit'); assert.equal(info.dest.toRawString(), fixture.pool);
    const side = fixture.poolWallets.indexOf(info.src.toRawString()); assert(side >= 0);
    const commitment = dlmmLiquidityNotificationCommitment(raw)!; assert(commitment); assert(!notifications.has(commitment));
    const independentlyEncoded = beginCell().storeUint(0x444c5246, 32).storeAddress(info.dest).storeAddress(info.src).storeUint(info.createdLt, 64)
      .storeUint(BigInt('0x' + message.body.hash().toString('hex')), 256).endCell().hash().toString('hex');
    assert.equal(commitment, independentlyEncoded);
    notifications.set(commitment, {owner: notification.owner!, amount: notification.amountRaw, query: intent.queryId, token: fixture.roots[side], bodyHash: message.body.hash().toString('hex')});
  }
  const allocated = new Map<string, ReturnType<typeof readDlmmLiquidityRefund>>();
  let rootNegativeChecked = false;
  for (const row of entries.filter((row: any) => row.account === fixture.pool && row.newStorage)) {
    const before = row.oldStorage ? readDlmmMarketState(row.oldStorage) : null, after = readDlmmMarketState(row.newStorage);
    const queued = new Set<string>();
    for (const cell of after.queues.values()) {
      let wire = cell.beginParse().loadUintBig(64).toString();
      while (wire !== '0') {queued.add(wire); wire = after.settlements.get(wire)!.successorId;}
    }
    for (const record of after.settlements.values()) {
      const required = (record.forwardTonAmountRaw !== '0' || record.forwardPayload.bits.length || record.forwardPayload.refs.length ? 160000000n : 140000000n) + BigInt(record.forwardTonAmountRaw) + 40000000n;
      // Constructed adversarial mutations of actual current ABI boundaries,
      // never replacement execution evidence or altered qualification inputs.
      if (!detachedQueueChecked && !queued.has(record.settlementId)) {
        assert.equal(record.status, 1); assert.equal(record.successorId, '0');
        readDlmmMarketState(alterQueueRecord(row.newStorage, record, {fundedRaw: required.toString()}));
        for (const changes of [{status: 2}, {successorId: record.settlementId}, {fundedRaw: (required + 1n).toString()}])
          assert.throws(() => readDlmmMarketState(alterQueueRecord(row.newStorage, record, changes)), /queue_coverage/);
        detachedQueueChecked = true;
      }
      if (!fundedQueueChecked && record.status === 2 && queued.has(record.settlementId)) {
        const ready = alterQueueRecord(row.newStorage, record, {status: 1, fundedRaw: required.toString()}, true);
        readDlmmMarketState(ready);
        assert.throws(() => readDlmmMarketState(alterQueueRecord(ready, {...record, status: 1}, {fundedRaw: (required - 1n).toString()})), /queue_membership/);
        fundedQueueChecked = true;
      }
      if (record.kind !== 3) continue;
      const proof = readDlmmLiquidityRefund(record.forwardPayload), original = notifications.get(proof.notificationHash); assert(original);
      assert.equal(record.amountRaw, original.amount, 'one refund never aggregates distinct notifications');
      assert.equal(proof.businessQueryId, original.query); assert.equal(proof.owner, original.owner); assert.equal(proof.tokenRoot, original.token);
      if (!before?.settlements.has(record.settlementId)) {
        assert(!allocated.has(record.settlementId));
        if (proof.predecessorId !== '0') assert.deepEqual({...allocated.get(proof.predecessorId), predecessorId: proof.predecessorId}, proof, 'replacement preserves original contribution identity');
        allocated.set(record.settlementId, proof);
      }
      if (!rootNegativeChecked) {
        const cell = Cell.fromBase64(row.newStorage), meta = cell.refs[3], position = meta.refs[1], journal = position.refs[3];
        const records = Dictionary.load(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell(), journal.refs[0]), id = BigInt(record.settlementId), old = records.get(id)!;
        const replace = (value: Cell, index: number, child: Cell) => {const b = beginCell().storeBits(value.bits); value.refs.forEach((ref, i) => b.storeRef(i === index ? child : ref)); return b.endCell();};
        const wrongRoot = beginCell().storeUint(0x444c5246, 32).storeUint(BigInt(proof.businessQueryId), 64).storeUint(BigInt('0x' + proof.notificationHash), 256).storeUint(BigInt(proof.predecessorId), 64)
          .storeAddress(Address.parse(proof.owner)).storeAddress(Address.parse(fixture.pool)).endCell();
        records.set(id, replace(old, 2, wrongRoot));
        const changed = replace(cell, 3, replace(meta, 1, replace(position, 3, replace(journal, 0, beginCell().storeDict(records).endCell()))));
        assert.throws(() => readDlmmMarketState(changed.toBoc().toString('base64')), /refund_root_invalid/);
        rootNegativeChecked = true;
      }
    }
  }
  assert(allocated.size > 0 && rootNegativeChecked);
  if (name === 'refund-duplicate-side.json') {
    const distinctBodies = new Set([...notifications.values()].map(n => n.bodyHash)).size;
    assert(notifications.size > distinctBodies, 'assigned creation LTs keep repeated identical bodies distinct from each other and the other token side');
  }
  assert.equal(readFileSync(resolve(fixtureDir, name)).equals(bytes), true, 'original native BOCs remain unchanged');
  console.log(`PASS actual ${name}: ${allocated.size} exact refund allocations, source commitments and root binding`);
}
assert(detachedQueueChecked && fundedQueueChecked, 'current fixtures exercise detached recovery and funded queue admission');
console.log('PASS funded queue rejects an unfunded member, detached active wire, foreign successor and excess funding');
