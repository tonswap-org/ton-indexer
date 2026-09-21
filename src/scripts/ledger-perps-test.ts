import assert from 'node:assert/strict';
import { Address, Cell, beginCell } from '@ton/core';
import { accruePerpsFunding, perpsEconomics, tvmDiv } from '../ledger/perpsEconomics';
import { emptyPerpsAccount, perpsRiskActionKey, type PerpsState, type PerpsPosition, type PerpsRiskAction } from '../ledger/perpsState';
import { parseLedgerPerpsCodeHash } from '../config/ledgerPerps';
import * as wire from '../ledger/perpsWire';
// Explicit synthetic states exercise the economic verifier. Genuine archived
// runtime and message-causality cases run in perps-counterparty-economics-test
// and perps-risk-admission-test; these states never claim physical delivery.
const address = (n: number) => new Address(0, Buffer.alloc(32, n)).toRawString();
const owner = address(1), other = address(2), vault = address(3), root = address(4), pool = address(5), wallet = address(6);
const unit = 1000000000n, subject = beginCell().storeAddress(Address.parse(owner)).storeUint(1, 32).endCell().hash().toString('hex');
const positionKey = wire.perpsPositionKey(owner, 1), lossKey = beginCell().storeUint(0x43504c53, 32).endCell().hash().toString('hex');
const base = (): PerpsState => ({ root, walletCode: Cell.EMPTY, feeBps: 0, feeTreasury: null, router: null, riskVault: vault, riskVaultBucketId: 1, nativeSettlement: null,
    risk: { oracleDegraded: false, tvlDegraded: false, oracleDriftLevel: 0 }, riskNonce: '1', riskActions: new Map(), counterpartyMaintenance: { cursor: '0'.repeat(64), sequence: '0', positionCount: 0 }, configHash: 'a'.repeat(64), dataHash: 'b'.repeat(64),
    accounts: new Map([[owner, { ...emptyPerpsAccount(), collateralRaw: (25n * unit).toString(), openPositionCount: 1 }],
        [other, { ...emptyPerpsAccount(), collateralRaw: (500n * unit).toString() }]]), positions: new Map(), pending: new Map(), oracleRefreshes: new Map(),
    markets: new Map([[1, { pool, depthRaw: (2n ** 90n).toString(), alphaRaw: '0', betaRaw: '0', maxLeverageBps: 5000, maintenanceBps: 500,
                fundingIndexRaw: '0', fundingRemainderRaw: '0', fundingRateBpsRaw: '0', fundingValidUntil: '0', lastFundingTs: '0',
                oraclePriceHealthy: true, markRaw: unit.toString(), controlFeeDeltaBps: 0, clampBps: 100, adlDeficitRaw: '0', riskPolicy: null }]]) });
const clone = (s: PerpsState): PerpsState => ({ ...s, accounts: new Map([...s.accounts].map(([k, v]) => [k, { ...v }])),
    positions: new Map([...s.positions].map(([k, v]) => [k, { ...v, counterparty: { ...v.counterparty } }])), markets: new Map([...s.markets].map(([k, v]) => [k, { ...v }])),
    pending: new Map([...s.pending].map(([k, v]) => [k, { ...v }])), riskActions: new Map(s.riskActions) });
function action(s: PerpsState, notional: bigint, reserve: bigint, payout?: bigint, beneficiary = owner) {
    const previous = s.riskActions.get(perpsRiskActionKey(1, subject));
    let body: Cell;
    if (payout === undefined)
        body = beginCell().storeUint(0x52564c54, 32).storeUint(1, 64).storeUint(1, 16).storeUint(BigInt('0x' + subject), 256)
            .storeCoins(notional).storeCoins(reserve).storeCoins(0).endCell();
    else {
        assert(previous);
        body = beginCell().storeUint(0x52565053, 32).storeUint(2, 64).storeUint(1, 16).storeUint(BigInt('0x' + subject), 256)
            .storeUint(BigInt(previous.actionId), 64).storeUint(BigInt('0x' + previous.requestHash), 256).storeCoins(payout)
            .storeRef(beginCell().storeCoins(notional).storeCoins(reserve).storeCoins(0).storeAddress(Address.parse(beneficiary))
            .storeRef(beginCell().storeUint(1, 32).storeAddress(Address.parse(beneficiary)))).endCell();
    }
    const value: PerpsRiskAction = { kind: 1, status: payout === undefined ? 4 : 2, actionId: payout === undefined ? '1' : '2', previousActionId: payout === undefined ? '0' : '1',
        subjectId: subject, requestHash: body.hash().toString('hex'), requestBody: body, continuation: Cell.EMPTY, queuedAmountRaw: '0', settledAmountRaw: '0', recordedAt: '1' };
    s.riskNonce = value.actionId;
    s.riskActions.set(perpsRiskActionKey(1, subject), value);
}
function live() {
    const s = base();
    const p: PerpsPosition = { owner, marketId: 1, sizeRaw: (10n * unit).toString(), marginRaw: (25n * unit).toString(),
        entryNotionalRaw: (10n * unit).toString(), lastFundingIndexRaw: '0', counterparty: { reservedRaw: (20n * unit).toString(), pendingFundingRaw: '0', collectedLossRaw: '0' } };
    s.positions.set(positionKey, p);
    s.counterpartyMaintenance.positionCount = 1;
    action(s, 10n * unit, 20n * unit);
    return s;
}
function payout(s: PerpsState, amount: bigint) { if (amount > 0n)
    s.pending.set(wire.perpsTransferKey(wallet), { kind: 3, owner, marketId: 1, wireId: '12', amountRaw: amount.toString(), queuedRaw: '0', recordedAt: '1' }); }
function closeState(s: PerpsState, profit: bigint, loss = 0n) {
    const a = clone(s);
    a.positions.clear();
    a.counterpartyMaintenance = { ...a.counterpartyMaintenance, positionCount: 0 };
    a.accounts.set(owner, { ...a.accounts.get(owner)!, collateralRaw: '0', pendingFundingRaw: '0', openPositionCount: 0 });
    payout(a, 25n * unit - loss);
    action(a, 0n, 0n, profit);
    if (loss > 0n)
        a.pending.set(lossKey, { kind: 16, owner: vault, marketId: 0, wireId: '0', amountRaw: loss.toString(), queuedRaw: '0', recordedAt: '1' });
    return a;
}
const close: wire.PerpsRequest = { opcode: wire.PERPS_CLOSE, operation: 'close', queryId: '9007199254741233', marketId: 1, sizeRaw: '0', limitPriceRaw: '0', referrer: null };
assert.equal(tvmDiv(-101n, 100n), -2n);
// Funding checkpoints price only the period during which the prior authenticated
// rate was valid. These independent synthetic vectors do not claim chain proof.
const checkpoint = { fundingIndexRaw: '0', fundingRemainderRaw: '0', fundingRateBpsRaw: '120',
    fundingValidUntil: '1600', lastFundingTs: '1000' };
assert.deepEqual(accruePerpsFunding(checkpoint, 1300n), { fundingIndexRaw: '10', fundingRemainderRaw: '0', elapsed: 300n });
assert.deepEqual(accruePerpsFunding(checkpoint, 37000n), { fundingIndexRaw: '20', fundingRemainderRaw: '0', elapsed: 600n },
    'An idle ten-hour gap accrues only the six hundred authenticated seconds');
const negativeCheckpoint = { ...checkpoint, fundingRateBpsRaw: '-1' };
assert.deepEqual(accruePerpsFunding(negativeCheckpoint, 1001n), { fundingIndexRaw: '-1', fundingRemainderRaw: '3599', elapsed: 1n });
const negativeStep = { ...negativeCheckpoint, ...accruePerpsFunding(negativeCheckpoint, 1001n), lastFundingTs: '1001' };
assert.deepEqual(accruePerpsFunding(negativeStep, 1002n), { fundingIndexRaw: '-1', fundingRemainderRaw: '3598', elapsed: 1n });
assert.equal(accruePerpsFunding(negativeStep, 1002n).fundingIndexRaw, accruePerpsFunding(negativeCheckpoint, 1002n).fundingIndexRaw);
assert.equal(accruePerpsFunding(negativeStep, 1002n).fundingRemainderRaw, accruePerpsFunding(negativeCheckpoint, 1002n).fundingRemainderRaw);
assert.deepEqual(accruePerpsFunding({ ...checkpoint, fundingValidUntil: '999', fundingRemainderRaw: '77' }, 37000n),
    { fundingIndexRaw: '0', fundingRemainderRaw: '77', elapsed: 0n }, 'Expired observations preserve fractional debt without growing it');
assert.deepEqual(accruePerpsFunding({ ...checkpoint, lastFundingTs: '0', fundingValidUntil: '0' }, 37000n),
    { fundingIndexRaw: '0', fundingRemainderRaw: '0', elapsed: 0n }, 'The first observation cannot price the preceding history');
for (const defect of [{ fundingRemainderRaw: '-1' }, { fundingRemainderRaw: '3600' }, { fundingRateBpsRaw: (1n << 127n).toString() },
    { fundingValidUntil: '-1' }, { lastFundingTs: '1301' }]) {
    assert.throws(() => accruePerpsFunding({ ...checkpoint, ...defect }, 1300n));
}
assert.equal(parseLedgerPerpsCodeHash(' '), undefined);
for (const hash of ['0x' + 'a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), ' ' + 'a'.repeat(64)])
    assert.throws(() => parseLedgerPerpsCodeHash(hash));
assert.equal(parseLedgerPerpsCodeHash('a'.repeat(64)), 'a'.repeat(64));
const before = live();
before.markets.get(1)!.markRaw = (unit * 11n / 10n).toString();
const after = closeState(before, unit), economic = perpsEconomics(before, after, owner, wallet, close, '0');
assert(economic);
assert.equal(economic.realizedPnlRaw, unit.toString());
assert.equal(economic.payoutContributionRaw, (25n * unit).toString());
assert.equal(economic.counterpartyProfitRaw, unit.toString());
assert.equal(economic.counterpartySettlement?.beneficiary, owner);
assert.equal(economic.counterpartySettlement?.amountRaw, unit.toString());
assert.equal(economic.badDebtRaw, '0');
for (const field of ['fundingRateBpsRaw', 'fundingValidUntil', 'lastFundingTs'] as const) {
    const rewritten = clone(after);
    rewritten.markets.get(1)![field] = '1';
    assert.equal(perpsEconomics(before, rewritten, owner, wallet, close, '0'), null,
        'A settlement cannot silently rewrite its funding checkpoint: ' + field);
}
for (const defect of ['pooled-margin', 'wrong-beneficiary', 'missing-reservation', 'other-trader', 'extra-claim', 'wrong-predecessor'] as const) {
    const broken = clone(after);
    if (defect === 'pooled-margin')
        payout(broken, 26n * unit);
    if (defect === 'wrong-beneficiary') {
        broken.riskActions = new Map(before.riskActions);
        action(broken, 0n, 0n, unit, other);
    }
    if (defect === 'missing-reservation')
        broken.riskActions.clear();
    if (defect === 'other-trader')
        broken.accounts.get(other)!.collateralRaw = (499n * unit).toString();
    if (defect === 'extra-claim') {
        broken.riskActions = new Map(before.riskActions);
        action(broken, 0n, 0n, unit + 1n);
    }
    if (defect === 'wrong-predecessor') {
        const key = perpsRiskActionKey(1, subject), entry = broken.riskActions.get(key)!;
        broken.riskActions.set(key, { ...entry, previousActionId: '0' });
    }
    assert.equal(perpsEconomics(before, broken, owner, wallet, close, '0'), null, defect);
}
for (const kind of [12, 13]) {
    const finalizing = clone(after), key = wire.perpsTransferKey(wallet);
    finalizing.pending.set(key, { ...finalizing.pending.get(key)!, kind });
    assert.equal(perpsEconomics(before, finalizing, owner, wallet, close, '0')?.payoutContributionRaw, (25n * unit).toString());
}
for (const kind of [1, 10, 11]) {
    const obsolete = clone(after), key = wire.perpsTransferKey(wallet);
    obsolete.pending.set(key, { ...obsolete.pending.get(key)!, kind });
    assert.equal(perpsEconomics(before, obsolete, owner, wallet, close, '0'), null, 'Obsolete pooled funding transfer cannot prove a refund');
}
const removeBefore = live();
removeBefore.markets.get(1)!.fundingIndexRaw = '1';
const removeAfter = clone(removeBefore), removePosition = removeAfter.positions.get(positionKey)!;
removePosition.lastFundingIndexRaw = '1';
removePosition.marginRaw = (24n * unit - 1000000n).toString();
removeAfter.accounts.get(owner)!.collateralRaw = removePosition.marginRaw;
payout(removeAfter, unit);
removeAfter.pending.set(lossKey, { kind: 16, owner: vault, marketId: 0, wireId: '0', amountRaw: '1000000', queuedRaw: '0', recordedAt: '1' });
const remove: wire.PerpsRequest = { opcode: wire.PERPS_REMOVE_MARGIN, operation: 'remove_margin', queryId: '11', marketId: 1, marginRaw: unit.toString() };
assert.equal(perpsEconomics(removeBefore, removeAfter, owner, wallet, remove, '0')?.counterpartyLossRaw, '1000000');
const gap = live();
gap.markets.get(1)!.markRaw = (100n * unit).toString();
const capped = perpsEconomics(gap, closeState(gap, 20n * unit), owner, wallet, close, '0');
assert.equal(capped?.realizedPnlRaw, (990n * unit).toString());
assert.equal(capped?.counterpartyProfitRaw, (20n * unit).toString());
assert.equal(capped?.payoutContributionRaw, (25n * unit).toString(), 'Posted margin remains independently funded');
const loss = live();
loss.markets.get(1)!.markRaw = (unit * 9n / 10n).toString();
const lossAfter = closeState(loss, 0n, unit);
assert.equal(perpsEconomics(loss, lossAfter, owner, wallet, close, '0')?.counterpartyLossRaw, unit.toString());
const uncollected = clone(lossAfter);
uncollected.pending.delete(lossKey);
assert.equal(perpsEconomics(loss, uncollected, owner, wallet, close, '0'), null);
const stale = clone(before);
stale.markets.get(1)!.oraclePriceHealthy = false;
assert.equal(perpsEconomics(stale, after, owner, wallet, close, '0'), null);
const partial = clone(before), remain = partial.positions.get(positionKey)!;
remain.sizeRaw = (7500000000n).toString();
remain.entryNotionalRaw = (7500000000n).toString();
remain.marginRaw = (18750000000n).toString();
remain.counterparty.reservedRaw = (15n * unit).toString();
partial.accounts.get(owner)!.collateralRaw = remain.marginRaw;
payout(partial, 6250000000n);
action(partial, 7500000000n, 15n * unit, 250000000n);
const modify: wire.PerpsRequest = { opcode: wire.PERPS_MODIFY, operation: 'modify', marketId: 1, queryId: '9', sizeRaw: '-2500000000', marginRaw: '0', limitPriceRaw: '0', referrer: null };
assert.equal(perpsEconomics(before, partial, owner, wallet, modify, '0')?.counterpartyProfitRaw, '250000000');
const claimBefore = live();
claimBefore.markets.get(1)!.fundingIndexRaw = '-1';
claimBefore.positions.get(positionKey)!.counterparty.pendingFundingRaw = '7';
claimBefore.accounts.get(owner)!.pendingFundingRaw = '7';
const claimAfter = clone(claimBefore), claimPosition = claimAfter.positions.get(positionKey)!;
claimPosition.lastFundingIndexRaw = '-1';
claimPosition.counterparty.pendingFundingRaw = '0';
claimPosition.counterparty.reservedRaw = (20n * unit - 1000007n).toString();
claimAfter.accounts.get(owner)!.pendingFundingRaw = '0';
action(claimAfter, 10n * unit, 20n * unit - 1000007n, 1000007n);
const claim: wire.PerpsRequest = { opcode: wire.PERPS_CLAIM, operation: 'claim', queryId: '10', marketId: 1 };
const funding = perpsEconomics(claimBefore, claimAfter, owner, wallet, claim, '0');
assert.equal(funding?.fundingRaw, '1000000');
assert.equal(funding?.counterpartyProfitRaw, '1000007');
assert.equal(funding?.payoutContributionRaw, '0');
const adl: wire.PerpsRequest = { opcode: wire.PERPS_ADL, operation: 'adl', owner, queryId: '11', marketId: 1, sizeRaw: (10n * unit).toString() };
assert.equal(perpsEconomics(gap, closeState(gap, 20n * unit), owner, wallet, adl, '0')?.counterpartyProfitRaw, (20n * unit).toString());
assert.equal(perpsEconomics(gap, partial, owner, wallet, { ...adl, sizeRaw: '2500000000' }, '0'), null, 'Old quarter-position ADL is unsupported');
console.log('Perps canonical isolated reservation, exact RVPS beneficiary, margin cash, claim, gap, loss and adversarial proofs passed');

// Same-owner positions are isolated too: closing one market must return its
// margin immediately and must never debit another market's posted collateral.
const sibling = (state: PerpsState) => {
    const key = wire.perpsPositionKey(owner, 2), p = state.positions.get(positionKey)!;
    state.positions.set(key, { ...p, marketId: 2, sizeRaw: unit.toString(), marginRaw: (7n * unit).toString(),
        entryNotionalRaw: unit.toString(), counterparty: {reservedRaw:(2n*unit).toString(),pendingFundingRaw:'0',collectedLossRaw:'0'} });
    state.markets.set(2, {...state.markets.get(1)!});
    state.accounts.set(owner,{...state.accounts.get(owner)!,collateralRaw:(32n*unit).toString(),openPositionCount:2});
    state.counterpartyMaintenance = {...state.counterpartyMaintenance,positionCount:2};
    return key;
};
const isolatedBefore=live(), siblingKey=sibling(isolatedBefore);
isolatedBefore.markets.get(1)!.markRaw=(unit*11n/10n).toString();
const isolatedAfter=clone(isolatedBefore);isolatedAfter.positions.delete(positionKey);
isolatedAfter.accounts.set(owner,{...isolatedAfter.accounts.get(owner)!,collateralRaw:(7n*unit).toString(),openPositionCount:1});
isolatedAfter.counterpartyMaintenance={...isolatedAfter.counterpartyMaintenance,positionCount:1};
payout(isolatedAfter,25n*unit);action(isolatedAfter,0n,0n,unit);
assert.equal(perpsEconomics(isolatedBefore,isolatedAfter,owner,wallet,close,'0')?.payoutContributionRaw,(25n*unit).toString());
assert.deepEqual(isolatedAfter.positions.get(siblingKey),isolatedBefore.positions.get(siblingKey));
const pooledSibling=clone(isolatedAfter);pooledSibling.accounts.get(owner)!.collateralRaw='0';payout(pooledSibling,32n*unit);
assert.equal(perpsEconomics(isolatedBefore,pooledSibling,owner,wallet,close,'0'),null,'Cannot withdraw the surviving same-owner position margin');
const fundingIsolatedBefore=live();sibling(fundingIsolatedBefore);fundingIsolatedBefore.markets.get(1)!.fundingIndexRaw='30000';
const fundingIsolatedAfter=clone(fundingIsolatedBefore);fundingIsolatedAfter.positions.delete(positionKey);
fundingIsolatedAfter.counterpartyMaintenance={...fundingIsolatedAfter.counterpartyMaintenance,positionCount:1};
fundingIsolatedAfter.accounts.set(owner,{...fundingIsolatedAfter.accounts.get(owner)!,collateralRaw:(7n*unit).toString(),openPositionCount:1});
fundingIsolatedAfter.pending.set(lossKey,{kind:16,owner:vault,marketId:0,wireId:'0',amountRaw:(25n*unit).toString(),queuedRaw:'0',recordedAt:'1'});
action(fundingIsolatedAfter,0n,0n,0n);
const fundingIsolated=perpsEconomics(fundingIsolatedBefore,fundingIsolatedAfter,owner,wallet,close,'0');
assert.equal(fundingIsolated?.counterpartyLossRaw,(25n*unit).toString());
assert.equal(fundingIsolated?.uncollectedLossRaw,(5n*unit).toString());
assert.equal(fundingIsolated?.payoutContributionRaw,'0');
console.log('PASS same-owner isolated margin payout, funding cap, and pooled-collateral rejection');

// Funding reversals net the same position's booked LP claim before any trader
// cash moves. Synthetic state boundaries here independently prove arithmetic.
const nettedBefore=live();nettedBefore.positions.get(positionKey)!.counterparty.pendingFundingRaw=(2n*unit).toString();
nettedBefore.accounts.get(owner)!.pendingFundingRaw=(2n*unit).toString();
nettedBefore.markets.get(1)!.fundingIndexRaw='1000';
const nettedAfter=closeState(nettedBefore,unit);
assert.equal(perpsEconomics(nettedBefore,nettedAfter,owner,wallet,close,'0')?.counterpartyLossRaw,'0');
assert.equal(perpsEconomics(nettedBefore,nettedAfter,owner,wallet,close,'0')?.counterpartyProfitRaw,unit.toString());
const doublePaid=closeState(nettedBefore,2n*unit,unit);
assert.equal(perpsEconomics(nettedBefore,doublePaid,owner,wallet,close,'0'),null,'Cannot debit trader cash while paying the canceled funding claim');
const fundingGap=live();fundingGap.markets.get(1)!.markRaw=(100n*unit).toString();
fundingGap.markets.get(1)!.fundingIndexRaw='28000';
fundingGap.positions.get(positionKey)!.counterparty.pendingFundingRaw=(2n*unit).toString();
fundingGap.accounts.get(owner)!.pendingFundingRaw=(2n*unit).toString();
const fundingGapAfter=closeState(fundingGap,19n*unit,25n*unit);
for(const request of [close,claim]) {
  const result=perpsEconomics(fundingGap,fundingGapAfter,owner,wallet,request,'0');
  assert.equal(result?.counterpartyProfitRaw,(19n*unit).toString());
  assert.equal(result?.uncollectedLossRaw,'0','One T3 funding debt is settled from the already capped 20 T3 LP claim');
  assert.equal(result?.payoutContributionRaw,'0');
}
const forgivenGap=closeState(fundingGap,20n*unit,25n*unit);
assert.equal(perpsEconomics(fundingGap,forgivenGap,owner,wallet,close,'0'),null,'Subtracting funding debt before gross profit cap overpays a price gap');
const insolventClaim=live();insolventClaim.positions.get(positionKey)!.marginRaw=unit.toString();
insolventClaim.accounts.get(owner)!.collateralRaw=unit.toString();
insolventClaim.positions.get(positionKey)!.counterparty.pendingFundingRaw=unit.toString();
insolventClaim.accounts.get(owner)!.pendingFundingRaw=unit.toString();
insolventClaim.markets.get(1)!.markRaw=(unit/2n).toString();
const insolventClaimAfter=closeState(insolventClaim,0n,unit);insolventClaimAfter.pending.delete(wire.perpsTransferKey(wallet));
const forcedClaim=perpsEconomics(insolventClaim,insolventClaimAfter,owner,wallet,claim,'0');
assert.equal(forcedClaim?.counterpartyProfitRaw,'0');
assert.equal(forcedClaim?.uncollectedLossRaw,(3n*unit).toString());
console.log('PASS funding reversal cancellation, cap-before-debt gap netting, and insolvent funding-claim compulsory close');

const rescueBefore=live();rescueBefore.markets.get(1)!.oraclePriceHealthy=false;
const rescueAfter=clone(rescueBefore);rescueAfter.accounts.get(owner)!.collateralRaw=(26n*unit).toString();
rescueAfter.positions.get(positionKey)!.marginRaw=(26n*unit).toString();
const rescue:wire.PerpsRequest={opcode:wire.PERPS_ADD_MARGIN,operation:'add_margin',queryId:'99',marketId:1,marginRaw:unit.toString()};
assert.equal(perpsEconomics(rescueBefore,rescueAfter,owner,wallet,rescue,unit.toString())?.depositCollateralRaw,unit.toString(),'A funded isolated margin rescue does not need a healthy price');
assert.equal(perpsEconomics(rescueBefore,rescueAfter,owner,wallet,rescue,'0'),null,'Stale-oracle rescue cannot fabricate deposited collateral');
console.log('PASS oracle-independent actual-funded margin rescue');
