import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification } from '../src/worker.js';
import { perpsEvent } from './fixtures/perps.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/t3-mint.json', import.meta.url), 'utf8'));
const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`;
describe('canonical T3 and perps activity evidence', () => {
  it.each([['perps-open', 'Perps payout confirmed'], ['option-activation', 'Option purchase confirmed']])('ingests actual emitted %s evidence', (name, title) => {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
    const events = fixture.events.map((event: unknown) => ledgerEventSchema.parse(event));
    const notices = events.map((event: LedgerEvent) => ledgerNotification(event));
    expect(notices.some((notice: any) => notice?.category === 'activity' && notice.title === title)).toBe(true);
  });

  it('accepts the actual emitted indexer mint with canonical TON hashes and exact principal', () => {
    const event = ledgerEventSchema.parse(fixture.events[0]);
    const notice = ledgerNotification(event);
    expect(notice).toMatchObject({ category: 'activity', title: 'T3 mint confirmed' });
    expect(notice!.evidence.settlement).toMatchObject({ t3: { mintedRaw: '1196836561418482882959144' } });
    expect(notice!.sourceEventId).toBe(ledgerNotification({ ...event, id: 'new-projection-generation' })!.sourceEventId);
  });
  it('rejects obsolete hex transaction hashes and malformed base64 while retaining hex code hashes', () => {
    const event = fixture.events[0];
    expect(ledgerEventSchema.safeParse({ ...event, hash: 'ab'.repeat(32) }).success).toBe(false);
    expect(ledgerEventSchema.safeParse({ ...event, hash: 'a'.repeat(43) + '=' }).success).toBe(false);
    expect(ledgerEventSchema.safeParse(event).success).toBe(true);
  });
  it.each(['owner', 'credit', 'debit', 'query', 'pending'])('does not label mismatched T3 %s as settled activity', field => {
    const event = ledgerEventSchema.parse(structuredClone(fixture.events[0]));
    if (field === 'owner') event.settlement!.t3!.owner = addr(8);
    if (field === 'credit') event.movements = event.movements.filter(m => m.purpose !== 't3_mint');
    if (field === 'debit') event.movements.find(m => m.purpose === 't3_collateral')!.amountRaw = '1';
    if (field === 'query') event.settlement!.queryId = '9';
    if (field === 'pending') event.settlement!.status = 'incomplete';
    expect(ledgerNotification(event)?.category).toBe('walletProtocol');
  });
  it('describes accepted engine bookkeeping without claiming pending payouts', () => {
    const event = perpsEvent(); const notice = ledgerNotification(event);
    expect(notice).toMatchObject({ category: 'activity', title: 'Position opening confirmed' });
    expect(notice?.body).toContain('payout remains unverified');
    expect(notice?.body).not.toContain('credited');
    expect(notice?.sourceEventId).toBe(ledgerNotification({ ...event, id: 'merged-generation' })?.sourceEventId);
  });
  it.each(['owner', 'positionKey', 'query', 'market', 'rejected', 'retry', 'boundary', 'engine', 'payout'])('requires exact perps %s evidence', field => {
    const event = perpsEvent(), p = event.settlement!.perps!;
    if (field === 'owner') p.owner = addr(8);
    if (field === 'positionKey') p.positionKey = 'ab'.repeat(32);
    if (field === 'query') p.queryId = '24';
    if (field === 'market') p.after!.position!.marketId = 2;
    if (field === 'rejected') p.outcome = 'rejected';
    if (field === 'retry') p.outcome = 'retry';
    if (field === 'boundary') delete p.before;
    if (field === 'engine') p.stateEvidence!.transactions[0]!.account = addr(8);
    if (field === 'payout') p.payout.status = 'completed';
    expect(ledgerNotification(event)?.category).toBe('walletProtocol');
  });
  it('a later typed payout gets its own stable notice without double counting engine fees', () => {
    const event = perpsEvent(), p = event.settlement!.perps!;
    const booked = ledgerNotification(event)!;
    p.payout = { status: 'completed', wireId: '87', amountRaw: '5', evidence: p.stateEvidence!.transactions };
    event.movements.push({ purpose: 'perps_payout', direction: 'in', amountRaw: '5', asset: { kind: 'jetton', id: `testnet:jetton:${p.root}`, master: p.root, owner: event.account }, evidence: { kind: 'perps_payout' } });
    const received = ledgerNotification(event)!;
    expect(received.title).toBe('Perps payout confirmed'); expect(received.body).toContain('credited to your wallet');
    expect(received.sourceEventId).not.toBe(booked.sourceEventId);
    expect((received.evidence.movements as any[]).filter(m => m.direction === 'fee')).toHaveLength(0);
  });
});
