import { Address, beginCell, Cell } from '@ton/core';
import { decodeOrderState } from '../orders/state';
import { t3Attempt, t3PathRoot, t3SameRequest } from './currentT3Wire';
import { currentT3ActiveState, decodeSpotTokenTransfer, readT3WalletStorage, verifySpotMessageLink, verifySpotWalletDelta, type CurrentDlmmWallet, type CurrentT3Transaction as Tx, type SpotProofBinding } from './currentDlmmPhysical';

const one = <T>(items: T[]) => items.length === 1 ? items[0] : null;
const maybe = <T>(f: () => T) => { try { return f(); } catch { return null; } };
function need(value: unknown, detail: string): asserts value { if (!value) throw Error(`Current Order recovery: ${detail}`); }
function input(t: Tx, sender?: string) {
  const m = t.tx.inMessage;
  need(m?.info.type === 'internal' && !m.info.bounced && (!sender || m.info.src.toRawString() === sender), 'original input');
  return m;
}
function record(cell: Cell) {
  need(!cell.isExotic, 'ordinary record');
  const s = cell.beginParse(), failed = s.loadBit(), cancelled = s.loadBit(), attempt = t3Attempt(s.loadRef()); s.endParse();
  return { failed, cancelled, attempt };
}
const recordCell = (attempt: Cell, failed: boolean) => beginCell().storeBit(failed).storeBit(false).storeRef(attempt).endCell();
function failureRoot(index: bigint, evidence: Cell, proof: Cell) {
  let hash = beginCell().storeUint(1, 8).storeRef(evidence).endCell().hash(), tail: Cell | null = proof;
  for (let bit = 0; bit < 64; bit++) {
    need(tail && !tail.isExotic, 'failure witness path');
    const s = tail.beginParse(), sibling = s.loadBuffer(32);
    hash = beginCell().storeUint(2, 8).storeBuffer((index >> BigInt(bit)) & 1n ? sibling : hash).storeBuffer((index >> BigInt(bit)) & 1n ? hash : sibling).endCell().hash();
    tail = s.loadMaybeRef(); s.endParse(); need((tail === null) === (bit === 63), 'failure witness length');
  }
  return BigInt('0x' + hash.toString('hex'));
}
function delivery(t: Tx, destination: string) {
  return one(t.tx.outMessages.values().flatMap(m => {
    const a = maybe(() => {
      need(m.info.type === 'internal' && !m.info.bounced && m.info.src.toRawString() === t.account && m.info.dest.toRawString() === destination, 'delivery address');
      const s = m.body.beginParse(); need(s.loadUint(32) === 0x5433444c, 'delivery opcode');
      const a = t3Attempt(s.loadRef()); s.endParse(); return { attempt: a, body: m.body };
    }); return a ? [a] : [];
  }));
}
function bounceAttempt(t: Tx, sender: string) {
  const m = t.tx.inMessage;
  need(m?.info.type === 'internal' && m.info.bounced && m.info.src.toRawString() === sender && !m.body.isExotic, 'original rich bounce');
  const s = m.body.beginParse(); need(s.loadUint(32) === 0xfffffffe, 'rich bounce envelope');
  const original = s.loadRef(), info = s.loadRef().beginParse(); info.loadCoins(); if (info.loadBit()) info.loadRef(); info.loadUintBig(64); info.loadUint(32); info.endParse();
  s.loadUint(8); s.loadInt(32); if (s.loadBit()) { s.loadUint(32); s.loadUint(32); } s.endParse();
  const body = original.beginParse(); need(body.loadUint(32) === 0x5433444c, 'failed delivery'); const a = t3Attempt(body.loadRef()); body.endParse(); return a;
}
/** Recover only the exact original debit. Neither a failed membership witness,
 * nor an accepted owner command, nor a retry dispatch is a physical credit. */
export function recoverCurrentOrderInput(source: Tx, request: ReturnType<typeof decodeSpotTokenTransfer>, from: CurrentDlmmWallet,
  to: CurrentDlmmWallet, b: SpotProofBinding, txs: Tx[], identity: { order: string; owner: string; factory: string; nonce: string; terms: Cell }) {
  if (from.root !== b.identity.t3.root) return null;
  const originalDestination = request.owner === b.identity.pool ? b.wallets.poolPay : to;
  const initial = delivery(source, originalDestination.address); need(initial, 'original delivery');
  const a0 = initial.attempt, payload = a0.forwardPayload.beginParse(), referenced = payload.loadBit(), content = referenced ? payload.loadRef() : beginCell().storeSlice(payload).endCell(); if (referenced) payload.endParse();
  need(a0.originLt === source.tx.lt && a0.attempt === 0n && !a0.burn && a0.owner === from.owner && a0.recipient === request.owner
    && a0.amount === request.amount && a0.queryId === request.query && a0.response === request.response && a0.forwardValue === request.forwardValue
    && !a0.customPayload && !request.custom && content.equals(request.payload), 'original transfer terms');
  verifySpotWalletDelta(source, from, -request.amount, b);
  const state = (t: Tx, after: boolean) => { verifySpotWalletDelta(t, from, 0n, b); return readT3WalletStorage(currentT3ActiveState(after ? t.after : t.before, from.codeHash).data); };
  const closed = (t: Tx, after: boolean) => {
    const s = decodeOrderState(currentT3ActiveState(after ? t.after : t.before, b.identity.release.templates.SpotOrder).data);
    need(s.state === 3 && s.owner.toRawString() === identity.owner && s.factory.toRawString() === identity.factory && String(s.nonce) === identity.nonce && s.termsCell?.equals(identity.terms), 'exact closed order');
  };
  const attempts = new Map<bigint, { tx: Tx; attempt: ReturnType<typeof t3Attempt>; destination: string; evidenceHashes: string[] }>([[0n, { tx: source, attempt: a0, destination: originalDestination.address, evidenceHashes: [source.hash] }]]);
  const credits: Array<{ credit: Tx; evidenceHashes: string[] }> = [];
  for (const retry of txs.filter(t => t.account === from.address && t.succeeded && t.tx.lt > source.tx.lt)) {
    const found = maybe(() => {
      const s = input(retry, identity.order).body.beginParse(); need(s.loadUint(32) === 0x54335759, 'retry opcode');
      const cell = s.loadRef(), proof = s.loadRef(), recipient = s.loadAddress(); s.endParse();
      const r = record(cell), a = r.attempt, previous = attempts.get(a.attempt);
      need(previous && previous.attempt.cell.equals(a.cell) && r.failed && !r.cancelled && recipient.toRawString() === identity.owner
        && t3SameRequest(a0, a) && a.attempt < (1n << 64n) - 1n, 'exact original failed attempt');
      const before = state(retry, false), after = state(retry, true);
      need(a.id < before.count && before.count === after.count && before.failureCount === after.failureCount && before.failureRoot === after.failureRoot
        && t3PathRoot(a.id, cell, proof) === before.root, 'current failed membership');
      const sent = delivery(retry, to.address); need(sent, 'retry output'); const next = sent.attempt;
      need(t3SameRequest(a, next) && next.attempt === a.attempt + 1n && next.recipient === identity.owner
        && t3PathRoot(a.id, recordCell(next.cell, false), proof) === after.root, 'exact retry replacement');
      const authority = one(txs.filter(t => t.account === identity.order && t.succeeded && verifySpotMessageLink(t, retry) && maybe(() => {
        closed(t, false); closed(t, true);
        const body = input(t, identity.owner).body, q = body.beginParse(); need(q.loadUint(32) === 0x4f574452, 'owner OWDR'); q.loadUintBig(64);
        need(q.loadAddress().toRawString() === from.address && q.loadCoins() === 0n, 'owner recovery wallet'); const recovery = q.loadMaybeRef(); q.endParse();
        need(recovery?.equals(beginCell().storeRef(cell).storeRef(proof).endCell()), 'exact owner witness'); return true;
      }) === true)); need(authority, 'closed owner authority');
      const dispatch = one(txs.filter(t => t.account === identity.owner && t.succeeded && verifySpotMessageLink(t, authority))); need(dispatch, 'original owner dispatch');
      const marks = txs.flatMap(mark => {
        const match = maybe(() => {
          need(mark.account === from.address && mark.succeeded && mark.tx.lt > previous.tx.tx.lt && mark.tx.lt < retry.tx.lt, 'mark interval');
          const m = input(mark).body.beginParse(); need(m.loadUint(32) === 0x5433574b, 'mark opcode');
          const prior = m.loadRef(), path = m.loadRef(), index = m.loadUintBig(64), witness = m.loadRef(); m.endParse();
          need(prior.equals(recordCell(a.cell, false)), 'exact original unmarked record');
          const left = state(mark, false), right = state(mark, true), evidence = beginCell().storeAddress(Address.parse(from.address)).storeRef(a.cell).endCell();
          need(a.id < left.count && left.count === right.count && left.failureCount === right.failureCount && left.failureRoot === right.failureRoot
            && index < left.failureCount && failureRoot(index, evidence, witness) === left.failureRoot
            && t3PathRoot(a.id, prior, path) === left.root && t3PathRoot(a.id, cell, path) === right.root, 'mark current failure and replacement');
          const failed = one(txs.filter(t => t.account === previous.destination && !t.succeeded && verifySpotMessageLink(previous.tx, t))); need(failed, 'original failed recipient');
          const bounced = one(txs.filter(t => t.account === from.address && t.succeeded && t.tx.lt < mark.tx.lt && verifySpotMessageLink(failed, t)
            && maybe(() => bounceAttempt(t, previous.destination).cell.equals(a.cell)) === true)); need(bounced, 'original failed delivery bounce');
          state(bounced, false); state(bounced, true);
          return [mark.hash, failed.hash, bounced.hash];
        }); return match ? [match] : [];
      }); need(marks.length === 1, 'unique original failure mark');
      const evidenceHashes = [...previous.evidenceHashes, ...marks[0], dispatch.hash, authority.hash, retry.hash];
      attempts.set(next.attempt, { tx: retry, attempt: next, destination: to.address, evidenceHashes });
      const paid = txs.filter(t => t.account === to.address && verifySpotMessageLink(retry, t) && maybe(() => {
        const m = input(t, from.address).body.beginParse(); need(m.loadUint(32) === 0x5433444c && m.loadRef().equals(next.cell), 'exact retry credit'); m.endParse();
        verifySpotWalletDelta(t, to, request.amount, b); return true;
      }) === true); need(paid.length <= 1, 'unique retry credit');
      return paid.map(credit => ({ credit, evidenceHashes: [...evidenceHashes, credit.hash] }));
    }); if (found) credits.push(...found);
  }
  need(credits.length <= 1, 'duplicate recovered credit'); return credits[0] ?? null;
}
