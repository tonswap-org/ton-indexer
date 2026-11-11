import { canonicalLedgerAddress } from '../../ledger/normalize';
import type { ChainSource } from '../../data/dataSource';
import type { WalletIdentityStore } from '../../ledger/identities';
import type { RefreshDependency } from '../../ledger/cycle';
import type { PostgresLedgerStore } from '../../ledger/store';
import type { LedgerAsset } from '../../ledger/types';
import type { Network } from '../../models';
import type { FixtureChainSource } from './chainFixture';

/** Existing domain fixtures already supply qualified identities. This adapter
 * preserves that explicit trust boundary; it does not test wallet qualification. */
export function fixtureIdentities(source: ChainSource, resolve: (wallet: string) => Promise<LedgerAsset | null>): WalletIdentityStore {
  const walletBalance = (source as FixtureChainSource).walletBalance;
  return { resolve, known: async (owner: string, master: string) => {
    const row = await walletBalance(owner, master); return row ? resolve(canonicalLedgerAddress(row.wallet)) : null;
  }, reader: { wallet: async (master: string, owner: string) => {
    const row = await walletBalance(owner, master);
    return row ? { status: 'ok', ...row, wallet: canonicalLedgerAddress(row.wallet), root: master, owner } : { status: 'unavailable' };
  } } } as unknown as WalletIdentityStore;
}
export const storedRefresh = (store: PostgresLedgerStore, network: Network, onRead?: (account: string) => void): RefreshDependency => async account => {
  onRead?.(account);
  const row = await store.account(network, account);
  return { account, generation: row?.current_generation ?? null, head: row?.head_lt && row?.head_hash ? { lt: row.head_lt, hash: row.head_hash } : null,
    complete: row?.complete === true, atBoundary: row?.complete === true, errorCode: null };
};
export function installFixtureIdentities(service: import('../../ledger/service').LedgerService, source: ChainSource, assets: Map<string, LedgerAsset>) {
  (service as unknown as { identities: WalletIdentityStore }).identities = fixtureIdentities(source, async wallet => assets.get(wallet) ?? null);
}
