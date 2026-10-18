import { Address, beginCell } from '@ton/core';
import { ledgerEventSchema, type LedgerEvent } from '../../src/ledger.js';
const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`;
const hash = Buffer.alloc(32, 0xaa).toString('base64');
export function perpsEvent(owner = addr(1), utime = 1700000000): LedgerEvent {
  const engine = addr(2), root = addr(3);
  const ref = { account: engine, lt: '444', hash, utime };
  const account = { collateralRaw: '0', pendingFundingRaw: '0', crossMargin: 0, referralLinked: 0, openPositionCount: 0 };
  return ledgerEventSchema.parse({ id: 'perps-event', network: 'testnet', account: owner, lt: '440', hash, txId: `440:${hash}`, utime, status: 'success', kind: 'perps_operation', movements: [], actions: [], issues: [],
    settlement: { protocol: 'perps', operation: 'perps_operation', status: 'confirmed', queryId: '23', evidence: [ref], perps: {
      engine, engineCodeHash: 'ab'.repeat(32), root, owner, ownerWallet: addr(4), engineWallet: addr(5), queryId: '23', fundingQueryId: '25', marketId: 1,
      positionKey: beginCell().storeAddress(Address.parse(owner)).storeUint(1, 32).endCell().hash().toString('hex'),
      request: { operation: 'open', opcode: 0x4f50454e, queryId: '23', marketId: 1, sizeRaw: '100', marginRaw: '20' },
      outcome: 'accepted', depositRaw: '20', before: { account, position: null },
      after: { account: { ...account, collateralRaw: '20', openPositionCount: 1 }, position: { owner, marketId: 1, sizeRaw: '100', marginRaw: '20', entryNotionalRaw: '100', lastFundingIndexRaw: '0', flags: 0 } },
      stateEvidence: { kind: 'perps_account_delta', stateBeforeHash: 'ab'.repeat(32), stateAfterHash: 'cd'.repeat(32), beforeSeqno: 1, afterSeqno: 2, transactions: [ref] },
      payout: { status: 'pending', amountRaw: '5', evidence: [] }, localNetworkFees: [],
    } } });
}
