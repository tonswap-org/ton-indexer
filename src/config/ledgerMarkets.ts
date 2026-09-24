import type { Network } from '../models';
import { canonicalLedgerAddress } from '../ledger/normalize';
import type { DlmmMarketBinding } from '../ledger/marketTypes';

/** Explicit release code/token bindings; never learn a trusted code hash from current RPC state. */
export function parseLedgerMarketBindings(raw: string | undefined, network: Network): DlmmMarketBinding[] {
  if (raw === undefined || raw.trim() === '') return [];
  const fail = () => new Error('LEDGER_MARKET_BINDINGS_JSON must be an array of unique canonical pools with exactly network, pool, poolCodeHash, walletCodeHash, tokenT, tokenX, tokenTCodeHash, tokenXCodeHash, router and routerCodeHash; network must match this indexer.');
  let values: unknown; try { values = JSON.parse(raw); } catch { throw fail(); }
  if (!Array.isArray(values) || values.length > 256) throw fail();
  const seen = new Set<string>();
  for (const value of values) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'network,pool,poolCodeHash,router,routerCodeHash,tokenT,tokenTCodeHash,tokenX,tokenXCodeHash,walletCodeHash' ||
        value.network !== network || ![value.pool, value.tokenT, value.tokenX].every(address => typeof address === 'string' && canonicalLedgerAddress(address) === address) ||
        value.tokenT === value.tokenX || seen.has(value.pool) || ![value.poolCodeHash, value.walletCodeHash, value.tokenTCodeHash, value.tokenXCodeHash].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw fail();
      if ((value.router === null) !== (value.routerCodeHash === null) || (value.router !== null &&
        (typeof value.router !== 'string' || canonicalLedgerAddress(value.router) !== value.router ||
         typeof value.routerCodeHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.routerCodeHash)))) throw fail();
      seen.add(value.pool);
    } catch { throw fail(); }
  }
  return values as DlmmMarketBinding[];
}
