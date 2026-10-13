import type { ChainSource } from './dataSource';
import { createJettonWalletReader } from './jettonWallet';

const readers = new WeakMap<ChainSource, ReturnType<typeof createJettonWalletReader>>();
export function jettonWalletReader(source: ChainSource) {
  let reader = readers.get(source);
  if (!reader) {
    reader = createJettonWalletReader({ source, walletTemplateCodeHash: null });
    readers.set(source, reader);
  }
  return reader;
}

/** Transitional null semantics for consumers migrated in IDX-04. The balances
 * and identity packages replace these with explicit qualified reader results. */
export async function jettonWalletOrNull(source: ChainSource, owner: string, master: string) {
  const row = await jettonWalletReader(source).wallet(master, owner);
  return row.status === 'ok' ? { wallet: row.wallet, balance: row.balanceRaw } : null;
}
