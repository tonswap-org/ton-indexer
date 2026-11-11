import { Address } from '@ton/core';
import { ChainReadError, type ChainHead, type ReadOptions } from '../data/dataSource';
import type { createJettonWalletReader, JettonWalletRead } from '../data/jettonWallet';
import type { Network } from '../models';

export type BalanceRoot = { master: string; symbol: string; decimals: number };
export type BalanceAsset =
  | { kind: 'native'; symbol: 'GRAM'; status: 'ok'; balance_raw: string; decimals: 9 }
  | { kind: 'jetton'; symbol: string; root: string; wallet: string | null; decimals: number;
      status: 'ok' | 'not_deployed'; balance_raw: string }
  | { kind: 'jetton'; symbol: string; root: string; wallet: string | null; decimals: number;
      status: 'unavailable'; balance_raw: null; reason: Extract<JettonWalletRead, {status:'unavailable'}>['reason'] };
export type BalanceSnapshot = { address: string; network: Network; head_seqno: number; head_utime: number; complete: boolean; assets: BalanceAsset[] };
type Reader = Pick<ReturnType<typeof createJettonWalletReader>, 'wallets'>;
type Flight = { controller: AbortController; users: number; settled: boolean; promise: Promise<BalanceSnapshot> };
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const aborted = (signal: AbortSignal) => signal.reason instanceof ChainReadError ? signal.reason
  : new ChainReadError(signal.reason?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unavailable', { cause: signal.reason });
export const balanceHeadKey = (head: ChainHead): string => JSON.stringify([head.workchain, head.shard, head.seqno, head.rootHashHex, head.fileHashHex, head.utime]);

/** Shares only active reads at the same head. A finished balance is never a cache entry. */
export class BalanceService {
  private readonly roots: BalanceRoot[];
  private readonly flights = new Map<string, Flight>();
  constructor(private readonly options: { reader: Reader; roots: readonly BalanceRoot[]; network: Network }) {
    this.roots = options.roots.map(root => ({ ...root, master: Address.parse(root.master).toRawString() }));
    if (new Set(this.roots.map(root => root.master)).size !== this.roots.length || this.roots.some(root =>
      !root.symbol || !Number.isInteger(root.decimals) || root.decimals < 0 || root.decimals > 255)) throw new TypeError('Invalid release balance roots.');
  }
  read(ownerInput: string, options: ReadOptions = {}): Promise<BalanceSnapshot> {
    if (options.signal?.aborted) return Promise.reject(aborted(options.signal));
    const owner = Address.parse(ownerInput).toRawString();
    const key = JSON.stringify([owner, options.at ? balanceHeadKey(options.at) : null]);
    let flight = this.flights.get(key);
    if (flight?.controller.signal.aborted) { this.flights.delete(key); flight = undefined; }
    if (!flight) {
      const controller = new AbortController();
      const current: Flight = { controller, users: 0, settled: false, promise: undefined! };
      this.flights.set(key, current);
      current.promise = new Promise<BalanceSnapshot>((resolve, reject) => {
        const timer = setTimeout(() => controller.abort(new ChainReadError('upstream_timeout')), 5_000);
        const finish = () => {
          current.settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', cancel);
          if (this.flights.get(key) === current) this.flights.delete(key);
        };
        const cancel = () => { finish(); reject(aborted(controller.signal)); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        void Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return this.load(owner, { at: options.at, signal: controller.signal });
        }).then(value => { if (!current.settled) { finish(); resolve(value); } }, error => { if (!current.settled) { finish(); reject(error); } });
      });
      flight = current;
    }
    return this.consume(flight, options.signal);
  }
  private consume(flight: Flight, signal?: AbortSignal): Promise<BalanceSnapshot> {
    flight.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true; signal?.removeEventListener('abort', cancel); flight.users--;
        if (!flight.users && !flight.settled) flight.controller.abort(new ChainReadError('upstream_unavailable'));
        return true;
      };
      const cancel = () => { if (finish()) reject(aborted(signal!)); };
      signal?.addEventListener('abort', cancel, { once: true });
      flight.promise.then(value => { if (finish()) resolve(structuredClone(value)); }, error => { if (finish()) reject(error); });
      if (signal?.aborted) cancel();
    });
  }
  private async load(owner: string, options: ReadOptions): Promise<BalanceSnapshot> {
    const answer = await this.options.reader.wallets(this.roots.map(root => root.master), owner, options);
    options.signal?.throwIfAborted();
    if (!atomic(answer.owner.balance) || !Number.isSafeInteger(answer.head.seqno) || answer.head.seqno < 0
      || !Number.isSafeInteger(answer.head.utime) || answer.head.utime <= 0
      || options.at && balanceHeadKey(answer.head) !== balanceHeadKey(options.at)) throw new ChainReadError('upstream_unavailable');
    const assets: BalanceAsset[] = [{ kind: 'native', symbol: 'GRAM', status: 'ok', balance_raw: answer.owner.balance, decimals: 9 }];
    this.roots.forEach((root, index) => {
      const row = answer.rows[index];
      const identity = { kind: 'jetton' as const, symbol: root.symbol, root: root.master, decimals: root.decimals };
      if (!row || row.root !== root.master) { assets.push({ ...identity, wallet: null, status: 'unavailable', balance_raw: null, reason: 'upstream' }); return; }
      if (row.status === 'unavailable') assets.push({ ...identity, wallet: row.wallet, status: 'unavailable', balance_raw: null, reason: row.reason });
      else if (!atomic(row.balanceRaw) || row.status === 'not_deployed' && row.balanceRaw !== '0') assets.push({ ...identity, wallet: row.wallet, status: 'unavailable', balance_raw: null, reason: 'upstream' });
      else assets.push({ ...identity, wallet: row.wallet, status: row.status, balance_raw: row.balanceRaw });
    });
    return { address: owner, network: this.options.network, head_seqno: answer.head.seqno, head_utime: answer.head.utime,
      complete: assets.every(row => row.status !== 'unavailable'), assets };
  }
}
