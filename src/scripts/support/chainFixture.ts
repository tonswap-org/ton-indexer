import { Address, beginCell, Dictionary, type TupleItem } from '@ton/core';
import { createHash } from 'node:crypto';
import { ChainReadError, type ChainHead, type ChainSource } from '../../data/dataSource';
import type { JettonMetadata } from '../../models';
import { fakeChainSource } from './fakeChainSource';

export type FixtureGetter = (address: string, method: string, args?: TupleItem[], options?: Parameters<ChainSource['runGetMethod']>[3]) => Promise<{ exitCode: number; stack: TupleItem[] } | null>;
type WalletBalance = (owner: string, root: string) => Promise<{ wallet: string; balance: string } | null>;
export type ChainFixtureOptions = Omit<Partial<ChainSource>, 'head' | 'runGetMethod'> & {
  physicalCurrentReads?: boolean;
  head?: () => Promise<{ seqno: number; utime?: number }>;
  runGetMethod?: FixtureGetter;
  walletBalance?: WalletBalance;
  jettonMetadata?: (root: string) => Promise<JettonMetadata | null>;
};
export type FixtureChainSource = ChainSource & Pick<Required<ChainFixtureOptions>, 'walletBalance' | 'jettonMetadata'>;
export const fixtureHead = (seqno = 1, utime = 1_700_000_000): ChainHead => ({
  workchain: -1, shard: '-9223372036854775808', seqno, utime,
  rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64),
});
const code = beginCell().storeUint(0x74657374, 32).endCell();
const addressItem = (address: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(address)).endCell() });
function content(metadata: JettonMetadata) {
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  for (const [key, value] of Object.entries(metadata)) if (value !== undefined)
    dict.set(createHash('sha256').update(key).digest(), beginCell().storeUint(0, 8).storeStringTail(String(value)).endCell());
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

/** Domain fixtures explicitly model the previously assumed qualified wallet.
 * By default only pinned reader calls receive synthetic current root/wallet state.
 * physicalCurrentReads explicitly preserves original physical account pointers
 * for owner-cycle fixtures whose every current read is pinned. Original
 * account histories, archived cells and physical transaction fixtures pass through
 * unchanged; this helper never supplies historical evidence or proof authority.
 * Real wallet qualification and rejection cases use fakeChainSource directly. */
export function fixtureChainSource(options: ChainFixtureOptions = {}): FixtureChainSource {
  const walletBalance = options.walletBalance ?? (async () => null);
  const jettonMetadata = options.jettonMetadata ?? (async () => null);
  const wallets = new Map<string, { owner: string; root: string; row: { wallet: string; balance: string }; consumed: boolean }>();
  const roots = new Set<string>();
  const raw = fakeChainSource();
  const source = fakeChainSource({ ...options,
    async head() { const head = await options.head?.(); return fixtureHead(head?.seqno, head?.utime); },
    async read(calls, readOptions) {
      if (options.read) return options.read(calls, readOptions);
      const boundary = readOptions?.at ?? await source.head();
      return { head: boundary, results: await Promise.all(calls.map(async call => call.kind === 'account'
        ? { kind: 'account' as const, address: call.address, state: await source.getAccountState(call.address, { ...readOptions, at: boundary }) }
        : { kind: 'getter' as const, address: call.address, ...await source.runGetMethod(call.address, call.method, call.args, { ...readOptions, at: boundary }) })) };
    },
    async getAccountState(address, readOptions) {
      const original = options.getAccountState && (options.physicalCurrentReads || !options.walletBalance || !readOptions?.at)
        ? await options.getAccountState(address, readOptions) : undefined;
      if (options.walletBalance && readOptions?.at) {
        const wallet = wallets.get(address);
        if (wallet || roots.has(address)) {
          if (wallet?.consumed) {
            const row = await walletBalance(wallet.owner, wallet.root);
            if (!row || Address.parse(row.wallet).toRawString() !== address) throw new ChainReadError('upstream_unavailable');
            wallet.row = row; wallet.consumed = false;
          }
          return { balance: '0', accountState: 'active', ...original, codeBoc: code.toBoc().toString('base64'),
            lastTxLt: original?.lastTxLt ?? '1', lastTxHash: original?.lastTxHash ?? '1'.repeat(64) };
        }
        // Root qualification invokes account and getter concurrently.
        if (!original) return { balance: '0', accountState: 'active', codeBoc: code.toBoc().toString('base64') };
        return { ...original, accountState: original.accountState ?? (original.lastTxLt ? 'active' : 'uninitialized'), codeBoc: original.codeBoc ?? code.toBoc().toString('base64') };
      }
      const state = original ?? await raw.getAccountState(address, readOptions);
      return options.physicalCurrentReads ? { ...state, accountState: state.accountState ?? (state.lastTxLt ? 'active' : 'uninitialized') } : state;
    },
    async runGetMethod(address, method, args, readOptions) {
      if (options.walletBalance && readOptions?.at) {
        if (method === 'get_jetton_data') {
          roots.add(address);
          return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n },
            { type: 'null' }, { type: 'cell', cell: content(options.physicalCurrentReads ? await jettonMetadata(address) ?? {} : {}) }, { type: 'cell', cell: code }] };
        }
        if (method === 'get_wallet_address') {
          const arg = args?.[0];
          if (!arg || !('cell' in arg)) throw new ChainReadError('upstream_unavailable');
          const owner = arg.cell.beginParse().loadAddress().toRawString();
          const row = await walletBalance(owner, address);
          if (!row) throw new ChainReadError('upstream_unavailable');
          wallets.set(Address.parse(row.wallet).toRawString(), { owner, root: address, row, consumed: false });
          return { exitCode: 0, stack: [addressItem(row.wallet)] };
        }
        const wallet = wallets.get(address);
        if (method === 'get_wallet_data' && wallet) {
          wallet.consumed = true;
          return { exitCode: 0, stack: [{ type: 'int', value: BigInt(wallet.row.balance) },
            addressItem(wallet.owner), addressItem(wallet.root), { type: 'cell', cell: code }] };
        }
      }
      if (method === 'get_jetton_data' && options.jettonMetadata && !readOptions?.at) {
        const metadata = await jettonMetadata(address);
        if (!metadata) throw new ChainReadError('upstream_unavailable');
        return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n },
          { type: 'null' }, { type: 'cell', cell: content(metadata) }, { type: 'cell', cell: code }] };
      }
      const result = await (options.runGetMethod ?? raw.runGetMethod)(address, method, args, readOptions);
      if (!result) throw new ChainReadError('upstream_unavailable');
      return result;
    },
  });
  return Object.assign(source, { walletBalance, jettonMetadata });
}
