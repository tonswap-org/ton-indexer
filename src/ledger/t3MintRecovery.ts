import { Cell } from '@ton/core';
import type { ProjectionInput, Node } from './project';
import type { LedgerT3Hub } from './t3';
import type { LedgerMovement } from './types';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, tokenWire, NOTIFY } from './wire';
import { decodeNativeFundingBounce, decodeNativeFundingBody } from './nativeFunding';
import { mintReceipt, mintRequest, mintRetry, mintStart, mintFinalize, depositNote, MINT_FINALIZED } from './t3Wire';
import { readT3MintState, sameT3MintTerms, t3MintKey, type T3MintJournal } from './t3MintState';

type State = ReturnType<typeof readT3MintState>;
type Boundary = { before: State; after: State;
  evidence: Omit<LedgerMovement['evidence'], 'transactionStatus'> & { kind: 't3_mint' } };
const address = (value?: string) => {
  try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; }
};
const ok = (n: Node) => n.raw.success && (!n.raw.status || n.raw.status === 'success') && !n.raw.inMessage?.bounced;
const sameBacking = (a: State, b: State) => a.totalSupply === b.totalSupply &&
  a.balances.every((v, i) => v === b.balances[i]) && a.fees.equals(b.fees) && a.nextVaultQueryId === b.nextVaultQueryId &&
  a.activePayoutSet === b.activePayoutSet && a.activePayoutId === b.activePayoutId;
const sameFailuresExcept = (a: State, b: State, key: bigint) =>
  [...a.failed].filter(([id]) => id !== key).length === [...b.failed].filter(([id]) => id !== key).length &&
  [...a.failed].every(([id, journal]) => id === key || journal.cell.equals(b.failed.get(id)?.cell ?? Cell.EMPTY));

/** Authenticate every wire rotation back to the unique original funded admission.
 * Query/basket coincidence or a current getter alone never supplies provenance. */
export async function recoverParkedT3Mint(args: {
  input: ProjectionInput; hub: LedgerT3Hub; nodes: Node[]; retry: Node; receipt: Cell;
  rootQueryId: string; receiptFor: (n: Node, i: number) => Node | null;
}) {
  const { input, hub, nodes, retry, receipt, receiptFor } = args;
  const request = mintRetry(retry.raw.inMessage), business = mintReceipt({ body: receipt.toBoc().toString('base64') });
  if (!request || !business || request.owner !== input.owner || request.queryId !== business.queryId ||
    business.recipient !== input.owner || business.amountRaw === '0') return null;
  const key = t3MintKey(request.owner, request.queryId), cache = new Map<string, Promise<Boundary | null>>();
  const boundary = (n: Node) => {
    let cached = cache.get(n.id);
    if (!cached) {
      cached = (async (): Promise<Boundary | null> => {
        try {
          if (!n.raw.prevTransactionLt || !n.raw.prevTransactionHash ||
            !/^[1-9][0-9]*$/.test(n.raw.prevTransactionLt) || !/^[1-9][0-9]*$/.test(n.raw.lt) ||
            BigInt(n.raw.prevTransactionLt) >= BigInt(n.raw.lt)) return null;
          const b = await input.stateAt(hub.address, n.raw.prevTransactionLt, n.raw.prevTransactionHash),
            a = await input.stateAt(hub.address, n.raw.lt, n.raw.hash);
          const matches = (snapshot: typeof b, lt: string, hash: string) => Boolean(snapshot &&
            Number.isSafeInteger(snapshot.seqno) && snapshot.seqno >= 0 && snapshot.state.accountState === 'active' &&
            snapshot.state.lastTxLt === lt && snapshot.state.lastTxHash &&
            canonicalLedgerHash(snapshot.state.lastTxHash) === canonicalLedgerHash(hash) &&
            snapshot.state.codeBoc && Cell.fromBase64(snapshot.state.codeBoc).hash().toString('hex') === hub.codeHash);
          if (!b?.state.dataBoc || !a?.state.dataBoc || !matches(b, n.raw.prevTransactionLt, n.raw.prevTransactionHash) ||
            !matches(a, n.raw.lt, n.raw.hash) || b.seqno > a.seqno) return null;
          const before = readT3MintState(b.state.dataBoc), after = readT3MintState(a.state.dataBoc);
          if (before.root !== hub.root || after.root !== hub.root) return null;
          return { before, after, evidence: { kind: 't3_mint', stateBeforeHash: before.dataHash,
            stateAfterHash: after.dataHash, beforeSeqno: b.seqno, afterSeqno: a.seqno,
            transactions: [{ account: hub.address, lt: n.raw.lt, hash: canonicalLedgerHash(n.raw.hash), utime: n.raw.utime }] } };
        } catch { return null; }
      })();
      cache.set(n.id, cached);
    }
    return cached;
  };
  const starts = (n: Node, journal: T3MintJournal) => n.raw.outMessages.flatMap((message, index) => {
    const start = mintStart(message);
    return address(message.source) === hub.address && address(message.destination) === hub.root && start &&
      start.queryId === journal.rootQueryId && start.amountRaw === journal.amountRaw &&
      start.recipient === journal.recipient && start.response === hub.address && start.forwardTonRaw === '0' &&
      start.forward.equals(Cell.EMPTY) ? [{ index, message }] : [];
  });
  const rotated = (n: Node, s: Boundary, terms: T3MintJournal) => {
    const wire = mintRetry(n.raw.inMessage), failed = s.before.failed.get(key), live = s.after.live;
    return ok(n) && wire?.owner === request.owner && wire.queryId === request.queryId && failed &&
      sameT3MintTerms(failed, terms) && sameT3MintTerms(live, terms) && live.status === 1 &&
      live.requestHash === 0n && live.controlBudget === 360_000_000n && [0, 4].includes(s.before.live.status) &&
      !s.after.failed.has(key) && sameFailuresExcept(s.before, s.after, key) && sameBacking(s.before, s.after) &&
      BigInt(live.rootQueryId) === s.before.nextRootQueryId && s.after.nextRootQueryId === s.before.nextRootQueryId + 1n &&
      starts(n, live).length === 1;
  };
  const current = await boundary(retry), terms = current?.before.failed.get(key);
  if (!current || !terms || !terms.receipt.equals(receipt) ||
    terms.amountRaw !== business.amountRaw || terms.recipient !== input.owner || terms.owner !== input.owner ||
    current.after.live.rootQueryId !== args.rootQueryId || !rotated(retry, current, terms)) return null;
  const history = nodes.filter(n => n.account === hub.address && BigInt(n.raw.lt) < BigInt(retry.raw.lt))
    .sort((a, b) => BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1);
  const origins: Array<{ node: Node; state: Boundary }> = [];
  for (const n of history.filter(ok)) {
    const direct = tokenWire(n.raw.inMessage), note = direct ? depositNote(direct.forward) : null,
      manual = mintRequest(n.raw.inMessage);
    const funded = direct?.op === NOTIFY && direct.owner === input.owner && direct.amountRaw !== '0' &&
      direct.queryId === request.queryId && note?.kind === 1 && note.flags === 1 &&
      (note.recipient === null || note.recipient === input.owner) && hub.vaults.includes(address(n.raw.inMessage?.source) ?? '');
    const staged = manual?.queryId === request.queryId && manual.recipient === input.owner &&
      address(n.raw.inMessage?.source) === input.owner;
    if (!funded && !staged) continue;
    const s = await boundary(n), live = s?.after.live;
    if (!s || !live || s.before.failed.has(key) || s.before.completed.has(key) ||
      (s.before.live.status !== 0 && s.before.live.owner === request.owner && s.before.live.queryId === request.queryId) ||
      !sameT3MintTerms(live, terms) || live.status !== 1 || live.requestHash !== 0n || live.controlBudget !== 360_000_000n ||
      BigInt(live.rootQueryId) !== s.before.nextRootQueryId || s.after.nextRootQueryId !== s.before.nextRootQueryId + 1n ||
      starts(n, live).length !== 1) continue;
    origins.push({ node: n, state: s });
  }
  if (origins.length !== 1) return null;
  const origin = origins[0], attempts: Node[] = [origin.node];
  let lastWire = origin.state.after.live.rootQueryId, parked = false;
  for (const n of history.filter(n => BigInt(n.raw.lt) > BigInt(origin.node.raw.lt))) {
    const incoming = mintRetry(n.raw.inMessage), isRetry = incoming?.owner === request.owner && incoming.queryId === request.queryId;
    const fromRoot = address(n.raw.inMessage?.source) === hub.root;
    if (!isRetry && !fromRoot) continue;
    const s = await boundary(n);
    if (isRetry) {
      try {
        const body = bodyCell(n.raw.inMessage), funding = body ? decodeNativeFundingBody(body).funding : null;
        const sponsorMatches = funding
          ? funding.refundTo === terms.funding.refundTo && funding.refundKind === terms.funding.refundKind &&
            funding.moduleId === terms.funding.moduleId
          : address(n.raw.inMessage?.source) === terms.funding.refundTo && terms.funding.refundKind === 0 && terms.funding.moduleId === 0;
        if (sponsorMatches) attempts.push(n);
      } catch { /* Malformed sponsorship never attributes another party's fees. */ }
    }
    // Unrelated Root callbacks must not require irrelevant archives.
    let failureWire: string | null = null;
    let failureKind: 'refusal' | 'finalized' | null = null;
    let failureHash = 0n;
    if (fromRoot) {
      if (n.raw.inMessage?.bounced) {
        try {
          const bounced = decodeNativeFundingBounce(Cell.fromBase64(n.raw.inMessage.body!)),
            start = mintStart({ body: bounced.businessBody.toBoc().toString('base64') });
          if (start?.amountRaw === terms.amountRaw && start.recipient === terms.recipient && start.response === hub.address &&
            bounced.funding!.correlationId === start.queryId && bounced.funding!.refundTo === terms.funding.refundTo &&
            bounced.funding!.refundKind === terms.funding.refundKind && bounced.funding!.moduleId === terms.funding.moduleId)
            { failureWire = start.queryId; failureKind = 'refusal'; }
        } catch { /* An unsupported bounce never supplies failure proof. */ }
      } else {
        const final = mintFinalize(n.raw.inMessage, MINT_FINALIZED);
        try {
          const body = bodyCell(n.raw.inMessage), funding = body ? decodeNativeFundingBody(body).funding : null;
          if (final?.amountRaw === terms.amountRaw && final.recipient === terms.recipient && funding &&
            funding.correlationId === final.queryId && funding.refundTo === terms.funding.refundTo &&
            funding.refundKind === terms.funding.refundKind && funding.moduleId === terms.funding.moduleId) {
            failureWire = final.queryId; failureKind = 'finalized'; failureHash = BigInt('0x' + final.requestHash);
          }
        } catch { /* A mismatched envelope is not authenticated finality. */ }
      }
    }
    if (failureWire === lastWire) {
      const retained = s?.after.failed.get(key);
      if (s && parked && s.before.dataHash === s.after.dataHash && retained &&
        retained.rootQueryId === lastWire && sameT3MintTerms(retained, terms) &&
        (failureKind === 'refusal' ? retained.requestHash === 0n : retained.requestHash === failureHash && failureHash > 0n)) {
        attempts.push(n);
        continue;
      }
      const validTrigger = s && retained && (failureKind === 'refusal'
        ? s.before.live.status === 1 && s.before.live.requestHash === 0n && s.before.live.controlBudget === 360_000_000n && retained.requestHash === 0n
        : s.before.live.status === 5 && s.before.live.requestHash === failureHash && failureHash > 0n &&
          s.before.live.controlBudget === 20_000_000n && retained.requestHash === failureHash);
      if (!s || !n.raw.success || !retained || s.before.failed.has(key) || !sameT3MintTerms(s.before.live, terms) ||
        !sameT3MintTerms(retained, terms) || s.before.live.rootQueryId !== lastWire || retained.rootQueryId !== lastWire ||
        !validTrigger || s.after.live.status !== 0 ||
        !sameBacking(s.before, s.after) || s.before.nextRootQueryId !== s.after.nextRootQueryId ||
        !sameFailuresExcept(s.before, s.after, key)) return null;
      parked = true; attempts.push(n);
    } else if (isRetry && s?.after.live.rootQueryId !== s?.before.live.rootQueryId) {
      if (!s || !parked || s.before.failed.get(key)?.rootQueryId !== lastWire || !rotated(n, s, terms)) return null;
      lastWire = s.after.live.rootQueryId; parked = false; attempts.push(n);
    }
  }
  if (!parked || lastWire !== terms.rootQueryId) return null;
  attempts.push(retry);
  // Include physical fees from every failed and successful wire. A missing
  // related transaction is a coverage gap, even when the retained claim exists.
  const wallet = [...input.wallets].find(([, a]) => a.master === hub.root && a.owner === input.owner)?.[0];
  if (!wallet) return null;
  const allowed = new Set([hub.address, hub.root, wallet]), visited = new Set<string>(), pending = [...attempts];
  while (pending.length) {
    const n = pending.shift()!;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    for (let index = 0; index < n.raw.outMessages.length; index++) {
      const message = n.raw.outMessages[index];
      if (!allowed.has(address(message.destination) ?? '')) continue;
      const next = receiptFor(n, index);
      if (!next || next.account !== address(message.destination)) return null;
      pending.push(next); attempts.push(next);
    }
  }
  return { origin: origin.node, attempts, evidence: current.evidence };
}
