import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentOrderRecoveryCaptures } from './currentOrderRecoveryCapture';
import { orderShard } from '../../orders/evidence';
import { boundaryState } from '../../runtime/physicalEvidence';
import { currentDlmmFixtureBinding } from './currentDlmmFixture';
import type { ChainHead } from '../../data/dataSource';
/** Original native account envelopes; only the source/block adapter is mocked.
 * No original cursor is removed, and absent history is never a substitute. */
export function currentOrderRecoveryBinding(c: any) {
  const binding = currentDlmmFixtureBinding(c);
  binding.orderWalletAbsences = (c.absentWallets ?? []).map((a: any) => {
    assert.equal(a.address, c.binding.wallets.orderPay.address);
    const r = a.accountResult, h = a.head;
    assert.deepEqual(h, r.block_id);
    assert.equal(r.state, 'uninitialized'); assert.equal(r.balance, '0'); assert.equal(r.code, ''); assert.equal(r.data, '');
    const { shard } = orderShard(a.shardAccountBoc, a.address); assert.equal(shard.account, undefined);
    assert.equal(String(shard.lastTransactionLt), r.last_transaction_id.lt);
    assert.equal(shard.lastTransactionHash.toString(16).padStart(64, '0'), Buffer.from(r.last_transaction_id.hash, 'base64').toString('hex'));
    const boundary: ChainHead = { workchain: h.workchain, shard: h.shard, seqno: h.seqno, utime: r.sync_utime,
      rootHashHex: Buffer.from(h.root_hash, 'base64').toString('hex'), fileHashHex: Buffer.from(h.file_hash, 'base64').toString('hex') };
    const state = boundaryState(a.address, a.shardAccountBoc, boundary.seqno).state;
    return { address: a.address, boundary, state: { ...state, sourceMasterchain: boundary,
      anchor: { shardBlock: { ...boundary, workchain: 0 }, genUtime: boundary.utime } } };
  });
  return binding;
}
export function currentOrderRecoveryOriginals(folder?: string): any[] {
  if (folder) return readdirSync(folder).filter(f => f.endsWith('.json')).sort().map(file => ({ file, ...JSON.parse(readFileSync(join(folder, file), 'utf8')) }));
  return currentOrderRecoveryCaptures();
}
