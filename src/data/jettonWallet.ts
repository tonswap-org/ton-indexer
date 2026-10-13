import { Address, Cell, beginCell, contractAddress } from '@ton/core';
import type { JettonMetadata } from '../models';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { parseJettonMetadata } from '../utils/jettonMetadata';
import { ChainReadError, type AccountStateResponse, type ChainSource, type ReadOptions } from './dataSource';
import { assertAccountTransactionPointer } from './accountState';
import { buildTonswapJettonWalletInitialData, cellFromAccountCodeBoc, isSuccessfulGetterResult,
  parseCanonicalJettonRootData, parseCanonicalJettonWalletAddress, parseCanonicalJettonWalletData } from './jettonAbi';

export type JettonWalletRead =
  | { status: 'ok'; root: string; wallet: string; balanceRaw: string; lastTxLt: string; lastTxHash: string }
  | { status: 'not_deployed'; root: string; wallet: string; balanceRaw: '0' }
  | { status: 'unavailable'; root: string; wallet: string | null; reason: 'timeout' | 'upstream' | 'code_mismatch' | 'root_unqualified' };
type Qualification = { code: Cell; template: boolean };
type Resolved = { root: string; owner: Address; wallet: string; qualified: Qualification };
const unavailable = (root: string, wallet: string | null, reason: Extract<JettonWalletRead, { status: 'unavailable' }>['reason']): JettonWalletRead =>
  ({ status: 'unavailable', root, wallet, reason });
const reason = (error: unknown) => error instanceof ChainReadError && error.code === 'upstream_timeout' ? 'timeout' as const : 'upstream' as const;

/** Only successful root qualifications and addresses are retained. Balances are
 * always read from accounts at the caller's single selected chain head. */
export function createJettonWalletReader({ source, walletTemplateCodeHash }: {
  source: ChainSource; walletTemplateCodeHash: string | null;
}) {
  const roots = new Map<string, Qualification>();
  const addresses = new Map<string, string>();
  async function resolve(rootInput: string, owner: Address, options: ReadOptions): Promise<Resolved | JettonWalletRead> {
    let root = rootInput;
    try {
      root = Address.parse(root).toRawString();
      let qualified = roots.get(root);
      if (!qualified) {
        const [state, result] = await Promise.all([
          source.getAccountState(root, options), source.runGetMethod(root, 'get_jetton_data', [], options),
        ]);
        const rootCode = cellFromAccountCodeBoc(state.codeBoc);
        const data = isSuccessfulGetterResult(result) ? parseCanonicalJettonRootData(result.stack) : null;
        if (state.accountState !== 'active' || !rootCode || rootCode.isExotic || !data || data.walletCode.isExotic)
          return unavailable(root, null, 'root_unqualified');
        qualified = { code: data.walletCode, template: data.walletCode.hash().toString('hex') === walletTemplateCodeHash };
        roots.set(root, qualified);
      }
      const key = `${root}:${owner.toRawString()}`;
      let wallet = addresses.get(key);
      if (!wallet) {
        if (qualified.template) wallet = contractAddress(0, { code: qualified.code,
          data: buildTonswapJettonWalletInitialData(owner, Address.parse(root)) }).toRawString();
        else {
          const result = await source.runGetMethod(root, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }], options);
          const address = isSuccessfulGetterResult(result) ? parseCanonicalJettonWalletAddress(result.stack) : null;
          if (!address) return unavailable(root, null, 'root_unqualified');
          wallet = address.toRawString();
        }
        addresses.set(key, wallet);
      }
      return { root, owner, wallet, qualified };
    } catch (error) { return unavailable(root, null, reason(error)); }
  }
  async function decode(resolved: Resolved, state: AccountStateResponse, options: ReadOptions): Promise<JettonWalletRead> {
    const { root, owner, wallet, qualified } = resolved;
    try {
      if (state.accountState === 'uninitialized') return { status: 'not_deployed', root, wallet, balanceRaw: '0' };
      const code = cellFromAccountCodeBoc(state.codeBoc);
      if (state.accountState !== 'active' || !code || !code.hash().equals(qualified.code.hash()))
        return unavailable(root, wallet, 'code_mismatch');
      let balance: bigint;
      if (qualified.template) {
        const data = cellFromAccountCodeBoc(state.dataBoc);
        if (!data) return unavailable(root, wallet, 'upstream');
        const storage = readCurrentJettonWalletStorage(data);
        if (!storage.owner.equals(owner) || !storage.root.equals(Address.parse(root))) return unavailable(root, wallet, 'upstream');
        balance = storage.balance;
      } else {
        const result = await source.runGetMethod(wallet, 'get_wallet_data', [], options);
        const data = isSuccessfulGetterResult(result) ? parseCanonicalJettonWalletData(result.stack, { owner, root: Address.parse(root), walletCode: qualified.code }) : null;
        if (!data) return unavailable(root, wallet, 'upstream');
        balance = data.balance;
      }
      assertAccountTransactionPointer(state.lastTxLt, state.lastTxHash);
      if (!state.lastTxLt || state.lastTxLt === '0' || !state.lastTxHash) return unavailable(root, wallet, 'upstream');
      return { status: 'ok', root, wallet, balanceRaw: balance.toString(), lastTxLt: state.lastTxLt, lastTxHash: state.lastTxHash };
    } catch (error) { return unavailable(root, wallet, reason(error)); }
  }
  return {
    async wallet(root: string, owner: string, options: ReadOptions = {}): Promise<JettonWalletRead> {
      let resolved: Resolved | JettonWalletRead;
      try {
        const pinned = { ...options, at: options.at ?? await source.head(options) };
        resolved = await resolve(root, Address.parse(owner), pinned);
        if ('status' in resolved) return resolved;
        try { return await decode(resolved, await source.getAccountState(resolved.wallet, pinned), pinned); }
        catch (error) { return unavailable(resolved.root, resolved.wallet, reason(error)); }
      } catch (error) { return unavailable(root, null, reason(error)); }
    },
    async wallets(rootInputs: string[], ownerInput: string, options: ReadOptions = {}) {
      const head = options.at ?? await source.head(options), pinned = { ...options, at: head };
      const owner = Address.parse(ownerInput), ownerRaw = owner.toRawString();
      const resolved = await Promise.all(rootInputs.map(root => resolve(root, owner, pinned)));
      const targets = resolved.filter((row): row is Resolved => !('status' in row));
      let ownerState: AccountStateResponse;
      let states: Array<AccountStateResponse | Error>;
      try {
        const calls = [ownerRaw, ...targets.map(row => row.wallet)].map(address => ({ kind: 'account' as const, address }));
        const batch = await source.read(calls, pinned);
        if ((['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex', 'utime'] as const).some(key => batch.head[key] !== head[key])
          || batch.results.length !== calls.length)
          throw new ChainReadError('upstream_unavailable');
        const accounts = batch.results.map((row, index) => {
          if (row.kind !== 'account' || row.address !== calls[index].address) throw new ChainReadError('upstream_unavailable');
          return row.state;
        });
        [ownerState, ...states] = accounts;
      } catch {
        // ChainSource batches are all-or-nothing. On failure isolate the wallet
        // reads at the same head and signal; never turn an unread wallet into 0.
        const [account, ...wallets] = await Promise.allSettled([source.getAccountState(ownerRaw, pinned),
          ...targets.map(row => source.getAccountState(row.wallet, pinned))]);
        if (account.status === 'rejected') throw account.reason;
        ownerState = account.value;
        states = wallets.map(row => row.status === 'fulfilled' ? row.value
          : row.reason instanceof Error ? row.reason : new ChainReadError('upstream_unavailable'));
      }
      let index = 0;
      const rows = await Promise.all(resolved.map(row => {
        if ('status' in row) return row;
        const state = states[index++];
        return state instanceof Error ? unavailable(row.root, row.wallet, reason(state)) : decode(row, state, pinned);
      }));
      return { head, owner: ownerState, rows };
    },
    async metadata(root: string, options: ReadOptions = {}): Promise<JettonMetadata | null> {
      try {
        const result = await source.runGetMethod(root, 'get_jetton_data', [], options);
        const data = isSuccessfulGetterResult(result) ? parseCanonicalJettonRootData(result.stack) : null;
        return data ? parseJettonMetadata(data.content) : null;
      } catch { return null; }
    },
  };
}
