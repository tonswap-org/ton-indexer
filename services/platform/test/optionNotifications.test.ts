import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications } from '../src/worker.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/option-${name}.json`, import.meta.url), 'utf8'));
const event = (name = 'exercise') => ledgerEventSchema.parse(fixture(name).events.find((e: any) => e.settlement?.optionLifecycle));
describe('actual producer option lifecycle notifications', () => {
  it('ingests unchanged canonical exercise and individual refund fixtures', () => {
    for (const name of ['exercise', 'ingress-refund', 'excess-refund']) {
      const f = fixture(name); for (const e of f.events) expect(ledgerEventSchema.safeParse(e).success).toBe(true);
      const notices = ledgerNotifications(event(name)); expect(notices.length).toBe(name === 'exercise' ? 2 : 1);
      expect(notices.every(n => n.category === 'activity')).toBe(true);
    }
  });
  it('keeps right retirement and actual cash payout separate, without inventing an exercise query', () => {
    const e = event(), notices = ledgerNotifications(e);
    expect(e.settlement!.queryId).toBeUndefined();
    expect(notices.map(n => n.title)).toEqual(['Option exercise confirmed', 'Option payout confirmed']);
    expect(notices[0]!.body).not.toContain('credited'); expect(notices[1]!.body).toContain('credited');
    expect(new Set(notices.map(n => n.sourceEventId)).size).toBe(2);
    expect(ledgerNotifications({ ...e, id: 'another-projection-generation' }).map(n => n.sourceEventId)).toEqual(notices.map(n => n.sourceEventId));
  });
  it('emits the exercised right independently while cash is pending', () => {
    const e = event(), l = e.settlement!.optionLifecycle!;
    l.payout.status = 'pending'; e.movements = e.movements.filter(m => m.purpose !== 'option_payout');
    const notices = ledgerNotifications(e); expect(notices.map(n => n.title)).toEqual(['Option exercise confirmed']);
    expect(ledgerNotifications(event()).map(n => n.title)).toEqual(['Option exercise confirmed', 'Option payout confirmed']);
  });
  it('scopes unchanged third-party producer events to holder retirement and recipient cash separately', () => {
    const f = fixture('third-party-exercise');
    const owner = ledgerEventSchema.parse(f.ownerEvents.find((e: any) => e.kind === 'option_exercise'));
    const recipient = ledgerEventSchema.parse(f.recipientEvents.find((e: any) => e.kind === 'option_exercise'));
    expect(ledgerNotifications(owner).map(n => n.title)).toEqual(['Option exercise confirmed']);
    expect(ledgerNotifications(recipient).map(n => n.title)).toEqual(['Option payout confirmed']);
    const pending = structuredClone(owner); pending.settlement!.optionLifecycle!.payout.status = 'pending';
    expect(ledgerNotifications(pending).map(n => n.title)).toEqual(['Option exercise confirmed']);
    const missingCredit = structuredClone(recipient); missingCredit.movements = [];
    expect(ledgerNotifications(missingCredit)).toEqual([]);
    const unrelated = structuredClone(recipient); unrelated.account = unrelated.settlement!.optionLifecycle!.factory;
    expect(ledgerNotifications(unrelated)).toEqual([]);
  });
  it('preserves independently proven right retirement when physical cash still lacks final proof', () => {
    const e = event(); e.issues.push('option_identity_or_cash_settlement_unverified', 'option_payout_settlement_pending');
    e.settlement!.optionLifecycle!.payout.status = 'pending';
    const notices = ledgerNotifications(e); expect(notices.map(n => n.title)).toEqual(['Option exercise confirmed']);
    e.settlement!.optionLifecycle!.payout.status = 'completed';
    expect(ledgerNotifications(e).map(n => n.title)).toEqual(['Option exercise confirmed']);
  });
  it('keeps exact cash evidence separate when the holder right movement is absent', () => {
    const e = event(); e.movements = e.movements.filter(m => m.purpose !== 'option_right_retired');
    const notices = ledgerNotifications(e); expect(notices.map(n => n.title)).toEqual(['Option payout confirmed']);
  });
  it.each(['owner', 'factoryState', 'productState', 'request', 'incomplete', 'unactivated', 'unsupportedIssue'])('does not claim exercise for missing or mismatched %s', field => {
    const e = event(), l = e.settlement!.optionLifecycle!;
    if (field === 'owner') l.beforePosition!.owner = l.factory;
    if (field === 'factoryState') l.afterPosition!.dataHash = 'aa'.repeat(32);
    if (field === 'productState') l.productAfter!.position = l.productBefore!.position;
    if (field === 'request') l.originalRequestBodyHash = 'aa'.repeat(32);
    if (field === 'incomplete') e.settlement!.status = 'incomplete';
    if (field === 'unactivated') l.beforePosition!.buyStateRaw = '512';
    if (field === 'unsupportedIssue') e.issues.push('option_exercise_state_unverified');
    expect(ledgerNotifications(e)).toEqual([]); expect(ledgerNotification(e)).toBeNull();
  });
  it.each(['credit', 'amount', 'recipientWallet', 'journal', 'journalKey', 'finalize', 'evidence', 'generic'])('preserves right proof but never claims cash from incorrect %s', field => {
    const e = event(), l = e.settlement!.optionLifecycle!, cash = e.movements.find(m => m.purpose === 'option_payout')!;
    if (field === 'credit') e.movements = e.movements.filter(m => m !== cash);
    if (field === 'amount') cash.amountRaw = '1';
    if (field === 'recipientWallet') cash.asset.wallet = l.factory;
    if (field === 'journal') l.payout.beforeJournal!.requestId = '999';
    if (field === 'journalKey') l.payout.journalKey = 'aa'.repeat(32);
    if (field === 'finalize') l.payout.afterJournal!.status = 3;
    if (field === 'evidence') l.payout.evidence = l.payout.evidence.filter(r => r.account !== l.payout.destinationWallet);
    if (field === 'generic') cash.evidence!.kind = 'jetton_transfer';
    const notices = ledgerNotifications(e); expect(notices.map(n => n.title)).toEqual(['Option exercise confirmed']);
  });
  it('does not turn independently unverified risk accounting into a cash receipt', () => {
    const e = event(), l = e.settlement!.optionLifecycle!;
    l.protocolAccounting = { status: 'unverified', riskClaimId: '3', riskDeliveredRaw: '999' };
    const notices = ledgerNotifications(e); expect(notices).toHaveLength(2);
    expect(notices[1]!.body).toContain('protocol accounting remains unverified');
    expect(notices.some(n => /reimbursement|risk.*confirmed/i.test(n.title))).toBe(false);
  });
  it.each(['scope', 'claim', 'wire', 'amount', 'owner', 'abort'])('does not expand an individual refund into an unsupported %s success', field => {
    const e = event('ingress-refund'), l = e.settlement!.optionLifecycle!;
    if (field === 'scope') l.refund!.scope = 'position_unwind';
    if (field === 'claim') l.refund!.claimId = '99';
    if (field === 'wire') l.refund!.beforeClaim!.finalizeWireId = '99';
    if (field === 'amount') l.refund!.beforeClaim!.amountRaw = '1';
    if (field === 'owner') l.refund!.beforeClaim!.owner = l.factory;
    if (field === 'abort') l.refund!.kind = 'aborted_buy';
    expect(ledgerNotifications(e)).toEqual([]); expect(ledgerNotification(e)).toBeNull();
  });
});
