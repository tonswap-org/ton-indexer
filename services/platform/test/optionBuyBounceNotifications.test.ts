import { readFileSync } from 'node:fs';
import { beginCell, Cell } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications } from '../src/worker.js';

// Positive cases are complete producer projections of actual initial-buy
// failures and emitted bounded bounces, never relabeled owner abort fixtures.
const fixture = (product = 'shout', status = 'complete') => JSON.parse(readFileSync(new URL(`./fixtures/option-buy-bounce-${product}-${status}.json`, import.meta.url), 'utf8'));
const event = (product = 'shout', status = 'complete'): LedgerEvent => ledgerEventSchema.parse(fixture(product, status).events.find((row: any) => row.kind === 'option_refund'));
const names = ['Option factory refund received', 'Option purchase refund complete'];
const titles = (value: LedgerEvent) => ledgerNotifications(value).map(notice => notice.title);
function evidence(value: LedgerEvent) {
  const lifecycle = value.settlement!.optionLifecycle!, unwind = lifecycle.refund!.unwind!;
  if (unwind.trigger.kind !== 'initial_series_buy_bounced') throw Error('Expected an automatic initial-buy bounce fixture');
  return { lifecycle, unwind, trigger: unwind.trigger };
}
function replaceBody(value: LedgerEvent, body: Cell) {
  const { lifecycle, unwind, trigger } = evidence(value);
  trigger.bodyBoc = body.toBoc().toString('base64');
  trigger.bodyHash = body.hash().toString('hex');
  lifecycle.requestEvidence!.bodyHash = trigger.bodyHash;
  unwind.cancellation.stateEvidence!.bodyHash = trigger.bodyHash;
}

describe('qualified initial series-buy bounce refund notifications', () => {
  for (const product of ['shout', 'outperformance']) {
    it(`accepts the producer ${product} failed product and factory recovery without an owner abort or cancel ACK`, () => {
      for (const raw of fixture(product).events) expect(ledgerEventSchema.safeParse(raw).success).toBe(true);
      const value = event(product), { lifecycle, unwind, trigger } = evidence(value);
      expect(trigger.opcode).toBe(product === 'shout' ? 0x424f5952 : 0x42425559);
      expect(unwind.reservationStatus).toBe('failed');
      expect(lifecycle.productBefore!.position).toBeNull();
      expect(lifecycle.productAfter!.position).toBeNull();
      expect(unwind.cancellation.evidence).toEqual([trigger.failedTransaction, trigger.recoveryTransaction]);
      expect(unwind.cancellation.stateEvidence).toEqual(lifecycle.requestEvidence);
      expect(unwind.custody).toMatchObject({ status: 'not_transferred', amountRaw: '0' });
      expect(unwind.vaultReturn).toMatchObject({ status: 'none', amountRaw: '0', evidence: [] });
      expect(unwind.commit).toBeUndefined(); expect(unwind.vaultAbort).toBeUndefined();
      expect(BigInt(unwind.funding.amountRaw)).toBeGreaterThan(2n ** 53n);
      expect(unwind.factoryReturn.amountRaw).toBe(unwind.funding.amountRaw);
      expect(value.movements.filter(row => row.purpose === 'option_refund')).toHaveLength(1);
      expect(value.movements.some(row => row.asset.kind === 'option_position')).toBe(false);
      expect(titles(value)).toEqual(names);
      expect(ledgerNotification(value)).toBeNull();
      expect(ledgerNotifications(value).every(notice => notice.body.includes('failed option purchase') && !notice.body.includes('owner-requested'))).toBe(true);
    });

    it(`keeps ${product} recovery provisional until physical factory cash is finalized`, () => {
      const value = event(product, 'pending'), { unwind } = evidence(value);
      expect(unwind.factoryReturn.status).toBe('pending');
      expect(value.movements.filter(row => row.purpose === 'option_refund')).toEqual([]);
      expect(titles(value)).toEqual([]);
    });
  }

  it.each(['bodyHash', 'bodyBoc', 'opcode', 'wireId', 'originalMessageBodyHash', 'failedTransaction', 'recoveryTransaction', 'factoryUnwind'])('requires typed bounce evidence: %s', field => {
    const raw = fixture().events.find((row: any) => row.kind === 'option_refund');
    delete raw.settlement.optionLifecycle.refund.unwind.trigger[field];
    expect(ledgerEventSchema.safeParse(raw).success).toBe(false);
  });

  it('requires the canonical trigger instead of the superseded owner-only field', () => {
    const raw = fixture().events.find((row: any) => row.kind === 'option_refund');
    raw.settlement.optionLifecycle.refund.unwind.abortRequestBodyHash = raw.settlement.optionLifecycle.refund.unwind.trigger.bodyHash;
    delete raw.settlement.optionLifecycle.refund.unwind.trigger;
    expect(ledgerEventSchema.safeParse(raw).success).toBe(false);
  });

  it.each(['invalidBoc', 'wrongHash', 'noBouncePrefix', 'wrongOpcode', 'wrongWire', 'truncated', 'extraBits', 'extraRef', 'changedCapturedOwner'])('rejects %s even when declared boundary body hashes agree', field => {
    const value = event(), { trigger } = evidence(value), body = Cell.fromBase64(trigger.bodyBoc);
    if (field === 'invalidBoc') trigger.bodyBoc = 'invalid';
    if (field === 'wrongHash') trigger.bodyHash = 'ab'.repeat(32);
    if (field === 'noBouncePrefix') replaceBody(value, beginCell().storeUint(0, 32).storeBits(body.bits.substring(32, 256)).endCell());
    if (field === 'wrongOpcode') replaceBody(value, beginCell().storeUint(0xffffffff, 32).storeUint(0x42425559, 32).storeBits(body.bits.substring(64, 224)).endCell());
    if (field === 'wrongWire') replaceBody(value, beginCell().storeBits(body.bits.substring(0, 64)).storeUint(BigInt(trigger.wireId) + 1n, 64).storeBits(body.bits.substring(128, 160)).endCell());
    if (field === 'truncated') replaceBody(value, beginCell().storeBits(body.bits.substring(0, 128)).endCell());
    if (field === 'extraBits') replaceBody(value, beginCell().storeSlice(body.beginParse()).storeBit(0).endCell());
    if (field === 'extraRef') replaceBody(value, beginCell().storeSlice(body.beginParse()).storeRef(Cell.EMPTY).endCell());
    if (field === 'changedCapturedOwner') replaceBody(value, beginCell().storeBits(body.bits.substring(0, 287)).storeBit(!body.bits.at(287)).endCell());
    expect(titles(value)).toEqual([]);
  });

  it.each(['failedSender', 'recoveryRecipient', 'failedReference', 'recoveryReference', 'originalBody', 'failedStateChanged', 'failedStateBefore', 'wrongProductEvidence', 'existingProduct', 'acknowledged', 'active', 'cancelAck', 'cancelState', 'ownerRelabel'])('rejects unproven automatic origin: %s', field => {
    const value = event(), { lifecycle, unwind, trigger } = evidence(value);
    if (field === 'failedSender') trigger.failedTransaction.account = lifecycle.factory;
    if (field === 'recoveryRecipient') trigger.recoveryTransaction.account = lifecycle.series!;
    if (field === 'failedReference') unwind.reservationStateEvidence.transactions = [trigger.recoveryTransaction];
    if (field === 'recoveryReference') lifecycle.requestEvidence!.transactions = [trigger.failedTransaction];
    if (field === 'originalBody') {
      trigger.originalMessageBodyHash = 'ab'.repeat(32);
      unwind.reservationStateEvidence.bodyHash = trigger.originalMessageBodyHash;
      lifecycle.productEvidence!.bodyHash = trigger.originalMessageBodyHash;
    }
    if (field === 'failedStateChanged') unwind.reservationStateEvidence.stateAfterHash = 'ab'.repeat(32);
    if (field === 'failedStateBefore') lifecycle.productBefore!.dataHash = 'ab'.repeat(32);
    if (field === 'wrongProductEvidence') lifecycle.productEvidence!.transactions = [trigger.recoveryTransaction];
    if (field === 'existingProduct') lifecycle.productBefore!.position = { owner: lifecycle.owner, tokenId: lifecycle.positionId!, notionalRaw: '1', premiumRaw: '0', collateralRaw: '1', buyWireId: trigger.wireId, active: false, exercised: false, settled: false };
    if (field === 'acknowledged') lifecycle.beforePosition!.buyStateRaw = unwind.beforeAbortBuyStateRaw = '1';
    if (field === 'active') lifecycle.beforePosition!.buyStateRaw = unwind.beforeAbortBuyStateRaw = '512';
    if (field === 'cancelAck') unwind.cancellation.evidence = [unwind.funding.evidence[2]!, trigger.failedTransaction, trigger.recoveryTransaction];
    if (field === 'cancelState') unwind.cancellation.stateEvidence = structuredClone(unwind.reservationStateEvidence);
    if (field === 'ownerRelabel') {
      unwind.trigger = { kind: 'owner_abort', bodyHash: beginCell().storeUint(0x4f424152, 32).storeUint(BigInt(lifecycle.seriesId!), 64).storeUint(BigInt(lifecycle.positionId!), 64).endCell().hash().toString('hex') };
      lifecycle.requestEvidence!.bodyHash = unwind.trigger.bodyHash;
    }
    expect(titles(value)).toEqual([]);
  });

  it.each(['index', 'retainedIndex', 'wrongSeries', 'wrongKind', 'notional', 'collateral', 'negativeCapacity', 'overflowCapacity'])('requires exact factory index/capacity unwind: %s', field => {
    const value = event(), { lifecycle, trigger } = evidence(value), state = trigger.factoryUnwind;
    if (field === 'index') state.seriesBuyIndexBefore = String(BigInt(state.seriesBuyIndexBefore) + 1n);
    if (field === 'retainedIndex') state.seriesBuyIndexAfter = state.seriesBuyIndexBefore as never;
    if (field === 'wrongSeries') state.afterSeries.optionAddress = lifecycle.factory;
    if (field === 'wrongKind') state.beforeSeries.kind = 2;
    if (field === 'notional') state.afterSeries.openNotionalRaw = String(BigInt(state.afterSeries.openNotionalRaw) + 1n);
    if (field === 'collateral') state.afterSeries.collateralLockedRaw = String(BigInt(state.afterSeries.collateralLockedRaw) + 1n);
    if (field === 'negativeCapacity') state.afterSeries.openNotionalRaw = '-1';
    if (field === 'overflowCapacity') state.beforeSeries.openNotionalRaw = String(1n << 120n);
    expect(titles(value)).toEqual([]);
  });

  it.each(['failedBeforeFunding', 'recoveryBeforeFailure'])('requires physical trigger chronology: %s', order => {
    const value = event(), { unwind, trigger } = evidence(value);
    const target = order === 'failedBeforeFunding' ? trigger.failedTransaction : trigger.recoveryTransaction;
    const lt = order === 'failedBeforeFunding' ? unwind.funding.evidence[2]!.lt : trigger.failedTransaction.lt;
    const old = { ...target };
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const record = node as Record<string, unknown>;
      if (record.account === old.account && record.lt === old.lt && record.hash === old.hash) record.lt = lt;
      Object.values(record).forEach(visit);
    };
    visit(value);
    expect(titles(value)).toEqual([]);
  });

  it.each(['missingMovement', 'duplicateMovement', 'partialAmount', 'wrongWallet', 'wrongWire', 'pendingCash', 'missingFinalizer', 'detachedCashState', 'notRefunded', 'vaultClaim'])('does not infer physical full cash from trigger/settled state: %s', field => {
    const value = event(), { lifecycle, unwind } = evidence(value), cash = unwind.factoryReturn;
    const movement = value.movements.find(row => row.purpose === 'option_refund')!;
    if (field === 'missingMovement') value.movements = value.movements.filter(row => row !== movement);
    if (field === 'duplicateMovement') value.movements.push(structuredClone(movement));
    if (field === 'partialAmount') movement.amountRaw = '37';
    if (field === 'wrongWallet') movement.asset.wallet = unwind.funding.factoryWallet;
    if (field === 'wrongWire') movement.evidence!.queryId = '999';
    if (field === 'pendingCash') cash.status = 'pending';
    if (field === 'missingFinalizer') cash.evidence = cash.evidence.slice(0, -1);
    if (field === 'detachedCashState') movement.evidence!.stateAfterHash = 'ab'.repeat(32);
    if (field === 'notRefunded') lifecycle.afterPosition!.buyStateRaw = String(BigInt(lifecycle.afterPosition!.buyStateRaw) & ~128n);
    if (field === 'vaultClaim') unwind.vaultReturn = { ...cash, amountRaw: unwind.funding.amountRaw };
    expect(titles(value)).toEqual([]);
  });

  it('keeps stable cash/completion identities across cursor generations without emitting generic option success', () => {
    const value = event(), notices = ledgerNotifications(value);
    expect(notices).toHaveLength(2);
    value.id = 'rebuilt-generation';
    expect(ledgerNotifications(value).map(notice => notice.sourceEventId)).toEqual(notices.map(notice => notice.sourceEventId));
    expect(new Set(notices.map(notice => notice.sourceEventId)).size).toBe(2);
    expect(ledgerNotification(value)).toBeNull();
  });
});
