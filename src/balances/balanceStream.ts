import { Address } from '@ton/core';
import type { ChainHead } from '../data/dataSource';
import type { HeadFeed } from '../runtime/headFeed';
import { balanceHeadKey, type BalanceService, type BalanceSnapshot } from './balanceService';

export type BalanceStreamEvent =
  | { type: 'balances_snapshot'; address: string; seq: number; ts: number; balances: BalanceSnapshot }
  | { type: 'balances_changed'; address: string; seq: number; ts: number; hints: { ton: boolean; jettons: string[] | null } };
type Sink = (event: BalanceStreamEvent) => void;
type Subscription = { owners: string[]; sink: Sink; seen: Set<string>; seq: number; closed: boolean };
type Owner = { address: string; subscribers: Set<Subscription>; verified: Map<string, string>; last?: BalanceSnapshot;
  lastHead?: string; readingHead?: string; wanted?: ChainHead; running: boolean; controller?: AbortController };

/** All connections share an owner refresh. Unavailable rows never erase verified values. */
export class BalanceStreamHub {
  private readonly owners = new Map<string, Owner>();
  private readonly subscriptions = new Set<Subscription>();
  private head: ChainHead | null = null;
  private unsubscribeHead?: () => void;
  private active = 0;
  private closed = false;
  constructor(private readonly options: { service: Pick<BalanceService, 'read'>; heads: HeadFeed }) {}
  subscribe(ownerInputs: readonly string[], sink: Sink): () => void {
    if (this.closed) throw new Error('Balance stream is closed.');
    const addresses = [...new Set(ownerInputs.map(owner => Address.parse(owner).toRawString()))];
    const subscription: Subscription = { owners: addresses, sink, seen: new Set(), seq: 0, closed: false };
    this.subscriptions.add(subscription);
    for (const address of addresses) {
      let owner = this.owners.get(address);
      if (!owner) { owner = { address, subscribers: new Set(), verified: new Map(), running: false }; this.owners.set(address, owner); }
      owner.subscribers.add(subscription);
      if (this.head && owner.last && owner.lastHead === balanceHeadKey(this.head)) this.snapshot(subscription, owner.last);
      else if (this.head && owner.readingHead !== balanceHeadKey(this.head)) owner.wanted = this.head;
    }
    if (!this.unsubscribeHead) {
      this.unsubscribeHead = this.options.heads.subscribe(head => this.onHead(head));
      const current = this.options.heads.current();
      if (current) this.onHead(current);
    }
    this.pump();
    return () => this.unsubscribe(subscription);
  }
  close(): void {
    this.closed = true;
    for (const subscription of [...this.subscriptions]) this.unsubscribe(subscription);
  }
  private unsubscribe(subscription: Subscription) {
    if (subscription.closed) return;
    subscription.closed = true; this.subscriptions.delete(subscription);
    for (const address of subscription.owners) {
      const owner = this.owners.get(address);
      if (!owner) continue;
      owner.subscribers.delete(subscription);
      if (!owner.subscribers.size) { this.owners.delete(address); owner.controller?.abort(); }
    }
    if (!this.subscriptions.size) { this.unsubscribeHead?.(); this.unsubscribeHead = undefined; this.head = null; }
  }
  private onHead(head: ChainHead) {
    if (this.closed || this.head && (head.seqno < this.head.seqno || balanceHeadKey(head) === balanceHeadKey(this.head))) return;
    this.head = head;
    // If an owner is still being read, retain only the newest requested boundary.
    for (const owner of this.owners.values()) owner.wanted = head;
    this.pump();
  }
  private pump() {
    if (this.closed) return;
    for (const owner of [...this.owners.values()]) {
      if (this.active >= 8) break;
      if (owner.running || !owner.wanted) continue;
      const head = owner.wanted; owner.wanted = undefined;
      owner.readingHead = balanceHeadKey(head);
      this.owners.delete(owner.address); this.owners.set(owner.address, owner);
      owner.running = true; owner.controller = new AbortController(); this.active++;
      void this.options.service.read(owner.address, { at: head, signal: owner.controller.signal }).then(result => {
        if (this.closed || this.owners.get(owner.address) !== owner || owner.controller!.signal.aborted) return;
        const changed: string[] = [];
        for (const row of result.assets) {
          if (row.status === 'unavailable') continue;
          const key = row.kind === 'native' ? 'native' : row.root;
          if (owner.verified.get(key) !== row.balance_raw) changed.push(key);
          owner.verified.set(key, row.balance_raw);
        }
        owner.last = result; owner.lastHead = balanceHeadKey(head);
        for (const subscription of owner.subscribers) {
          const initial = !subscription.seen.has(owner.address);
          if (!initial && changed.length) this.emit(subscription, { type: 'balances_changed', address: owner.address,
            hints: { ton: changed.includes('native'), jettons: changed.filter(key => key !== 'native').length ? changed.filter(key => key !== 'native') : null } });
          if (initial || changed.length) this.snapshot(subscription, result);
        }
      }).catch(() => { /* A failed read cannot establish a new balance or an empty snapshot. */ }).finally(() => {
        owner.running = false; owner.controller = undefined; this.active--; this.pump();
      });
    }
  }
  private snapshot(subscription: Subscription, balances: BalanceSnapshot) {
    subscription.seen.add(balances.address);
    this.emit(subscription, { type: 'balances_snapshot', address: balances.address, balances: structuredClone(balances) });
  }
  private emit(subscription: Subscription, event: Omit<Extract<BalanceStreamEvent, {type:'balances_snapshot'}>, 'seq' | 'ts'> |
    Omit<Extract<BalanceStreamEvent, {type:'balances_changed'}>, 'seq' | 'ts'>) {
    if (subscription.closed) return;
    try { subscription.sink({ ...event, seq: ++subscription.seq, ts: Date.now() }); } catch { /* One disconnected sink cannot interrupt another connection. */ }
  }
}
