import { Address, Cell, Dictionary, beginCell, type Slice, type DictionaryKey, type DictionaryKeyTypes, type DictionaryValue } from '@ton/core';
import { readDlmmMarketState } from './dlmmState';

export const DLMM_FEE_GROWTH_SCALE = 1n << 128n;
const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('dlmm_liquidity_trailing_data'); };
const raw = (value: string, bits = 256) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw Error('dlmm_liquidity_integer_invalid');
  const n = BigInt(value); if (n >= 1n << BigInt(bits)) throw Error('dlmm_liquidity_integer_overflow'); return n;
};
const binIdValid = (id: number) => { if (!Number.isInteger(id) || Math.abs(id) > 200000) throw Error('dlmm_liquidity_bin_id_invalid'); };
const keyString = (n: bigint) => n.toString(16).padStart(64, '0');
const address = (s: Slice) => s.loadAddress().toRawString();
const uintValue: DictionaryValue<string> = { serialize: (v, b) => { b.storeUint(raw(v), 256); }, parse: s => { const n = s.loadUintBig(256).toString(); end(s); return n; } };
const cellValue: DictionaryValue<Cell> = { serialize: (v, b) => { b.storeRef(v); }, parse: s => { const cell = s.loadRef(); end(s); return cell; } };
function dictionary<K extends DictionaryKeyTypes, V>(cell: Cell, key: DictionaryKey<K>, value: DictionaryValue<V>) {
  const s = cell.beginParse(), result = s.loadDict(key, value); end(s); return result;
}
const positionDictionary = (cell: Cell) => new Map([...dictionary(cell, Dictionary.Keys.BigUint(256), uintValue)].map(([key, value]) => [keyString(key), value]));

export interface DlmmLiquidityBin {
  reserveTRaw: string; reserveXRaw: string; sharesRaw: string;
  feeGrowthTRaw: string; feeGrowthXRaw: string; feeReserveTRaw: string; feeReserveXRaw: string; priceInvQ64Raw: string;
}
export interface DlmmWithdrawalRecord {
  queryId: string; binId: number; sharesRaw: string; legT: 0 | 1 | 2; legX: 0 | 1 | 2;
  settlementTId: string; settlementXId: string; owner: string; recipient: string;
  totalTRaw: string; totalXRaw: string; completionFundedRaw: string;
  poolWalletT: string; poolWalletX: string; recipientWalletT: string; recipientWalletX: string; recordHash: string;
}
export interface DlmmPendingLiquidityAdd {
  amountTRaw: string; amountXRaw: string; fundingTRaw: string; fundingXRaw: string;
  notificationHashT: string; notificationHashX: string;
  minSharesRaw: string; vaultT: string | null; vaultX: string | null; recordHash: string;
}
export interface DlmmLiquidityState {
  market: ReturnType<typeof readDlmmMarketState>;
  bins: Map<number, DlmmLiquidityBin>;
  feeGrowthGlobalTRaw: string; feeGrowthGlobalXRaw: string;
  positions: Map<string, string>; checkpointsT: Map<string, string>; checkpointsX: Map<string, string>;
  creditsT: Map<string, string>; creditsX: Map<string, string>; lockedShares: Map<string, string>;
  activeWithdrawalQueryId: string; withdrawals: Map<string, DlmmWithdrawalRecord>;
  pending: Map<string, DlmmPendingLiquidityAdd>; binLiquidityCapRaw: string;
}
export interface DlmmLiquidityPosition {
  positionKey: string; sharesRaw: string; checkpointTRaw: string; checkpointXRaw: string;
  creditedTRaw: string; creditedXRaw: string; lockedSharesRaw: string;
}
export type DlmmLiquidityRequest =
  | { kind: 'withdrawal'; owner: string; recipient: string; binId: number; sharesRaw: string; queryId: string }
  | { kind: 'collect-fees'; owner: string; recipient: string; binId: number; sharesRaw: string }
  | { kind: 'add'; owner: string; binId: number; amountTRaw: string; amountXRaw: string; minSharesRaw: string };
export interface DlmmLiquidityAmounts {
  kind: DlmmLiquidityRequest['kind']; owner: string; binId: number; positionKey: string;
  principalTRaw: string; principalXRaw: string; feeTRaw: string; feeXRaw: string; totalTRaw: string; totalXRaw: string;
  mintedSharesRaw: string; burnedSharesRaw: string;
  accruedTRaw: string; accruedXRaw: string;
  beforePosition: DlmmLiquidityPosition; afterPosition: DlmmLiquidityPosition;
  beforeBin: DlmmLiquidityBin; afterBin: DlmmLiquidityBin;
  afterFeeClaimedTRaw: string; afterFeeClaimedXRaw: string;
}

function readBin(s: Slice): DlmmLiquidityBin {
  if (s.remainingBits !== 512 || s.remainingRefs !== 1) throw Error('dlmm_liquidity_bin_layout_invalid');
  const reserveTRaw = s.loadUintBig(128).toString(), reserveXRaw = s.loadUintBig(128).toString(), sharesRaw = s.loadUintBig(256).toString();
  const extra = s.loadRef().beginParse(); end(s);
  let feeGrowthTRaw = '0', feeGrowthXRaw = '0', feeReserveTRaw = '0', feeReserveXRaw = '0', priceInvQ64Raw = '0';
  // An empty extra is the current dlmm_empty_bin representation, not a prior layout.
  if (extra.remainingBits || extra.remainingRefs) {
    if (extra.remainingBits !== 896 || extra.remainingRefs) throw Error('dlmm_liquidity_extra_layout_invalid');
    feeGrowthTRaw = extra.loadUintBig(256).toString(); feeGrowthXRaw = extra.loadUintBig(256).toString();
    feeReserveTRaw = extra.loadUintBig(128).toString(); feeReserveXRaw = extra.loadUintBig(128).toString(); priceInvQ64Raw = extra.loadUintBig(128).toString(); end(extra);
  } else if (reserveTRaw !== '0' || reserveXRaw !== '0' || sharesRaw !== '0') throw Error('dlmm_liquidity_populated_empty_extra');
  if (BigInt(feeReserveTRaw) > BigInt(reserveTRaw) || BigInt(feeReserveXRaw) > BigInt(reserveXRaw)) throw Error('dlmm_liquidity_fee_reserve_invalid');
  return { reserveTRaw, reserveXRaw, sharesRaw, feeGrowthTRaw, feeGrowthXRaw, feeReserveTRaw, feeReserveXRaw, priceInvQ64Raw };
}
const binValue: DictionaryValue<DlmmLiquidityBin> = { serialize: () => { throw Error('dlmm_liquidity_read_only'); }, parse: readBin };

/** Current untagged DlmmPendingAdd with mandatory vault and notification refs. */
export function readDlmmPendingLiquidityAdd(cell: Cell): DlmmPendingLiquidityAdd {
  const s = cell.beginParse();
  if (s.remainingRefs !== 2) throw Error('dlmm_liquidity_pending_layout_invalid');
  const amountTRaw = s.loadCoins().toString(), amountXRaw = s.loadCoins().toString(), fundingTRaw = s.loadCoins().toString(), fundingXRaw = s.loadCoins().toString(), minSharesRaw = s.loadUintBig(256).toString();
  const vaults = s.loadRef().beginParse(), vaultT = vaults.loadMaybeAddress()?.toRawString() ?? null, vaultX = vaults.loadMaybeAddress()?.toRawString() ?? null;
  const notifications = s.loadRef().beginParse();
  if (notifications.remainingBits !== 512 || notifications.remainingRefs) throw Error('dlmm_liquidity_pending_notifications_invalid');
  const notificationHashT = keyString(notifications.loadUintBig(256)), notificationHashX = keyString(notifications.loadUintBig(256));
  end(s); end(vaults); end(notifications);
  if ((amountTRaw === '0') !== (vaultT === null) || (amountXRaw === '0') !== (vaultX === null) ||
    amountTRaw === '0' && fundingTRaw !== '0' || amountXRaw === '0' && fundingXRaw !== '0' ||
    amountTRaw === '0' && amountXRaw === '0' || amountTRaw !== '0' && amountXRaw !== '0' ||
    (amountTRaw === '0') !== (notificationHashT === '0'.repeat(64)) || (amountXRaw === '0') !== (notificationHashX === '0'.repeat(64))) throw Error('dlmm_liquidity_pending_fields_invalid');
  return { amountTRaw, amountXRaw, fundingTRaw, fundingXRaw, minSharesRaw, vaultT, vaultX, notificationHashT, notificationHashX, recordHash: cell.hash().toString('hex') };
}

export function dlmmPendingLiquidityKey(owner: string, binId: number, queryId: string): string {
  binIdValid(binId);
  return beginCell().storeAddress(Address.parse(owner)).storeInt(binId, 32).storeUint(raw(queryId, 64), 64).endCell().hash().toString('hex');
}

/** Integer Q64 cache initialization from current math.tolk. This is a bin's
 * execution ratio, never a fiat valuation or an assumed token peg. */
export function dlmmLiquidityInversePrice(binId: number, spacing: number): string {
  binIdValid(binId);
  if (!Number.isInteger(spacing) || spacing < 1 || spacing > 200) throw Error('dlmm_liquidity_spacing_invalid');
  const base = 1n << 64n; let result = base, acc = base + base * BigInt(spacing) / 1000000n, n = BigInt(Math.abs(binId));
  while (n > 0n) {
    if (n & 1n) result = result * acc >> 64n;
    n >>= 1n; acc = acc * acc >> 64n;
    if (!acc) throw Error('dlmm_liquidity_price_invalid');
  }
  const price = binId < 0 ? base * base / result : result;
  raw(price.toString(), 128); if (!price) throw Error('dlmm_liquidity_price_invalid');
  const inverse = base * base / price;
  raw(inverse.toString(), 128); if (!inverse) throw Error('dlmm_liquidity_price_invalid');
  return inverse.toString();
}

/** Strict DWR1 business record. Its totals include principal plus LP fees;
 * the record alone cannot determine that split or prove physical receipt. */
export function readDlmmLiquidityWithdrawal(cell: Cell): DlmmWithdrawalRecord {
  const s = cell.beginParse();
  if (s.remainingBits !== 516 || s.remainingRefs !== 4 || s.loadUint(32) !== 0x44575231) throw Error('dlmm_liquidity_withdrawal_layout_invalid');
  const queryId = s.loadUintBig(64).toString(), binId = s.loadInt(32), sharesRaw = s.loadUintBig(256).toString();
  const legT = s.loadUint(2), legX = s.loadUint(2), settlementTId = s.loadUintBig(64).toString(), settlementXId = s.loadUintBig(64).toString();
  if (queryId === '0' || sharesRaw === '0' || legT > 2 || legX > 2) throw Error('dlmm_liquidity_withdrawal_fields_invalid');
  binIdValid(binId);
  const actors = s.loadRef().beginParse(), amounts = s.loadRef().beginParse(), pool = s.loadRef().beginParse(), recipientWallets = s.loadRef().beginParse();
  const owner = address(actors), recipient = address(actors), totalTRaw = amounts.loadCoins().toString(), totalXRaw = amounts.loadCoins().toString(), completionFundedRaw = amounts.loadCoins().toString();
  const poolWalletT = address(pool), poolWalletX = address(pool), recipientWalletT = address(recipientWallets), recipientWalletX = address(recipientWallets);
  [s, actors, amounts, pool, recipientWallets].forEach(end);
  return { queryId, binId, sharesRaw, legT: legT as 0 | 1 | 2, legX: legX as 0 | 1 | 2, settlementTId, settlementXId, owner, recipient,
    totalTRaw, totalXRaw, completionFundedRaw, poolWalletT, poolWalletX, recipientWalletT, recipientWalletX, recordHash: cell.hash().toString('hex') };
}

/** Qualified current constructor or store_state. The canonical market reader
 * selects and validates the exact form; no failed-parser fallback or prices. */
export function readDlmmLiquidityState(boc: string): DlmmLiquidityState {
  const market = readDlmmMarketState(boc);
  if (market.poolKind !== 4 || market.binSpacing < 1 || market.binSpacing > 200) throw Error('dlmm_liquidity_pool_kind_invalid');
  binIdValid(market.activeBinId);
  const cell = Cell.fromBase64(boc), bs = cell.refs[0].beginParse();
  const guard = cell.refs[2].beginParse(); guard.skip(288); const binLiquidityCapRaw = guard.loadUintBig(128).toString(); end(guard);
  const feeGrowthGlobalTRaw = bs.loadUintBig(256).toString(), feeGrowthGlobalXRaw = bs.loadUintBig(256).toString();
  const binDict = bs.loadRef(); end(bs);
  if (market.storageForm === 'constructor') return { market, bins: new Map(), feeGrowthGlobalTRaw, feeGrowthGlobalXRaw,
    positions: new Map(), checkpointsT: new Map(), checkpointsX: new Map(), creditsT: new Map(), creditsX: new Map(), lockedShares: new Map(), activeWithdrawalQueryId: '0', withdrawals: new Map(), pending: new Map(), binLiquidityCapRaw };
  const bins = new Map(dictionary(binDict, Dictionary.Keys.Int(32), binValue));
  for (const id of bins.keys()) binIdValid(id);
  const meta = cell.refs[3], pos = meta.refs[1], accrual = meta.refs[2];
  const positions = positionDictionary(pos.refs[0]), checkpointsT = positionDictionary(accrual.refs[0]), checkpointsX = positionDictionary(accrual.refs[1]);
  const creditsT = positionDictionary(accrual.refs[2]), creditsX = positionDictionary(accrual.refs[3]);
  const pending = new Map([...dictionary(pos.refs[1], Dictionary.Keys.BigUint(256), cellValue)].map(([key, value]) => [keyString(key), readDlmmPendingLiquidityAdd(value)]));
  const ws = pos.refs[2].beginParse(), activeWithdrawalQueryId = ws.loadUintBig(64).toString();
  const withdrawalCells = ws.loadDict(Dictionary.Keys.BigUint(64), cellValue); end(ws);
  const withdrawals = new Map<string, DlmmWithdrawalRecord>();
  for (const [key, value] of withdrawalCells) {
    const row = readDlmmLiquidityWithdrawal(value); if (row.queryId !== key.toString()) throw Error('dlmm_liquidity_withdrawal_identity_invalid'); withdrawals.set(row.queryId, row);
  }
  if (activeWithdrawalQueryId !== '0' && !withdrawals.has(activeWithdrawalQueryId)) throw Error('dlmm_liquidity_active_withdrawal_missing');
  const farm = pos.refs[3].refs[3].refs[0];
  const lockedShares = farm.bits.length || farm.refs.length ? positionDictionary(farm.refs[2]) : new Map<string, string>();
  return { market, bins, feeGrowthGlobalTRaw, feeGrowthGlobalXRaw, positions, checkpointsT, checkpointsX, creditsT, creditsX, lockedShares, activeWithdrawalQueryId, withdrawals, pending, binLiquidityCapRaw };
}

export function dlmmPositionState(state: DlmmLiquidityState, owner: string, binId: number): DlmmLiquidityPosition {
  binIdValid(binId);
  const canonicalOwner = Address.parse(owner).toRawString(), positionKey = beginCell().storeAddress(Address.parse(canonicalOwner)).storeInt(binId, 32).endCell().hash().toString('hex');
  return { positionKey, sharesRaw: state.positions.get(positionKey) || '0', checkpointTRaw: state.checkpointsT.get(positionKey) || '0', checkpointXRaw: state.checkpointsX.get(positionKey) || '0',
    creditedTRaw: state.creditsT.get(positionKey) || '0', creditedXRaw: state.creditsX.get(positionKey) || '0', lockedSharesRaw: state.lockedShares.get(positionKey) || '0' };
}
const emptyBin = (): DlmmLiquidityBin => ({ reserveTRaw: '0', reserveXRaw: '0', sharesRaw: '0', feeGrowthTRaw: '0', feeGrowthXRaw: '0', feeReserveTRaw: '0', feeReserveXRaw: '0', priceInvQ64Raw: '0' });

/** Exact positive-integer division matches Tolk mul_div and integer `/` here.
 * Growth accrual is floored before the requested-share fee fraction is floored. */
export function deriveDlmmLiquidityAmounts(state: DlmmLiquidityState, request: DlmmLiquidityRequest): DlmmLiquidityAmounts {
  if (!request || !['add', 'withdrawal', 'collect-fees'].includes(request.kind)) throw Error('dlmm_liquidity_request_kind_invalid');
  const owner = Address.parse(request.owner).toRawString(); binIdValid(request.binId);
  const beforeBin = { ...(state.bins.get(request.binId) || emptyBin()) }, beforePosition = dlmmPositionState(state, owner, request.binId);
  const afterBin = { ...beforeBin }, afterPosition = { ...beforePosition };
  const supply = raw(beforeBin.sharesRaw), ownerShares = raw(beforePosition.sharesRaw), locked = raw(beforePosition.lockedSharesRaw);
  if (ownerShares > supply || locked > ownerShares) throw Error('dlmm_liquidity_position_supply_invalid');
  const growthT = raw(beforeBin.feeGrowthTRaw), growthX = raw(beforeBin.feeGrowthXRaw), checkpointT = raw(beforePosition.checkpointTRaw), checkpointX = raw(beforePosition.checkpointXRaw);
  if (checkpointT > growthT || checkpointX > growthX) throw Error('dlmm_liquidity_checkpoint_ahead');
  const accruedT = ownerShares && supply ? (growthT - checkpointT) * ownerShares / DLMM_FEE_GROWTH_SCALE : 0n;
  const accruedX = ownerShares && supply ? (growthX - checkpointX) * ownerShares / DLMM_FEE_GROWTH_SCALE : 0n;
  const creditT = raw(beforePosition.creditedTRaw) + accruedT, creditX = raw(beforePosition.creditedXRaw) + accruedX;
  raw(creditT.toString()); raw(creditX.toString());
  afterPosition.checkpointTRaw = growthT.toString(); afterPosition.checkpointXRaw = growthX.toString();
  const reserveT = raw(beforeBin.reserveTRaw, 128), reserveX = raw(beforeBin.reserveXRaw, 128), feeReserveT = raw(beforeBin.feeReserveTRaw, 128), feeReserveX = raw(beforeBin.feeReserveXRaw, 128);
  if (feeReserveT > reserveT || feeReserveX > reserveX) throw Error('dlmm_liquidity_fee_reserve_invalid');
  let principalT = 0n, principalX = 0n, feeT = 0n, feeX = 0n, minted = 0n, burned = 0n;
  if (request.kind === 'add') {
    principalT = raw(request.amountTRaw, 120); principalX = raw(request.amountXRaw, 120); const minimum = raw(request.minSharesRaw);
    const cap = raw(state.binLiquidityCapRaw, 128);
    if (cap && (reserveT + principalT > cap || reserveX + principalX > cap)) throw Error('dlmm_liquidity_bin_cap_exceeded');
    if (!supply) minted = principalT + principalX;
    else {
      const t = reserveT - feeReserveT, x = reserveX - feeReserveX;
      if (!principalT || !principalX || !t || !x) throw Error('dlmm_liquidity_mint_invalid');
      const mt = principalT * supply / t, mx = principalX * supply / x; minted = mt < mx ? mt : mx;
    }
    if (!minted || minted < minimum) throw Error('dlmm_liquidity_mint_invalid');
    afterBin.reserveTRaw = (reserveT + principalT).toString(); afterBin.reserveXRaw = (reserveX + principalX).toString(); afterBin.sharesRaw = (supply + minted).toString();
    afterPosition.sharesRaw = (ownerShares + minted).toString();
    if (afterBin.priceInvQ64Raw === '0') afterBin.priceInvQ64Raw = dlmmLiquidityInversePrice(request.binId, state.market.binSpacing);
  } else {
    Address.parse(request.recipient);
    const shares = raw(request.sharesRaw);
    if (!shares || shares > ownerShares || request.kind === 'withdrawal' && (shares > supply || shares > ownerShares - locked)) throw Error('dlmm_liquidity_share_request_invalid');
    if (request.kind === 'withdrawal') {
      if (!raw(request.queryId, 64) || state.activeWithdrawalQueryId !== '0' || state.withdrawals.has(request.queryId)) throw Error('dlmm_liquidity_withdrawal_not_original');
      burned = shares; principalT = (reserveT - feeReserveT) * shares / supply; principalX = (reserveX - feeReserveX) * shares / supply;
      afterPosition.sharesRaw = (ownerShares - shares).toString(); afterBin.sharesRaw = (supply - shares).toString();
    }
    feeT = creditT * shares / ownerShares; feeX = creditX * shares / ownerShares;
    if (feeT > feeReserveT || feeX > feeReserveX) throw Error('dlmm_liquidity_fee_credit_unfunded');
    afterBin.reserveTRaw = (reserveT - principalT - feeT).toString(); afterBin.reserveXRaw = (reserveX - principalX - feeX).toString();
    afterBin.feeReserveTRaw = (feeReserveT - feeT).toString(); afterBin.feeReserveXRaw = (feeReserveX - feeX).toString();
  }
  afterPosition.creditedTRaw = (creditT - feeT).toString(); afterPosition.creditedXRaw = (creditX - feeX).toString();
  raw(afterBin.reserveTRaw, 128); raw(afterBin.reserveXRaw, 128); raw(afterBin.sharesRaw); raw(afterPosition.sharesRaw);
  const afterFeeClaimedTRaw = (raw(state.market.feeClaimedT, 128) + feeT).toString(), afterFeeClaimedXRaw = (raw(state.market.feeClaimedX, 128) + feeX).toString();
  raw(afterFeeClaimedTRaw, 128); raw(afterFeeClaimedXRaw, 128);
  return { kind: request.kind, owner, binId: request.binId, positionKey: beforePosition.positionKey,
    principalTRaw: principalT.toString(), principalXRaw: principalX.toString(), feeTRaw: feeT.toString(), feeXRaw: feeX.toString(), totalTRaw: (principalT + feeT).toString(), totalXRaw: (principalX + feeX).toString(),
    mintedSharesRaw: minted.toString(), burnedSharesRaw: burned.toString(), accruedTRaw: accruedT.toString(), accruedXRaw: accruedX.toString(), beforePosition, afterPosition, beforeBin, afterBin, afterFeeClaimedTRaw, afterFeeClaimedXRaw };
}

/** Prove the original economic state mutation, independently of the outbound
 * delivery graph. Unchanged shares on a fee collection are intentional. */
export function verifyDlmmLiquidityTransition(before: DlmmLiquidityState, after: DlmmLiquidityState, request: DlmmLiquidityRequest): DlmmLiquidityAmounts {
  const result = deriveDlmmLiquidityAmounts(before, request);
  const same = (a: unknown, b: unknown, code: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(code); };
  for (const field of ['tokenT', 'tokenX', 'treasury', 'router', 'stableAmp', 'routerOperationsHash', 'poolKind', 'binSpacing', 'activeBinId', 'feePips', 'impactCapBps', 'governance', 'controlSeqno', 'walletCodeHash', 'guardHash', 'farmingHash'] as const)
    same(before.market[field], after.market[field], `dlmm_liquidity_changed_${field}`);
  if (before.market.storageForm === 'constructor' && before.market.provenanceHash === null) {
    if (!after.market.provenanceIsDefault) throw Error('dlmm_liquidity_constructor_provenance_changed');
  } else same(before.market.provenanceHash, after.market.provenanceHash, 'dlmm_liquidity_changed_provenanceHash');
  same(before.feeGrowthGlobalTRaw, after.feeGrowthGlobalTRaw, 'dlmm_liquidity_global_growth_changed'); same(before.feeGrowthGlobalXRaw, after.feeGrowthGlobalXRaw, 'dlmm_liquidity_global_growth_changed');
  for (const id of new Set([...before.bins.keys(), ...after.bins.keys()])) if (id !== request.binId) same(before.bins.get(id), after.bins.get(id), 'dlmm_liquidity_other_bin_changed');
  for (const field of ['positions', 'checkpointsT', 'checkpointsX', 'creditsT', 'creditsX', 'lockedShares'] as const)
    for (const id of new Set([...before[field].keys(), ...after[field].keys()])) if (id !== result.positionKey) same(before[field].get(id), after[field].get(id), 'dlmm_liquidity_other_position_changed');
  same(dlmmPositionState(after, request.owner, request.binId), result.afterPosition, 'dlmm_liquidity_position_delta_invalid');
  const actualBin = after.bins.get(request.binId);
  if (!actualBin) throw Error('dlmm_liquidity_after_bin_missing');
  same(actualBin, result.afterBin, 'dlmm_liquidity_bin_delta_invalid');
  same(after.market.feeClaimedT, result.afterFeeClaimedTRaw, 'dlmm_liquidity_claimed_fee_delta_invalid'); same(after.market.feeClaimedX, result.afterFeeClaimedXRaw, 'dlmm_liquidity_claimed_fee_delta_invalid');
  if (request.kind !== 'add') same(before.market.pendingHash, after.market.pendingHash, 'dlmm_liquidity_pending_changed');
  if (request.kind === 'withdrawal') {
    const row = after.withdrawals.get(request.queryId);
    if (!row || row.owner !== result.owner || row.recipient !== Address.parse(request.recipient).toRawString() || row.binId !== request.binId || row.sharesRaw !== request.sharesRaw || row.totalTRaw !== result.totalTRaw || row.totalXRaw !== result.totalXRaw)
      throw Error('dlmm_liquidity_withdrawal_economics_invalid');
    if (after.withdrawals.size !== before.withdrawals.size + 1) throw Error('dlmm_liquidity_withdrawal_count_invalid');
    const positiveT = result.totalTRaw !== '0', positiveX = result.totalXRaw !== '0';
    if (row.legT !== (positiveT ? 0 : 1) || row.legX !== (positiveX ? 0 : 1) ||
      positiveT !== (row.settlementTId !== '0') || positiveX !== (row.settlementXId !== '0') ||
      after.activeWithdrawalQueryId !== (positiveT || positiveX ? request.queryId : '0') ||
      row.completionFundedRaw !== (positiveT || positiveX ? '50000000' : '0')) throw Error('dlmm_liquidity_original_withdrawal_stage_invalid');
    for (const [id, record] of before.withdrawals) same(record, after.withdrawals.get(id), 'dlmm_liquidity_other_withdrawal_changed');
  } else if (request.kind === 'add' && before.market.storageForm === 'constructor') {
    if (after.withdrawals.size || after.activeWithdrawalQueryId !== '0') throw Error('dlmm_liquidity_constructor_withdrawals_created');
  } else same(before.market.withdrawalsHash, after.market.withdrawalsHash, 'dlmm_liquidity_withdrawals_changed');
  return result;
}
