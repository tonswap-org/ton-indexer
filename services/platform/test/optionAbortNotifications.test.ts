import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications } from '../src/worker.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/option-abort-${name}.json`, import.meta.url), 'utf8'));
const event = (name = 'split') => ledgerEventSchema.parse(fixture(name).events.find((e: any) => e.kind === 'option_refund'));
const titles = (e: ReturnType<typeof event>) => ledgerNotifications(e).map(n => n.title);
describe('canonical owner-requested option abort cash notifications', () => {
  it.each(['factory', 'split', 'partial'])('accepts unchanged producer %s evidence and only describes its independently completed cash', name => {
    for (const raw of fixture(name).events) expect(ledgerEventSchema.safeParse(raw).success).toBe(true);
    const e = event(name), n = ledgerNotifications(e);
    expect(n.map(v => v.title)).toEqual(name === 'factory' ? ['Option factory refund received', 'Option purchase refund complete'] :
      name === 'split' ? ['Option factory refund received', 'Option vault refund received', 'Option purchase refund complete'] : ['Option factory refund received']);
    expect(n.every(v => v.category === 'activity')).toBe(true);
    expect(ledgerNotification(e)).toBeNull();
  });
  it('preserves a 37 atomic partial receipt without announcing full principal or risk reimbursement', () => {
    const e = event('partial'), u = e.settlement!.optionLifecycle!.refund!.unwind!;
    expect(u.factoryReturn.amountRaw).toBe('37'); expect(BigInt(u.vaultReturn.amountRaw!)).toBeGreaterThan(2n ** 53n);
    const n = ledgerNotifications(e); expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('factory return only');
    expect(n[0]!.evidence.movements).toEqual(e.movements);
    const complete = ledgerNotifications(event());
    expect(complete.at(-1)!.body).toContain('protocol accounting remains unverified');
    expect(complete.some(n => /risk|reimbursement|liability|cancelled|cancellation/i.test(n.title))).toBe(false);
  });
  it('deduplicates the actual factory return as later vault finalization changes the ledger generation', () => {
    const pending = ledgerNotifications(event('partial'))[0]!, complete = ledgerNotifications(event());
    expect(complete[0]!.sourceEventId).toBe(pending.sourceEventId);
    const rebuilt = event(); rebuilt.id = 'another-generation';
    expect(ledgerNotifications(rebuilt).map(n => n.sourceEventId)).toEqual(complete.map(n => n.sourceEventId));
    expect(new Set(complete.map(n => n.sourceEventId)).size).toBe(3);
  });
  it.each(['query', 'owner', 'scope', 'abortHash', 'originalHash', 'payloadHash', 'funding', 'gross', 'active', 'reservation', 'cancellation', 'product', 'custody', 'commit', 'orphan', 'receipt', 'abortReceipt', 'bucket', 'history', 'unsupported'])('closes unsupported or mismatched %s origin', field => {
    const e = event(), l = e.settlement!.optionLifecycle!, u = l.refund!.unwind!;
    if (field === 'query') e.settlement!.queryId = '999';
    if (field === 'owner') l.owner = l.factory;
    if (field === 'scope') l.refund!.scope = 'individual_claim';
    if (field === 'abortHash') u.trigger.bodyHash = 'aa'.repeat(32);
    if (field === 'originalHash') u.funding.requestBodyHash = 'aa'.repeat(32);
    if (field === 'payloadHash') u.funding.payloadHash = 'aa'.repeat(32);
    if (field === 'funding') u.funding.ownerWallet = u.funding.factoryWallet;
    if (field === 'gross') u.funding.amountRaw = '37';
    if (field === 'active') l.beforePosition!.buyStateRaw = '525';
    if (field === 'reservation') u.reservationStatus = 'failed';
    if (field === 'cancellation') u.cancellation.status = 'pending';
    if (field === 'product') l.productAfter!.position = l.productBefore!.position;
    if (field === 'custody') u.custody.wireId = '999';
    if (field === 'commit') u.commit!.status = 'unverified';
    if (field === 'orphan') u.commit!.status = 'unobserved';
    if (field === 'receipt') u.vaultAbort!.receiptHash = 'aa'.repeat(32);
    if (field === 'abortReceipt') u.vaultAbort!.abortHash = 'aa'.repeat(32);
    if (field === 'bucket') u.vaultAbort!.afterBucket!.lockedRaw = '1';
    if (field === 'history') e.settlement!.evidence = e.settlement!.evidence.filter(r => r.account !== l.series);
    if (field === 'unsupported') e.issues.push('option_abort_cancellation_retry_unverified');
    expect(ledgerNotifications(e)).toEqual([]); expect(ledgerNotification(e)).toBeNull();
  });
  it.each(['movement', 'wallet', 'amount', 'wire', 'finalState', 'cashHistory'])('preserves factory cash while %s cannot prove the vault return', field => {
    const e = event(), l = e.settlement!.optionLifecycle!, u = l.refund!.unwind!;
    const m = e.movements.find(m => m.purpose === 'option_refund' && m.source === l.vault)!;
    if (field === 'movement') e.movements = e.movements.filter(v => v !== m);
    if (field === 'wallet') m.asset.wallet = u.funding.factoryWallet;
    if (field === 'amount') m.amountRaw = '37';
    if (field === 'wire') m.evidence!.queryId = '999';
    if (field === 'finalState') u.vaultReturn.afterJournal!.status = 3;
    if (field === 'cashHistory') u.vaultReturn.evidence = u.vaultReturn.evidence.slice(0, -1);
    expect(titles(e)).toEqual(['Option factory refund received']);
  });
  it.each(['movement', 'wire', 'refundBit', 'terminalHash', 'cashHistory'])('preserves vault cash while %s cannot prove the factory return', field => {
    const e = event(), l = e.settlement!.optionLifecycle!, u = l.refund!.unwind!;
    const m = e.movements.find(m => m.purpose === 'option_refund' && m.source === l.factory)!;
    if (field === 'movement') e.movements = e.movements.filter(v => v !== m);
    if (field === 'wire') m.evidence!.queryId = '999';
    if (field === 'refundBit') l.afterPosition!.buyStateRaw = String(BigInt(l.afterPosition!.buyStateRaw) & ~128n);
    if (field === 'terminalHash') m.evidence!.stateAfterHash = 'aa'.repeat(32);
    if (field === 'cashHistory') u.factoryReturn.evidence = u.factoryReturn.evidence.slice(0, -1);
    expect(titles(e)).toEqual(['Option vault refund received']);
  });
  it('does not claim full refund from cancellation, flags, aggregate status or ledger metadata without both credits', () => {
    const e = event(); e.movements = e.movements.filter(m => m.purpose !== 'option_refund');
    expect(ledgerNotifications(e)).toEqual([]);
  });
});
