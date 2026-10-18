import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification, ledgerNotifications } from '../src/worker.js';

// Unchanged producer projections supplied with provenance by the root task.
// No positive case is manufactured by relabeling a committed-custody fixture.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/option-abort-${name}.json`, import.meta.url), 'utf8'));
const event = (name: string): LedgerEvent => ledgerEventSchema.parse(fixture(name).events.find((row: any) => row.kind === 'option_refund'));
const names = { factory: 'Option factory refund received', vault: 'Option vault refund received', complete: 'Option purchase refund complete' };
const titles = (value: LedgerEvent) => ledgerNotifications(value).map(notice => notice.title);
const evidence = (value: LedgerEvent) => {
  const lifecycle = value.settlement!.optionLifecycle!;
  return { lifecycle, unwind: lifecycle.refund!.unwind!, abort: lifecycle.refund!.unwind!.vaultAbort! };
};

describe('canonical orphan-custody owner abort notifications', () => {
  for (const commit of ['failed', 'unobserved'] as const) {
    it.each([
      ['split', [names.factory, names.vault, names.complete]],
      ['factory', [names.factory]],
      ['vault', [names.vault]],
      ['pending', []],
    ] as const)(`accepts producer ${commit} / %s and describes only individually finalized cash`, (state, expected) => {
      const name = `orphan-${commit}-${state}`;
      for (const raw of fixture(name).events) expect(ledgerEventSchema.safeParse(raw).success).toBe(true);
      const value = event(name), { lifecycle, unwind, abort } = evidence(value);
      expect(unwind.commit!.status).toBe(commit);
      expect(abort.receiptBeforeHash).toBeNull();
      expect(abort.receiptAfterHash).toBe(abort.abortHash);
      expect(BigInt(abort.trackedBalanceAfterRaw) - BigInt(abort.trackedBalanceBeforeRaw)).toBe(BigInt(unwind.custody.amountRaw));
      expect(BigInt(unwind.custody.amountRaw)).toBeGreaterThan(2n ** 53n);
      expect(unwind.factoryReturn.amountRaw).toBe('37');
      expect(titles(value)).toEqual(expected);
      expect(ledgerNotification(value)).toBeNull();
      expect(ledgerNotifications(value).every(notice => notice.evidence.movements === value.movements)).toBe(true);
      if (state === 'split') {
        expect(lifecycle.payout.amountRaw).toBe(unwind.funding.amountRaw);
        expect(ledgerNotifications(value).at(-1)!.body).toContain('protocol accounting remains unverified');
      }
    });
  }

  it.each(['failed', 'unobserved'])('accepts the producer %s orphan boundary with an unchanged populated bucket', commit => {
    const value = event(`orphan-${commit}-existing-bucket`), { abort } = evidence(value);
    expect(abort.beforeBucket).toMatchObject({ lockedRaw: '987654321', premiumRaw: '321' });
    expect(abort.afterBucket).toEqual(abort.beforeBucket);
    expect(titles(value)).toEqual([names.factory, names.vault, names.complete]);
    // JSON key order is not part of the recorded bucket state.
    abort.afterBucket = Object.fromEntries(Object.entries(abort.afterBucket!).reverse()) as typeof abort.afterBucket;
    expect(titles(value)).toEqual([names.factory, names.vault, names.complete]);
  });

  it.each(['committed-interleaved', 'orphan-failed-interleaved', 'orphan-unobserved-interleaved'])('preserves refunds through unrelated shared-vault transactions: %s', name => {
    for (const raw of fixture(name).events) expect(ledgerEventSchema.safeParse(raw).success).toBe(true);
    const value = event(name), { unwind, abort } = evidence(value);
    if (unwind.commit!.stateEvidence) {
      expect(abort.stateEvidence.stateBeforeHash).not.toBe(unwind.commit!.stateEvidence.stateAfterHash);
      expect(BigInt(unwind.commit!.evidence[1]!.lt)).toBeGreaterThan(BigInt(unwind.custody.evidence.at(-1)!.lt));
      expect(BigInt(abort.evidence[0]!.lt)).toBeGreaterThan(BigInt(unwind.commit!.evidence[1]!.lt));
    }
    expect(titles(value)).toEqual([names.factory, names.vault, names.complete]);
  });

  it.each(['receiptBeforeHash', 'receiptAfterHash', 'trackedBalanceBeforeRaw', 'trackedBalanceAfterRaw', 'beforeBucket', 'afterBucket'])('requires canonical %s boundary evidence rather than accepting missing metadata', field => {
    const raw = fixture('orphan-failed-split').events.find((row: any) => row.kind === 'option_refund');
    delete raw.settlement.optionLifecycle.refund.unwind.vaultAbort[field];
    expect(ledgerEventSchema.safeParse(raw).success).toBe(false);
  });

  it('requires committed custody to release its bucket without adding tracked balance again', () => {
    const value = event('split'), { abort } = evidence(value);
    expect(abort.receiptBeforeHash).toBe(abort.receiptHash);
    expect(abort.trackedBalanceAfterRaw).toBe(abort.trackedBalanceBeforeRaw);
    expect(titles(value)).toEqual([names.factory, names.vault, names.complete]);
    abort.trackedBalanceAfterRaw = String(BigInt(abort.trackedBalanceAfterRaw) + 1n);
    expect(titles(value)).toEqual([]);
  });

  it.each(['lockedRaw', 'premiumRaw', 'reservedLockedRaw', 'reservedPremiumRaw', 'liabilityActionId', 'liabilityLastDispatchTs', 'liabilityTargetNotionalRaw', 'liabilityTargetImRaw', 'liabilityTargetCmRaw'])('does not erase a changed orphan bucket %s from the accounting evidence', field => {
    const value = event('orphan-failed-existing-bucket'), { abort } = evidence(value);
    expect(abort.beforeBucket).not.toBeNull();
    expect(abort.afterBucket).toEqual(abort.beforeBucket);
    abort.afterBucket![field] = String(BigInt(abort.afterBucket![field] as string) + 1n);
    expect(titles(value)).toEqual([]);
  });

  it.each(['liabilityStatus', 'liabilityRequestHash', 'bucketPresence'])('preserves the complete non-amount orphan bucket state: %s', field => {
    const value = event('orphan-unobserved-existing-bucket'), { abort } = evidence(value);
    if (field === 'liabilityStatus') abort.afterBucket!.liabilityStatus += 1;
    if (field === 'liabilityRequestHash') abort.afterBucket!.liabilityRequestHash = 'ab'.repeat(32);
    if (field === 'bucketPresence') abort.afterBucket = null;
    expect(titles(value)).toEqual([]);
  });

  it.each(['receiptAlreadyPresent', 'tombstone', 'trackedAmount', 'trackedUnderflow', 'trackedOverflow', 'bucket', 'commitUnverified', 'commitRelabeled', 'custodyTerminal', 'commitOrigin', 'abortTransaction', 'abortBoundary', 'abortNoChange', 'duplicateProof'])('closes %s without emitting even aggregate-complete notices', field => {
    const value = event('orphan-failed-split'), { lifecycle, unwind, abort } = evidence(value);
    if (field === 'receiptAlreadyPresent') abort.receiptBeforeHash = abort.receiptHash;
    if (field === 'tombstone') abort.receiptAfterHash = abort.receiptHash;
    if (field === 'trackedAmount') abort.trackedBalanceAfterRaw = String(BigInt(abort.trackedBalanceAfterRaw) + 1n);
    if (field === 'trackedUnderflow') { abort.trackedBalanceBeforeRaw = '1'; abort.trackedBalanceAfterRaw = '0'; }
    if (field === 'trackedOverflow') abort.trackedBalanceAfterRaw = String(1n << 120n);
    if (field === 'bucket') abort.beforeBucket = structuredClone(evidence(event('split')).abort.beforeBucket);
    if (field === 'commitUnverified') unwind.commit!.status = 'unverified';
    if (field === 'commitRelabeled') unwind.commit!.status = 'committed';
    if (field === 'custodyTerminal') unwind.custody.stateEvidence!.transactions = [unwind.custody.evidence[0]!];
    if (field === 'commitOrigin') unwind.commit!.evidence[0] = unwind.custody.evidence[0]!;
    if (field === 'abortTransaction') abort.evidence = [unwind.commit!.evidence[1]!];
    if (field === 'abortBoundary') abort.stateEvidence!.transactions = [unwind.commit!.evidence[1]!];
    if (field === 'abortNoChange') abort.stateEvidence!.stateAfterHash = abort.stateEvidence!.stateBeforeHash;
    if (field === 'duplicateProof') abort.evidence.push(abort.evidence[0]!);
    expect(titles(value)).toEqual([]);
  });

  it.each(['missingState', 'changedFailedState', 'wrongFailedTransaction', 'extraEvidence'])('requires an unchanged failed-commit boundary tied to its exact transaction: %s', field => {
    const value = event('orphan-failed-split'), { unwind, abort } = evidence(value);
    if (field === 'missingState') delete unwind.commit!.stateEvidence;
    if (field === 'changedFailedState') unwind.commit!.stateEvidence!.stateAfterHash = 'ab'.repeat(32);
    if (field === 'wrongFailedTransaction') unwind.commit!.stateEvidence!.transactions = [abort.evidence[0]!];
    if (field === 'extraEvidence') unwind.commit!.evidence.push(abort.evidence[0]!);
    expect(titles(value)).toEqual([]);
  });

  for (const name of ['split', 'orphan-failed-split']) {
    it.each(['beforeCustody', 'atCustody', 'atAbort', 'afterAbort'])(`requires custody, observed commit and abort in causal order for ${name}: %s`, timing => {
      const value = event(name), { unwind, abort } = evidence(value);
      const commit = unwind.commit!, reference = commit.evidence[1]!;
      const custodyLt = BigInt(unwind.custody.evidence.at(-1)!.lt), abortLt = BigInt(abort.evidence[0]!.lt);
      const lt = String(timing === 'beforeCustody' ? custodyLt - 1n : timing === 'atCustody' ? custodyLt : timing === 'atAbort' ? abortLt : abortLt + 1n);
      // Keep the same reference in each evidence list, so chronology itself
      // must reject this case rather than an incidental missing-reference check.
      const replace = (refs: typeof commit.evidence) => refs.map(ref =>
        ref.account === reference.account && ref.hash === reference.hash && ref.lt === reference.lt ? { ...ref, lt } : ref);
      value.settlement!.evidence = replace(value.settlement!.evidence);
      commit.stateEvidence!.transactions = replace(commit.stateEvidence!.transactions);
      commit.evidence = replace(commit.evidence);
      expect(titles(value)).toEqual([]);
    });
  }

  it('rejects a committed deposit without a state change or its exact transaction reference', () => {
    const unchanged = event('split'), state = evidence(unchanged).unwind.commit!.stateEvidence!;
    state.stateAfterHash = state.stateBeforeHash;
    expect(titles(unchanged)).toEqual([]);
    const detached = event('split'), { unwind, abort } = evidence(detached);
    unwind.commit!.stateEvidence!.transactions = [abort.evidence[0]!];
    expect(titles(detached)).toEqual([]);
  });

  it.each(['inventedState', 'extraEvidence'])('does not treat an unobserved commit as a historical execution: %s', field => {
    const value = event('orphan-unobserved-split'), { unwind, abort } = evidence(value);
    if (field === 'inventedState') unwind.commit!.stateEvidence = structuredClone(abort.stateEvidence!);
    if (field === 'extraEvidence') unwind.commit!.evidence.push(abort.evidence[0]!);
    expect(titles(value)).toEqual([]);
  });

  for (const lane of ['factory', 'vault'] as const) {
    it.each(['missingMovement', 'duplicateMovement', 'wrongAmount', 'wrongWallet', 'wrongWire', 'unfinalized', 'detachedCashHistory'])(`keeps the other cash leg when ${lane} %s is unproven`, field => {
      const value = event('orphan-unobserved-split'), { lifecycle, unwind } = evidence(value);
      const authority = lane === 'factory' ? lifecycle.factory : lifecycle.vault;
      const cash = lane === 'factory' ? unwind.factoryReturn : unwind.vaultReturn;
      const movement = value.movements.find(row => row.purpose === 'option_refund' && row.source === authority)!;
      if (field === 'missingMovement') value.movements = value.movements.filter(row => row !== movement);
      if (field === 'duplicateMovement') value.movements.push(structuredClone(movement));
      if (field === 'wrongAmount') movement.amountRaw = String(BigInt(movement.amountRaw) + 1n);
      if (field === 'wrongWallet') movement.asset.wallet = unwind.funding.factoryWallet;
      if (field === 'wrongWire') movement.evidence!.queryId = '999';
      if (field === 'unfinalized') cash.status = 'pending';
      if (field === 'detachedCashHistory') movement.evidence!.stateAfterHash = 'ab'.repeat(32);
      expect(titles(value)).toEqual([lane === 'factory' ? names.vault : names.factory]);
    });
  }

  for (const name of ['split', 'orphan-failed-split', 'orphan-unobserved-split']) {
    it.each([[0, 0], [1, 1], [1, 0], [2, 1], [0, 2]])(`requires DELIVERED accounting 0 to FINAL accounting 1 for ${name}, rejects %s to %s`, (before, after) => {
      const value = event(name), cash = evidence(value).unwind.vaultReturn;
      expect(cash.beforeJournal).toMatchObject({ status: 3, accountingApplied: 0 });
      expect(cash.afterJournal).toMatchObject({ status: 4, accountingApplied: 1 });
      expect(titles(value)).toEqual([names.factory, names.vault, names.complete]);
      cash.beforeJournal!.accountingApplied = before!;
      cash.afterJournal!.accountingApplied = after!;
      expect(titles(value)).toEqual([names.factory]);
    });
  }

  it('does not infer wallet credit from abort flags, tombstones or completed aggregate metadata', () => {
    const value = event('orphan-failed-split');
    value.movements = value.movements.filter(row => row.purpose !== 'option_refund');
    expect(titles(value)).toEqual([]);
    const partial = event('orphan-failed-factory'), { lifecycle } = evidence(partial);
    partial.settlement!.status = 'confirmed'; lifecycle.outcome = 'refunded'; lifecycle.payout.status = 'completed';
    expect(titles(partial)).toEqual([names.factory]);
  });

  it('preserves durable cash keys across later finalization, projection IDs and original-commit observation', () => {
    const pending = event('orphan-unobserved-factory');
    const first = ledgerNotifications(pending)[0]!;
    const complete = event('orphan-unobserved-split');
    expect(ledgerNotifications(complete)[0]!.sourceEventId).toBe(first.sourceEventId);
    const ids = ledgerNotifications(complete).map(notice => notice.sourceEventId);
    complete.id = 'rebuilt-projection-generation';
    expect(ledgerNotifications(complete).map(notice => notice.sourceEventId)).toEqual(ids);
    expect(ledgerNotifications(event('orphan-failed-split')).map(notice => notice.sourceEventId)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });
});
