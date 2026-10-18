import { Cell, Dictionary, type DictionaryValue, type Slice } from '@ton/core';

export type GovernanceLock = {
  amountRaw: string; bucket: number; commitUntil: number; prevCommit: number; commitChangedAt: number;
  voteLock: number; proposal: number; proposeAfter: number; voteMask: number; voteStamp: number;
};
export type GovernanceProposal = {
  proposer: string; class: number; queued: boolean; slot: number; start: number; decidedAt: number;
  valueTotalRaw: string; descriptionHash: string;
  tally: { quorumRaw: string; participationRaw: string; yesRaw: string; noRaw: string };
  actions: Cell;
};
const readonly = () => { throw new Error('Governance storage is read-only.'); };
const hash = (value: bigint) => value.toString(16).padStart(64, '0');
const exact = <T>(parse: (slice: Slice) => T): DictionaryValue<T> => ({ serialize: readonly, parse(slice) {
  const result = parse(slice); slice.endParse(); return result;
} });
const locks = exact<GovernanceLock>(s => ({
  amountRaw: s.loadCoins().toString(), bucket: s.loadUint(32), commitUntil: s.loadUint(32),
  prevCommit: s.loadUint(32), commitChangedAt: s.loadUint(32), voteLock: s.loadUint(32),
  proposal: s.loadUint(32), proposeAfter: s.loadUint(32), voteMask: s.loadUint(16), voteStamp: s.loadUint(32),
}));
const proposals = exact<GovernanceProposal>(s => {
  const proposer = s.loadAddress().toRawString(), kind = s.loadUint(2), queued = s.loadBit(), slot = s.loadUint(4),
    start = s.loadUint(32), decidedAt = s.loadUint(32), valueTotalRaw = s.loadCoins().toString(), descriptionHash = hash(s.loadUintBig(256)),
    t = s.loadRef().beginParse();
  const tally = { quorumRaw: t.loadCoins().toString(), participationRaw: t.loadCoins().toString(),
    yesRaw: t.loadUintBig(122).toString(), noRaw: t.loadUintBig(122).toString() };
  t.endParse();
  if (kind > 2 || (kind === 2 ? slot < 8 : slot >= 8)) throw Error('Invalid Governance proposal class/slot.');
  return { proposer, class: kind, queued, slot, start, decidedAt, valueTotalRaw, descriptionHash, tally, actions: s.loadRef() };
});
const coins = exact(s => s.loadCoins());

/** Current GovernanceStorage only. A complete bounded ordinary cell graph is
 * required; omitted dictionaries and pruned branches cannot establish absence. */
export function readGovernanceStorage(cell: Cell) {
  const seen = new Set<Cell>(), pending = [cell];
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (next.isExotic || seen.size > 100_000) throw Error('Incomplete or oversized Governance storage.');
    pending.push(...next.refs);
  }
  const s = cell.beginParse(), phase = s.loadUint(8), bootstrap = s.loadMaybeAddress(), bootstrapDeadline = s.loadUint(32),
    salt = s.loadUintBig(64), handoffBucket = s.loadUint(32), assets = s.loadRef().beginParse();
  const jetton = assets.loadRef(), sweeps = assets.loadRef(), treasury = assets.loadMaybeAddress(); assets.endParse();
  const ts = s.loadBit() ? { merkleClaim: s.loadAddress(), genesisTotal: s.loadUintBig(120), supplyBase: s.loadUintBig(120) } : null;
  const policy = s.loadDict(Dictionary.Keys.BigUint(256), { serialize: readonly, parse: v => v.asCell() });
  const policyCount = s.loadUint(16), st = s.loadRef().beginParse(), pr = s.loadRef().beginParse(); s.endParse();
  const totalLockedRaw = st.loadCoins().toString(), lockCount = st.loadUint(16), deferredMax = st.loadCoins(),
    mature = st.loadCoins(), matureThrough = st.loadUint(32), buckets = st.loadDict(Dictionary.Keys.Uint(32), coins),
    expired = st.loadCoins(), expiredThrough = st.loadUint(32), expiring = st.loadDict(Dictionary.Keys.Uint(32), coins),
    ownerLocks = st.loadDict(Dictionary.Keys.Address(), locks); st.endParse();
  const nextId = pr.loadUint(32), live = pr.loadUint(8), escrowRaw = pr.loadCoins().toString();
  const slots = Array.from({ length: 16 }, () => pr.loadUint(32));
  const book = pr.loadDict(Dictionary.Keys.Uint(32), proposals); pr.endParse();
  if (phase > 1 || nextId < 1 || live > 48 || live !== book.size || lockCount > 16_384 || lockCount !== ownerLocks.size
    || buckets.size > 33 || expiring.size > 367 || (ts && ts.supplyBase > ts.genesisTotal)) throw Error('Invalid Governance storage bounds.');
  for (const [id] of book) if (id < 1 || id >= nextId) throw Error('Invalid Governance proposal ID.');
  // Queued proposals release their voting slots but remain in the proposal map.
  for (let index = 0; index < slots.length; index++) {
    const id = slots[index]; if (!id) continue;
    const p = book.get(id);
    if (!p || p.queued || p.slot !== index) throw Error('Invalid Governance voting slot.');
  }
  return { phase, bootstrap, bootstrapDeadline, salt, handoffBucket, jetton, sweeps, treasury, ts, policy, policyCount,
    stake: { totalLockedRaw, lockCount, deferredMax, mature, matureThrough, buckets, expired, expiredThrough, expiring, locks: ownerLocks },
    props: { nextId, live, escrowRaw, slots, proposals: book } };
}

export type GovernanceParams = { bucket: number; minVote: number; maxVote: number; review: number; delay: number; grace: number };
/** Same precedence and inclusive cutoffs as Governance.get_proposal. */
export function governanceProposalTiming(p: GovernanceProposal, params: GovernanceParams, now: number) {
  const closeAt = p.decidedAt === 0 ? p.start + params.maxVote : Math.max(p.decidedAt + params.review, p.start + params.minVote);
  const eta = closeAt + params.delay, expiresAt = eta + params.grace;
  return { closeAt, eta, expiresAt, status: now > expiresAt ? 'expired' as const : p.queued ? 'queued' as const
    : now >= closeAt ? 'closed' as const : 'voting' as const };
}
