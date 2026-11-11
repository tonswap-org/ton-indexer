import { Address } from '@ton/core';
import { orderShard } from '../orders/evidence';
import { canonicalLedgerHash } from './normalize';
import type { AccountStateResponse, ChainHead } from '../data/dataSource';
/** The authenticated source alone supplies provenAbsent. This record preserves
 * its exact cycle boundary. An original Account-none envelope also retains its
 * real cursor, which the decoder must match to complete failed-only history.
 * A missing history/getter/BOC cannot create either authority. */
export type CurrentOrderWalletAbsence = { address: string; boundary: ChainHead; state: AccountStateResponse };
export function currentOrderWalletAbsent(value: CurrentOrderWalletAbsence, address: string) {
  try {
    const { boundary: h, state: s } = value, source = s.sourceMasterchain;
    const physicalEmpty = () => {
      if (!s.shardAccountBoc) return s.provenAbsent === true && s.lastTxLt === undefined && s.lastTxHash === undefined;
      const { shard } = orderShard(s.shardAccountBoc, address);
      return !shard.account && s.lastTxLt === String(shard.lastTransactionLt) && !!s.lastTxHash
        && canonicalLedgerHash(s.lastTxHash) === canonicalLedgerHash(shard.lastTransactionHash.toString(16).padStart(64, '0'));
    };
    return value.address === address && Address.parse(address).workChain === 0 && Address.parse(address).toRawString() === address
      && h.workchain === -1 && Number.isSafeInteger(h.seqno) && h.seqno > 0 && Number.isSafeInteger(h.utime) && h.utime > 0
      && /^[0-9a-f]{64}$/.test(h.rootHashHex) && /^[0-9a-f]{64}$/.test(h.fileHashHex)
      && !!source && (['workchain','shard','seqno','rootHashHex','fileHashHex','utime'] as const).every(k => source[k] === h[k])
      && physicalEmpty() && !!s.anchor && s.anchor.genUtime <= h.utime && s.anchor.shardBlock.workchain === 0
      && Number.isSafeInteger(s.anchor.genUtime) && s.anchor.genUtime >= 0 && s.accountState === 'uninitialized'
      && s.balance === '0' && s.codeBoc === null && s.dataBoc === null;
  } catch { return false; }
}
