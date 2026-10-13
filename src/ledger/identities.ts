import { Address, Cell } from '@ton/core';
import type { ChainSource } from '../data/dataSource';
import { createJettonWalletReader } from '../data/jettonWallet';
import { isSuccessfulGetterResult, parseCanonicalJettonWalletData } from '../data/jettonAbi';
import type { Network } from '../models';
import { metadataText } from '../utils/jettonMetadata';
import type { OwnerCycle } from './cycle';
import { readCurrentJettonWalletStorage } from './jettonWalletState';
import { canonicalLedgerAddress } from './normalize';
import type { PostgresLedgerStore } from './store';
import type { LedgerAsset } from './types';

type Identity = { wallet: string; owner: string; master: string; code_hash: string; verified_seqno: string | number };
export type WalletIdentityOptions = {
  network: Network; store: PostgresLedgerStore; source: ChainSource; walletTemplateCodeHash: string | null;
  tokens?: Array<{ master: string; symbol?: string; decimals?: number }>;
};
/** Release-scoped verified identities survive a getter outage. Only successful
 * authentication is durable; neither failures nor unknown identities are cached. */
export class WalletIdentityStore {
  readonly reader: ReturnType<typeof createJettonWalletReader>;
  private tokens: Map<string, { symbol?: string; decimals?: number }>;
  private metadata = new Map<string, { symbol?: string; decimals?: number }>();
  constructor(private options: WalletIdentityOptions) {
    this.reader = createJettonWalletReader(options);
    this.tokens = new Map((options.tokens ?? []).map(token => [canonicalLedgerAddress(token.master), token]));
  }
  private asset(row: Identity): LedgerAsset {
    const display = this.tokens.get(row.master) ?? this.metadata.get(row.master);
    return { kind: 'jetton', id: `${this.options.network}:jetton:${row.master}`,
      master: row.master, wallet: row.wallet, owner: row.owner,
      ...(display?.symbol === undefined ? {} : { symbol: display.symbol }),
      ...(display?.decimals === undefined ? {} : { decimals: display.decimals }) };
  }
  /** Previously qualified owner/root discovery remains available even when the
   * root getter is unavailable. It does not claim a current wallet balance. */
  async known(owner: string, master: string, cycle: OwnerCycle): Promise<LedgerAsset | null> {
    const rows = (await this.options.store.pool.query(`SELECT wallet,owner,master,code_hash,verified_seqno FROM ledger_wallet_identities
      WHERE network=$1 AND owner=$2 AND master=$3 AND verified_seqno <= $4 ORDER BY wallet`,
      [this.options.network, canonicalLedgerAddress(owner), canonicalLedgerAddress(master), cycle.boundary.seqno])).rows;
    return rows.length === 1 ? this.asset(rows[0]) : null;
  }
  async resolve(walletInput: string, cycle: OwnerCycle): Promise<LedgerAsset | null> {
    try {
      const wallet = canonicalLedgerAddress(walletInput), { store, source, network, walletTemplateCodeHash } = this.options;
      const saved: Identity | undefined = (await store.pool.query(`SELECT wallet,owner,master,code_hash,verified_seqno
        FROM ledger_wallet_identities WHERE network=$1 AND wallet=$2`, [network, wallet])).rows[0];
      if (saved) return Number(saved.verified_seqno) <= cycle.boundary.seqno ? this.asset(saved) : null;
      const options = { at: cycle.boundary, signal: cycle.signal };
      const state = await source.getAccountState(wallet, options);
      if (state.accountState !== 'active' || !state.codeBoc) return null;
      const code = Cell.fromBase64(state.codeBoc);
      if (code.isExotic) return null;
      const codeHash = code.hash().toString('hex');
      let owner: Address, master: Address;
      if (codeHash === walletTemplateCodeHash) {
        if (!state.dataBoc) return null;
        const data = readCurrentJettonWalletStorage(Cell.fromBase64(state.dataBoc));
        owner = data.owner; master = data.root;
      } else {
        const answer = await source.runGetMethod(wallet, 'get_wallet_data', [], options);
        if (!isSuccessfulGetterResult(answer) || answer.stack.length !== 4) return null;
        const address = (item: typeof answer.stack[number]) => {
          if (!('cell' in item) || !['slice', 'cell', 'builder'].includes(item.type)) throw Error('wallet_identity_unavailable');
          const slice = item.cell.beginParse(), value = slice.loadAddress();
          if (slice.remainingBits || slice.remainingRefs) throw Error('wallet_identity_unavailable');
          return value;
        };
        owner = address(answer.stack[1]); master = address(answer.stack[2]);
        if (!parseCanonicalJettonWalletData(answer.stack, { owner, root: master, walletCode: code })) return null;
      }
      // Root-declared code, canonical address and owner/root/storage must all
      // agree at this boundary; a self-reported foreign wallet is not identity.
      const verified = await this.reader.wallet(master.toRawString(), owner.toRawString(), options);
      if (verified.status !== 'ok' || verified.wallet !== wallet) return null;
      const row: Identity = { wallet, owner: owner.toRawString(), master: master.toRawString(), code_hash: codeHash, verified_seqno: cycle.boundary.seqno };
      await store.pool.query(`INSERT INTO ledger_wallet_identities(network,wallet,owner,master,code_hash,verified_seqno)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(network,wallet) DO NOTHING`,
        [network, wallet, row.owner, row.master, row.code_hash, row.verified_seqno]);
      // A racing verifier must agree with the durable identity; never replace it.
      const stored: Identity = (await store.pool.query(`SELECT wallet,owner,master,code_hash,verified_seqno
        FROM ledger_wallet_identities WHERE network=$1 AND wallet=$2`, [network, wallet])).rows[0];
      if (!stored || stored.owner !== row.owner || stored.master !== row.master || stored.code_hash !== codeHash) return null;
      if (!this.tokens.has(row.master) && !this.metadata.has(row.master)) {
        const metadata = await this.reader.metadata(row.master, options);
        if (metadata) this.metadata.set(row.master, { symbol: metadataText(metadata.symbol), decimals: metadata.decimals });
      }
      return this.asset(stored);
    } catch { return null; }
  }
}
