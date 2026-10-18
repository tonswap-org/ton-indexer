import { stageTime, NotificationStageTimeError } from './notificationEvidence.js';
import { Address, beginCell, Cell } from '@ton/core';
import type { LedgerEvent } from './ledger.js';
import type { NewNotification } from './store.js';

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
type Ref = NonNullable<LedgerEvent['settlement']>['evidence'][number];
const key = (r: Ref) => `${r.account}:${r.lt}:${r.hash}:${r.utime}`;
const unique = (refs: Ref[]) => new Set(refs.map(key)).size === refs.length;
const sameRef = (a: Ref, b: Ref) => key(a) === key(b);
const uint64 = (value: string | null) => value !== null && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < 1n << 64n;
const coins = (value: string | null) => value !== null && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) > 0n && BigInt(value) < 1n << 120n;
/** Suppress generic success for known Launchpad evidence, including unsupported
 * business paths. Publication revisions discover later qualified evidence. */
export function isLaunchpadCandidate(event: LedgerEvent): boolean {
  return event.kind === 'launchpad_refund' || event.kind === 'launchpad_participation' ||
    event.settlement?.protocol === 'launchpad' || event.issues.some(issue => issue.startsWith('launchpad_'));
}

export function launchpadNotification(event: LedgerEvent, common: Common): NewNotification | null {
  try {
    return event.kind === 'launchpad_participation' ? participationNotification(event, common) : launchpadRefundNotification(event, common);
  } catch (error) {
    if (error instanceof NotificationStageTimeError) throw error;
    return null;
  }
}

function boundOriginal(event: LedgerEvent, original: NonNullable<NonNullable<LedgerEvent['settlement']>['launchpad']>['claimRequest'],
  identity: { kind: 'claim' | 'contribute' | 'bid'; sale: string; outerQueryId: string; innerQueryId: string | null; referrer: string | null; sourceWallet: string | null; forwardPayloadHash: string | null }): boolean {
  const requests = event.launchpadRequests?.filter(request => request.originalRequest.messageIndex === original.messageIndex) ?? [];
  return requests.length === 1 && sameRef(original.transaction, event) && Number.isSafeInteger(original.messageIndex) &&
    original.messageIndex >= 0 && original.messageIndex <= 32767 && Object.entries(identity).every(([field, value]) => requests[0]![field as keyof typeof identity] === value) &&
    same(requests[0]!.originalRequest, original);
}

/** The supported branch is an initial fixed failed-soft-cap claim with both its
 * original contribution and independently finalized recipient cash. Historical
 * state claims alone, including a FINAL journal flag, never supply a receipt. */
export function launchpadRefundNotification(event: LedgerEvent, common: Common): NewNotification | null {
  const s = event.settlement, l = s?.launchpad;
  if (event.status !== 'success' || event.kind !== 'launchpad_refund' || s?.protocol !== 'launchpad' ||
    s.operation !== event.kind || s.status !== 'confirmed' || !l || l.model !== 'fixed' || l.reason !== 'failed-soft-cap' ||
    !l.factory || l.participant !== event.account || l.recipientOwner !== event.account || !l.destinationWallet ||
    !boundOriginal(event, l.claimRequest, { kind: 'claim', sale: l.sale, outerQueryId: l.claimQueryId, innerQueryId: null, referrer: null, sourceWallet: null, forwardPayloadHash: null }) || l.claimRequest.messageBodyHash !== l.claimBodyHash ||
    !uint64(l.saleId) || !uint64(l.claimQueryId) || s.queryId !== l.claimQueryId || !uint64(l.settlementId) || l.settlementId === '0' ||
    !coins(l.amountRaw) || !l.settlementRequestHash || !l.originalPayment || !l.contribution ||
    event.issues.some(issue => issue.startsWith('launchpad_')) || !unique(s.evidence)) return null;
  const original = l.originalPayment, before = l.contribution.before, after = l.contribution.after;
  if (!uint64(original.queryId) || original.amountRaw !== l.amountRaw || original.sourceWallet !== l.destinationWallet ||
    original.destinationWallet !== l.sourceWallet || before.paymentAmountRaw !== l.amountRaw || BigInt(before.tokenAmountRaw) <= 0n || before.claimed ||
    !after.claimed || after.paymentAmountRaw !== '0' || after.tokenAmountRaw !== '0' ||
    before.rewardWallet !== after.rewardWallet || before.refundWallet !== after.refundWallet || before.referrer !== after.referrer || before.feePaidRaw !== after.feePaidRaw ||
    (before.refundWallet !== null && before.refundWallet !== event.account) ||
    original.evidence.length !== 3 || !unique(original.evidence) ||
    original.evidence.map(ref => ref.account).join('|') !== [l.destinationWallet, l.sourceWallet, l.sale].join('|') ||
    original.evidence.some((ref, index) => index > 0 && BigInt(ref.lt) <= BigInt(original.evidence[index - 1]!.lt))) return null;
  // Claim beneficiary is either the participant or the contract's explicit null
  // default. Both are current wire forms, not a historical schema adapter.
  const claimHashes = [null, Address.parse(event.account)].map(owner => beginCell().storeUint(0x434c414d, 32)
    .storeUint(BigInt(l.claimQueryId), 64).storeAddress(owner).endCell().hash().toString('hex'));
  const requestHash = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(BigInt(l.settlementId!), 64).storeCoins(BigInt(l.amountRaw!))
    .storeAddress(Address.parse(event.account)).storeAddress(Address.parse(l.sale))
    .storeRef(beginCell().storeUint(0x4a535454, 32).endCell()).storeCoins(0n).storeRef(Cell.EMPTY).endCell().hash().toString('hex');
  const internalHash = beginCell().storeUint(0x4a534954, 32).storeUint(BigInt(l.settlementId!), 64).storeCoins(BigInt(l.amountRaw!))
    .storeAddress(Address.parse(l.sale)).storeAddress(Address.parse(l.sourceWallet))
    .storeCoins(0n).storeRef(Cell.EMPTY).endCell().hash().toString('hex');
  if (!claimHashes.includes(l.claimBodyHash) || requestHash !== l.settlementRequestHash) return null;
  const purposes = ['contribution', 'refund-enqueue', 'delivery', 'finalization'] as const;
  if (l.stateEvidence.length !== purposes.length || purposes.some(purpose => l.stateEvidence.filter(ref => ref.purpose === purpose).length !== 1) ||
    l.stateEvidence.some(ref => ref.transaction.account !== l.sale || ref.afterSeqno < ref.beforeSeqno || ref.beforeHash === ref.afterHash)) return null;
  const boundary = (purpose: typeof purposes[number]) => l.stateEvidence.find(ref => ref.purpose === purpose)!;
  const contribution = boundary('contribution').transaction, enqueue = boundary('refund-enqueue').transaction;
  const delivery = boundary('delivery').transaction, finalization = boundary('finalization').transaction;
  if (!sameRef(contribution, original.evidence[2]!) ||
    ![enqueue, delivery, finalization].every(ref => s.evidence.some(proof => sameRef(ref, proof))) ||
    !(BigInt(contribution.lt) < BigInt(enqueue.lt) && BigInt(enqueue.lt) < BigInt(delivery.lt) && BigInt(delivery.lt) < BigInt(finalization.lt))) return null;
  // Exact source -> recipient -> source acknowledgement -> sale delivery ->
  // source finalize -> sale finalized graph. No aggregate amount substitutes it.
  const graph = [...s.evidence].sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : BigInt(a.lt) > BigInt(b.lt) ? 1 : 0);
  if (graph.length !== 8 || graph.map(ref => ref.account).join('|') !==
    [event.account, l.sale, l.sourceWallet, l.destinationWallet, l.sourceWallet, l.sale, l.sourceWallet, l.sale].join('|') ||
    !sameRef(graph[0]!, l.claimRequest.transaction) || !sameRef(graph[1]!, enqueue) || !sameRef(graph[5]!, delivery) || !sameRef(graph[7]!, finalization) ||
    graph.some((ref, index) => index > 0 && BigInt(ref.lt) <= BigInt(graph[index - 1]!.lt))) return null;
  const credits = event.movements.filter(movement => movement.purpose === 'launchpad_refund');
  const credit = credits[0];
  if (credits.length !== 1 || !credit || credit.direction !== 'in' || credit.amountRaw !== l.amountRaw || credit.asset.kind !== 'jetton' ||
    credit.asset.id !== `${event.network}:jetton:${l.paymentRoot}` || credit.asset.master !== l.paymentRoot || credit.asset.owner !== event.account ||
    credit.asset.wallet !== l.destinationWallet || credit.source !== l.sale || credit.destination !== event.account ||
    credit.evidence?.kind !== 'jetton_transfer' || credit.evidence.queryId !== l.settlementId ||
    credit.evidence.requestBodyHash !== l.settlementRequestHash || credit.evidence.bodyHash !== internalHash ||
    credit.evidence.opcode !== 0x4a534954 || credit.evidence.transactions?.length !== 2 ||
    !sameRef(credit.evidence.transactions[0]!, graph[2]!) || !sameRef(credit.evidence.transactions[1]!, graph[3]!)) return null;
  return { ...stageTime(common, graph), category: 'activity',
    sourceEventId: `launchpad-refund:${l.sale}:${l.saleId}:${event.account}:${l.settlementId}:${l.settlementRequestHash}:received`,
    title: 'Launchpad refund received', body: 'The payment for your fixed-price sale contribution was refunded to your wallet after the sale missed its soft cap.',
    evidence: { ...stageTime(common, graph).evidence, settlement: s, movements: event.movements } };
}

type Participation = NonNullable<NonNullable<LedgerEvent['settlement']>['launchpadParticipation']>;
type FillEntry = Extract<NonNullable<Participation['entitlement']>, { model: 'bonding' }>['after'];
const ordered = (refs: Ref[]) => unique(refs) && refs.every((r, i) => !i || BigInt(refs[i - 1]!.lt) < BigInt(r.lt) && refs[i - 1]!.utime <= r.utime);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Decode the exact linked fill cells, including the previous stack. This is
 * entitlement evidence; it never creates a received-token movement. */
function validFills(entry: Pick<FillEntry, 'fillsBoc' | 'fillsHash' | 'fills'>): boolean {
  let cell = Cell.fromBase64(entry.fillsBoc), i = 0;
  if (cell.hash().toString('hex') !== entry.fillsHash) return false;
  while (cell.bits.length || cell.refs.length) {
    if (cell.isExotic || i >= entry.fills.length) return false;
    const slice = cell.beginParse(), tokenAmountRaw = slice.loadCoins().toString(), paymentAmountRaw = slice.loadCoins().toString();
    if (!coins(tokenAmountRaw) || !coins(paymentAmountRaw) || slice.remainingBits || slice.remainingRefs > 1) return false;
    const previous = slice.remainingRefs ? slice.loadRef() : null;
    if (previous && !previous.bits.length && !previous.refs.length) return false;
    if (!same(entry.fills[i++], { tokenAmountRaw, paymentAmountRaw, hash: cell.hash().toString('hex'), previousHash: previous?.hash().toString('hex') ?? null })) return false;
    cell = previous ?? Cell.EMPTY;
  }
  return i === entry.fills.length;
}
function validEntitlement(m: Participation): boolean {
  const e = m.entitlement;
  if (!e || e.model !== m.model || e.after.claimed || !e.after.rewardWallet || !e.after.refundWallet ||
    e.before && (e.before.claimed || e.before.rewardWallet !== e.after.rewardWallet || e.before.refundWallet !== e.after.refundWallet)) return false;
  if (e.after.referrer !== (e.before ? e.before.referrer : m.referrer) || BigInt(e.after.feePaidRaw) < BigInt(e.before?.feePaidRaw ?? '0') ||
    e.model === 'auction' && e.after.feePaidRaw !== (e.before?.feePaidRaw ?? '0')) return false;
  let quantity: string;
  if (e.model === 'auction') {
    quantity = e.quantityDeltaRaw;
    if (!coins(quantity) || !coins(e.maxPriceRaw) || e.commitmentDeltaRaw !== m.payment.amountRaw ||
      BigInt(quantity) * BigInt(e.maxPriceRaw) !== BigInt(m.payment.amountRaw) || e.after.maxPriceRaw !== e.maxPriceRaw ||
      e.before && e.before.maxPriceRaw !== e.maxPriceRaw ||
      BigInt(e.after.commitmentRaw) - BigInt(e.before?.commitmentRaw ?? '0') !== BigInt(m.payment.amountRaw) ||
      BigInt(e.after.quantityRaw) - BigInt(e.before?.quantityRaw ?? '0') !== BigInt(quantity)) return false;
  } else {
    quantity = e.tokenDeltaRaw;
    if (!coins(quantity) || !coins(e.priceRaw) || e.paymentDeltaRaw !== m.payment.amountRaw ||
      BigInt(quantity) * BigInt(e.priceRaw) !== BigInt(m.payment.amountRaw) ||
      BigInt(e.after.paymentAmountRaw) - BigInt(e.before?.paymentAmountRaw ?? '0') !== BigInt(m.payment.amountRaw) ||
      BigInt(e.after.tokenAmountRaw) - BigInt(e.before?.tokenAmountRaw ?? '0') !== BigInt(quantity)) return false;
  }
  if (e.model !== 'fixed') {
    if (!validFills(e.after) || e.before && !validFills(e.before)) return false;
    const head = e.after.fills[0], previous = e.before?.fills ?? [];
    if (!head || head.tokenAmountRaw !== quantity || head.paymentAmountRaw !== m.payment.amountRaw ||
      head.previousHash !== (previous.length ? e.before!.fillsHash : null) || e.after.fills.length !== previous.length + 1 ||
      !e.after.fills.slice(1).every((fill, i) => same(fill, previous[i]))) return false;
  }
  // The live ABI permits either an explicit beneficiary or its participant
  // default; authenticate the exact inner payload independently of outer query.
  const choices = (value: string) => value === m.participant ? [null, Address.parse(value)] : [Address.parse(value)];
  return choices(e.after.rewardWallet).some(reward => choices(e.after.refundWallet!).some(refund => {
    const body = beginCell().storeUint(m.model === 'auction' ? 0x50424944 : 0x434e5452, 32).storeUint(BigInt(m.innerQueryId), 64);
    if (e.model === 'auction') body.storeCoins(BigInt(e.maxPriceRaw)).storeCoins(BigInt(e.quantityDeltaRaw));
    return body.storeAddress(reward).storeAddress(refund).storeRef(beginCell().storeAddress(m.referrer ? Address.parse(m.referrer) : null).endCell()).endCell().hash().toString('hex') === m.payment.forwardPayloadHash;
  }));
}
function participationNotification(event: LedgerEvent, common: Common): NewNotification | null {
  const s = event.settlement, m = s?.launchpadParticipation;
  if (event.status !== 'success' || event.kind !== 'launchpad_participation' || s?.protocol !== 'launchpad' || s.operation !== event.kind ||
    s.status !== 'confirmed' || !m || m.network !== event.network || m.participant !== event.account ||
    m.requestKind !== (m.model === 'auction' ? 'bid' : 'contribution') || !uint64(m.saleId) ||
    !uint64(m.outerQueryId) || !uint64(m.innerQueryId) || s.queryId !== m.outerQueryId || !coins(m.payment.amountRaw) ||
    !boundOriginal(event, m.originalRequest, { kind: m.requestKind === 'bid' ? 'bid' : 'contribute', sale: m.sale, outerQueryId: m.outerQueryId, innerQueryId: m.innerQueryId,
      referrer: m.referrer, sourceWallet: m.payment.sourceWallet, forwardPayloadHash: m.payment.forwardPayloadHash }) || m.originalRequest.messageBodyHash !== m.payment.requestBodyHash ||
    !Number.isSafeInteger(m.originalRequest.messageIndex) || m.originalRequest.messageIndex < 0 || m.originalRequest.messageIndex > 32767 ||
    m.tokenDelivery !== 'separate-settlement' || event.issues.some(issue => issue.startsWith('launchpad_'))) return null;
  const graph = s.evidence;
  if (graph.length !== 4 || !ordered(graph) || graph.map(r => r.account).join('|') !==
    [event.account, m.payment.sourceWallet, m.payment.destinationWallet, m.sale].join('|') || !sameRef(graph[0]!, m.originalRequest.transaction) ||
    m.stateEvidence.length !== 3) return null;
  for (const [purpose, index] of [['payment-debit', 1], ['payment-credit', 2], ['acceptance', 3]] as const) {
    const matches = m.stateEvidence.filter(v => v.purpose === purpose), b = matches[0];
    if (matches.length !== 1 || !b || !sameRef(b.transaction, graph[index]!) || b.beforeHash === b.afterHash || b.beforeSeqno > b.afterSeqno) return null;
    if (purpose === 'acceptance') { if (b.balanceBeforeRaw !== null || b.balanceAfterRaw !== null) return null; }
    else if (b.balanceBeforeRaw === null || b.balanceAfterRaw === null ||
      BigInt(b.balanceAfterRaw) - BigInt(b.balanceBeforeRaw) !== BigInt(m.payment.amountRaw) * (purpose === 'payment-debit' ? -1n : 1n)) return null;
  }
  const payments = event.movements.filter(v => v.purpose === 'launchpad_participation'), payment = payments[0], proof = payment?.evidence;
  if (payments.length !== 1 || !payment || payment.direction !== 'out' || payment.amountRaw !== m.payment.amountRaw ||
    payment.asset.kind !== 'jetton' || payment.asset.id !== `${event.network}:jetton:${m.payment.root}` || payment.asset.master !== m.payment.root ||
    payment.asset.owner !== event.account || payment.asset.wallet !== m.payment.sourceWallet || payment.source !== event.account || payment.destination !== m.sale ||
    proof?.kind !== 'jetton_transfer' || proof.opcode !== 0x178d4519 || proof.queryId !== m.outerQueryId || proof.requestBodyHash !== m.payment.requestBodyHash ||
    !proof.bodyHash || proof.transactions?.length !== 2 || !sameRef(proof.transactions[0]!, graph[1]!) || !sameRef(proof.transactions[1]!, graph[2]!) ||
    !validEntitlement(m)) return null;
  const original = m.originalRequest;
  return { ...stageTime(common, graph), category: 'activity',
    sourceEventId: `launchpad-participation:${event.network}:${m.sale}:${original.transaction.account}:${original.transaction.lt}:${original.transaction.hash}:${original.messageIndex}:${original.messageBodyHash}:accepted`,
    title: m.requestKind === 'bid' ? 'Bid accepted' : 'Contribution accepted',
    body: m.requestKind === 'bid' ? 'Your payment and bid allocation were verified. Token delivery is a separate settlement.' :
      'Your payment and contribution allocation were verified. Token delivery is a separate settlement.',
    evidence: { ...stageTime(common, graph).evidence, settlement: s, movements: event.movements } };
}
