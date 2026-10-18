import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications } from '../src/worker.js';
import { isLaunchpadCandidate } from '../src/launchpadNotifications.js';

const fixture = (state: 'confirmed' | 'pending') => JSON.parse(readFileSync(new URL(`./fixtures/launchpad-fixed-refund-${state}.json`, import.meta.url), 'utf8'));
const event = (state: 'confirmed' | 'pending' = 'confirmed') => ledgerEventSchema.parse(fixture(state).events.find((row: LedgerEvent) => row.kind === 'launchpad_refund'));
const credit = (e: LedgerEvent) => e.movements.find(row => row.purpose === 'launchpad_refund')!;
const different = `0:${'f'.repeat(64)}`;
type Model = 'fixed' | 'bonding' | 'auction';
const participationFixture = (model: Model, variant = '') => JSON.parse(readFileSync(new URL(`./fixtures/launchpad-${model}${variant}-participation.json`, import.meta.url), 'utf8'));
const participations = (model: Model, variant = ''): LedgerEvent[] => participationFixture(model, variant).events.map((row: unknown) => ledgerEventSchema.parse(row))
  .filter((row: LedgerEvent) => row.kind === 'launchpad_participation' && row.settlement?.status === 'confirmed');

describe('exact original Launchpad participation notices', () => {
  it.each(['fixed', 'bonding', 'auction'] as const)('%s actual producer acceptance is payment and allocation, not token receipt', model => {
    for (const e of participations(model)) {
      const physical = JSON.stringify(e.movements), notices = ledgerNotifications(e);
      expect(notices.map(n => n.title)).toEqual([model === 'auction' ? 'Bid accepted' : 'Contribution accepted']);
      expect(notices[0]!.body).toContain('Token delivery is a separate settlement');
      expect(notices[0]!.evidence).toMatchObject({ settlement: e.settlement, movements: e.movements });
      expect(JSON.stringify(e.movements)).toBe(physical);
      expect(e.movements.filter(m => m.purpose === 'launchpad_participation')).toHaveLength(1);
      expect(e.movements.find(m => m.purpose === 'launchpad_participation')!.direction).toBe('out');
    }
  });
  it.each(['bonding', 'auction'] as const)('%s does not deduplicate separately funded identical request bodies or equate outer/inner queries', model => {
    const rows = participations(model), keys = rows.map(e => ledgerNotification(e)!.sourceEventId);
    expect(new Set(keys).size).toBe(rows.length);
    const hashes = rows.map(e => e.settlement!.launchpadParticipation!.payment.requestBodyHash);
    expect(new Set(hashes).size).toBeLessThan(hashes.length);
    const other = participations(model, '-other').find(e => e.settlement!.launchpadParticipation!.outerQueryId === '1201')!;
    expect(other.settlement!.launchpadParticipation!.innerQueryId).toBe('201');
    expect(ledgerNotification(other)?.category).toBe('activity');
  });
  it.each(['fixed', 'bonding', 'auction'] as const)('%s retains exact original through pre-credit and missing archive without inventing success', model => {
    const first = participations(model)[0]!;
    for (const variant of ['-before-credit', '-archive-missing']) {
      const source = participationFixture(model, variant);
      const e = ledgerEventSchema.parse(source.events.find((row: LedgerEvent) => row.id === first.id));
      expect(e.launchpadRequests).toEqual(first.launchpadRequests);
      expect(ledgerNotifications(e)).toEqual([]);
    }
  });
  it('physical original identity survives a new projection ID and additional input body observation', () => {
    const e = participations('fixed')[0]!, key = ledgerNotification(e)!.sourceEventId;
    e.id = 'rebuilt'; e.txId = 'presentation';
    e.settlement!.launchpadParticipation!.originalRequest.incomingBodyHash = null;
    e.launchpadRequests![0]!.originalRequest.incomingBodyHash = null;
    expect(ledgerNotification(e)!.sourceEventId).toBe(key);
  });
  const cases: [string, (e: LedgerEvent) => void][] = [
    ['missing request identities', e => { delete e.launchpadRequests; }],
    ['request belongs to other owner', e => { e.launchpadRequests![0]!.originalRequest.transaction.account = different; }],
    ['wrong outgoing message index', e => { e.settlement!.launchpadParticipation!.originalRequest.messageIndex++; }],
    ['original body hash mismatch', e => { e.settlement!.launchpadParticipation!.originalRequest.messageBodyHash = 'ff'.repeat(32); }],
    ['wrong network', e => { e.settlement!.launchpadParticipation!.network = 'mainnet'; }],
    ['wrong sale', e => { e.settlement!.launchpadParticipation!.sale = different; }],
    ['wrong model', e => { e.settlement!.launchpadParticipation!.model = 'auction'; }],
    ['wrong outer query', e => { e.settlement!.launchpadParticipation!.outerQueryId = '3'; }],
    ['wrong inner query', e => { e.settlement!.launchpadParticipation!.innerQueryId = '3'; }],
    ['wrong requested inviter', e => { e.settlement!.launchpadParticipation!.referrer = different; }],
    ['wrong stored inviter', e => { e.settlement!.launchpadParticipation!.entitlement!.after.referrer = different; }],
    ['wrong published inviter', e => { e.launchpadRequests![0]!.referrer = different; }],
    ['missing entitlement', e => { e.settlement!.launchpadParticipation!.entitlement = null; }],
    ['aggregate tokens unchanged', e => { const m = e.settlement!.launchpadParticipation!; if (m.entitlement?.model === 'bonding') m.entitlement.after.tokenAmountRaw = '0'; }],
    ['already claimed', e => { e.settlement!.launchpadParticipation!.entitlement!.after.claimed = true; }],
    ['wrong inner payload', e => { e.settlement!.launchpadParticipation!.payment.forwardPayloadHash = 'ff'.repeat(32); }],
    ['forged fill stack', e => { const m = e.settlement!.launchpadParticipation!; if (m.entitlement?.model === 'bonding') m.entitlement.after.fills[0]!.paymentAmountRaw = '1'; }],
    ['missing physical payment', e => { e.movements = e.movements.filter(m => m.purpose !== 'launchpad_participation'); }],
    ['duplicate physical payment', e => { e.movements.push(structuredClone(e.movements.find(m => m.purpose === 'launchpad_participation')!)); }],
    ['payment incorrectly received', e => { e.movements.find(m => m.purpose === 'launchpad_participation')!.direction = 'in'; }],
    ['payment asset owner', e => { e.movements.find(m => m.purpose === 'launchpad_participation')!.asset.owner = different; }],
    ['payment request hash', e => { e.movements.find(m => m.purpose === 'launchpad_participation')!.evidence!.requestBodyHash = 'ff'.repeat(32); }],
    ['missing credit reference', e => { e.movements.find(m => m.purpose === 'launchpad_participation')!.evidence!.transactions!.pop(); }],
    ['wrong source balance', e => { e.settlement!.launchpadParticipation!.stateEvidence.find(b => b.purpose === 'payment-debit')!.balanceAfterRaw = '0'; }],
    ['wrong destination balance', e => { e.settlement!.launchpadParticipation!.stateEvidence.find(b => b.purpose === 'payment-credit')!.balanceBeforeRaw = '0'; }],
    ['foreign acceptance transaction', e => { e.settlement!.launchpadParticipation!.stateEvidence.find(b => b.purpose === 'acceptance')!.transaction.account = different; }],
    ['duplicate historical purpose', e => { e.settlement!.launchpadParticipation!.stateEvidence[0]!.purpose = 'acceptance'; }],
    ['backwards archive', e => { e.settlement!.launchpadParticipation!.stateEvidence[0]!.beforeSeqno = 100; }],
    ['missing sale receipt', e => { e.settlement!.evidence.pop(); }],
    ['unresolved source', e => { e.issues.push('launchpad_acceptance_unverified'); }],
  ];
  it.each(cases)('withholds misleading acceptance for %s and retains identified follow-up', (_label, change) => {
    const e = participations('bonding')[0]!; change(e);
    expect(ledgerNotifications(e)).toEqual([]);
  });
});

describe('canonical fixed failed-soft-cap cash notifications', () => {
  it('retains an actual correlated CLAM before missing archived state permits a typed refund operation', () => {
    const bytes = readFileSync(new URL('./fixtures/launchpad-fixed-refund-claim-unresolved.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('146687f91f3615d7e8db37614ac5ed4a82561f9ea44329dbc82682b244e144dd');
    const source = JSON.parse(bytes.toString('utf8'));
    const e = ledgerEventSchema.parse(source.events.find((row: LedgerEvent) => row.issues.includes('launchpad_claim_settlement_unverified')));
    expect(e.kind).not.toBe('launchpad_refund'); expect(e.settlement?.protocol).not.toBe('launchpad');
    expect(e.id).toBe(event().id);
    expect(isLaunchpadCandidate(e)).toBe(true);
    expect(ledgerNotification(e)).toBeNull(); expect(ledgerNotifications(e)).toEqual([]);
  });

  it.each(['launchpad_identity_or_cash_settlement_unverified', 'launchpad_claim_unsupported', 'launchpad_claim_settlement_unverified_extra'])('does not pin a generic contribution for the unrelated %s marker', issue => {
    const e = event(); e.kind = 'transfer'; delete e.settlement; e.issues = [issue];
    expect(isLaunchpadCandidate(e)).toBe(true); expect(ledgerNotifications(e)).toEqual([]);
  });

  it.each(['confirmed', 'pending'] as const)('accepts unchanged producer %s output and only announces independently finalized cash', state => {
    expect(createHash('sha256').update(readFileSync(new URL(`./fixtures/launchpad-fixed-refund-${state}.json`, import.meta.url))).digest('hex')).toBe(
      state === 'confirmed' ? '5c7e468f181238f2dc32379c57dfb6592750a2d76163e55ece02a71e5f55cf62' : '60e8acfcea0bff9662e81bc39b24d2a16ec4d6a675b8dbc13ba94c659e1d5bb7');
    for (const row of fixture(state).events) expect(ledgerEventSchema.safeParse(row).success).toBe(true);
    const e = event(state), notices = ledgerNotifications(e);
    expect(notices.map(row => row.title)).toEqual(state === 'confirmed' ? ['Launchpad refund received'] : []);
    expect(notices.every(row => row.category === 'activity')).toBe(true);
    if (state === 'confirmed') {
      expect(notices[0]!.evidence).toMatchObject({ settlement: e.settlement, movements: e.movements });
      expect(notices[0]!.href).toBe(`/wallet?tx=${encodeURIComponent(e.txId)}`);
      expect(credit(e).evidence!.kind).toBe('jetton_transfer');
      expect(credit(e).evidence!.transactions).toHaveLength(2);
    }
  });

  it('uses contract settlement identity rather than projected event ID for a durable cash key', () => {
    const e = event(), initial = ledgerNotification(e)!;
    e.id = 'new-indexer-generation'; e.txId = 'a-new-presentation-id';
    expect(ledgerNotification(e)!.sourceEventId).toBe(initial.sourceEventId);
    expect(initial.sourceEventId).toContain(e.settlement!.launchpad!.settlementId);
  });

  it('does not present the historical FACT identity as official factory authority', () => {
    const e = event();
    expect(e.settlement!.launchpad!.factory).not.toBeNull();
    expect(ledgerNotifications(e).map(row => row.title)).toEqual(['Launchpad refund received']);
    expect(ledgerNotifications(e)[0]!.body).not.toMatch(/official|factory|creator withdrawal/i);
  });

  const mutations: [string, (e: LedgerEvent) => void][] = [
    ['missing metadata', e => { delete e.settlement!.launchpad; }],
    ['unknown reason', e => { e.settlement!.launchpad!.reason = null; }],
    ['missing historical FACT identity', e => { e.settlement!.launchpad!.factory = null; }],
    ['wrong participant', e => { e.settlement!.launchpad!.participant = different; }],
    ['wrong recipient', e => { e.settlement!.launchpad!.recipientOwner = different; }],
    ['wrong sale', e => { e.settlement!.launchpad!.sale = different; }],
    ['claim query mismatch', e => { e.settlement!.queryId = '999999'; }],
    ['claim query outside uint64', e => { e.settlement!.queryId = e.settlement!.launchpad!.claimQueryId = (1n << 64n).toString(); }],
    ['claim original mismatch', e => { e.settlement!.launchpad!.claimRequest.transaction.hash = 'ff'.repeat(32); }],
    ['claim outbound body mismatch', e => { e.settlement!.launchpad!.claimRequest.messageBodyHash = 'ff'.repeat(32); }],
    ['claim body hash', e => { e.settlement!.launchpad!.claimBodyHash = 'ff'.repeat(32); }],
    ['zero settlement identity', e => { e.settlement!.launchpad!.settlementId = '0'; }],
    ['amount outside the current coins wire', e => { e.settlement!.launchpad!.amountRaw = (1n << 120n).toString(); }],
    ['wrong settlement hash', e => { e.settlement!.launchpad!.settlementRequestHash = 'ff'.repeat(32); }],
    ['missing original contribution', e => { e.settlement!.launchpad!.originalPayment = null; }],
    ['original amount mismatch', e => { e.settlement!.launchpad!.originalPayment!.amountRaw = '1'; }],
    ['original source wallet mismatch', e => { e.settlement!.launchpad!.originalPayment!.sourceWallet = different; }],
    ['original destination mismatch', e => { e.settlement!.launchpad!.originalPayment!.destinationWallet = different; }],
    ['missing original physical receipt', e => { e.settlement!.launchpad!.originalPayment!.evidence.pop(); }],
    ['duplicate original receipt', e => { const refs = e.settlement!.launchpad!.originalPayment!.evidence; refs[1] = refs[0]!; }],
    ['already claimed before request', e => { e.settlement!.launchpad!.contribution!.before.claimed = true; }],
    ['claim flag not applied', e => { e.settlement!.launchpad!.contribution!.after.claimed = false; }],
    ['remaining payment not consumed', e => { e.settlement!.launchpad!.contribution!.after.paymentAmountRaw = '1'; }],
    ['remaining token claim not consumed', e => { e.settlement!.launchpad!.contribution!.after.tokenAmountRaw = '1'; }],
    ['wrong designated refund owner', e => { e.settlement!.launchpad!.contribution!.before.refundWallet = different; }],
    ['missing historical finalization', e => { e.settlement!.launchpad!.stateEvidence = e.settlement!.launchpad!.stateEvidence.filter(row => row.purpose !== 'finalization'); }],
    ['duplicate historical purpose', e => { e.settlement!.launchpad!.stateEvidence[0]!.purpose = 'finalization'; }],
    ['unchanged finalization state', e => { const row = e.settlement!.launchpad!.stateEvidence.find(row => row.purpose === 'finalization')!; row.afterHash = row.beforeHash; }],
    ['backwards snapshot sequence', e => { e.settlement!.launchpad!.stateEvidence[0]!.beforeSeqno = e.settlement!.launchpad!.stateEvidence[0]!.afterSeqno + 1; }],
    ['foreign historical account', e => { e.settlement!.launchpad!.stateEvidence[0]!.transaction.account = different; }],
    ['missing physical final receipt', e => { e.settlement!.evidence.pop(); }],
    ['duplicate physical graph reference', e => { e.settlement!.evidence[2] = e.settlement!.evidence[3]!; }],
    ['missing cash movement', e => { e.movements = e.movements.filter(row => row.purpose !== 'launchpad_refund'); }],
    ['duplicated cash movement', e => { e.movements.push(structuredClone(credit(e))); }],
    ['wrong credit direction', e => { credit(e).direction = 'out'; }],
    ['wrong credit amount', e => { credit(e).amountRaw = '1'; }],
    ['wrong root', e => { credit(e).asset.master = different; }],
    ['wrong asset identity', e => { credit(e).asset.id = `testnet:jetton:${different}`; }],
    ['wrong asset owner', e => { credit(e).asset.owner = different; }],
    ['wrong recipient wallet', e => { credit(e).asset.wallet = different; }],
    ['wrong source owner', e => { credit(e).source = different; }],
    ['wrong destination owner', e => { credit(e).destination = different; }],
    ['wrong internal transfer hash', e => { credit(e).evidence!.bodyHash = 'ff'.repeat(32); }],
    ['wrong source transfer hash', e => { credit(e).evidence!.requestBodyHash = 'ff'.repeat(32); }],
    ['wrong transfer query', e => { credit(e).evidence!.queryId = '999999'; }],
    ['wrong transfer opcode', e => { credit(e).evidence!.opcode = 1; }],
    ['missing recipient transfer evidence', e => { credit(e).evidence!.transactions!.pop(); }],
    ['unqualified source marker', e => { e.issues.push('launchpad_refund_state_or_code_unverified'); }],
    ['incomplete settlement', e => { e.settlement!.status = 'incomplete'; }],
  ];
  it.each(mutations)('withholds activity and preserves follow-up for %s', (_name, mutate) => {
    const e = event(); mutate(e);
    expect(ledgerNotification(e)).toBeNull(); expect(ledgerNotifications(e)).toEqual([]);
  });

  it.each(['model', 'address', 'amount', 'state purpose'] as const)('rejects noncanonical %s in the synchronized schema', field => {
    const e = structuredClone(fixture('confirmed').events.find((row: LedgerEvent) => row.kind === 'launchpad_refund'));
    if (field === 'model') e.settlement.launchpad.model = 'auction';
    if (field === 'address') e.settlement.launchpad.sale = 'not-an-address';
    if (field === 'amount') e.settlement.launchpad.amountRaw = 123;
    if (field === 'state purpose') e.settlement.launchpad.stateEvidence[0].purpose = 'business-flag';
    expect(ledgerEventSchema.safeParse(e).success).toBe(false);
  });
});
