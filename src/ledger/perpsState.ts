import { Address, beginCell, Cell, Dictionary, type Slice } from "@ton/core";
import { perpsOpenNotification, perpsPositionKey, perpsRequest, perpsTransferKey, PERPS_ORACLE_REFRESH_VALUE, PERPS_RISK_ADMISSION_VALUE, type PerpsRequest } from "./perpsWire";
import { decodeNativeFundingContext, type NativeFundingContext } from './nativeFunding';
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Unsupported perps state layout");
};
const rawValue = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: Slice) => {
    const c = s.asCell();
    s.skip(s.remainingBits);
    while (s.remainingRefs) s.loadRef();
    return c;
  },
};
export type PerpsAccount = {
  collateralRaw: string;
  pendingFundingRaw: string;
  referralLinked: number;
  openPositionCount: number;
};
export type PerpsPosition = {
  owner: string;
  marketId: number;
  sizeRaw: string;
  marginRaw: string;
  entryNotionalRaw: string;
  lastFundingIndexRaw: string;
  counterparty: { reservedRaw: string; pendingFundingRaw: string; collectedLossRaw: string };
};

export function readPerpsPosition(cell: Cell): PerpsPosition {
  const s = cell.beginParse();
  const position = {
    owner: s.loadAddress().toRawString(), marketId: s.loadUint(32), sizeRaw: s.loadIntBig(128).toString(),
    marginRaw: s.loadCoins().toString(), entryNotionalRaw: s.loadCoins().toString(),
    lastFundingIndexRaw: s.loadIntBig(128).toString(),
    counterparty: { reservedRaw: '0', pendingFundingRaw: '0', collectedLossRaw: '0' },
  };
  const counterparty = s.loadRef().beginParse();
  position.counterparty = { reservedRaw: counterparty.loadCoins().toString(),
    pendingFundingRaw: counterparty.loadCoins().toString(), collectedLossRaw: counterparty.loadCoins().toString() };
  end(counterparty); end(s);
  return position;
}
export type PerpsPending = {
  kind: number;
  owner: string | null;
  marketId: number;
  wireId: string;
  amountRaw: string;
  queuedRaw: string;
  recordedAt: string;
};
export type PerpsMarket = {
  pool: string;
  depthRaw: string;
  alphaRaw: string;
  betaRaw: string;
  maxLeverageBps: number;
  maintenanceBps: number;
  fundingIndexRaw: string;
  fundingRemainderRaw: string;
  fundingRateBpsRaw: string;
  fundingValidUntil: string;
  lastFundingTs: string;
  oraclePriceHealthy: boolean;
  markRaw: string;
  controlFeeDeltaBps: number;
  clampBps: number;
  adlDeficitRaw: string;
  riskPolicy: PerpsRiskPolicy | null;
};
export type PerpsRiskPolicy = {
  controller: string; policyId: number; scope: number; registrationVersion: number; leaseSecs: number;
  epoch: string; sourceVersion: number; configVersion: number; validUntil: string;
  grossBudget: string; consumedGross: string; posture: number; flags: number;
};
export function readPerpsRiskPolicy(cell: Cell): PerpsRiskPolicy | null {
  if (!cell.bits.length && !cell.refs.length) return null;
  const s = cell.beginParse();
  const policy = { controller: s.loadAddress().toRawString(), policyId: s.loadUint(32), scope: s.loadUint(32),
    registrationVersion: s.loadUint(32), leaseSecs: s.loadUint(32), epoch: s.loadUintBig(64).toString(),
    sourceVersion: s.loadUint(32), configVersion: s.loadUint(32), validUntil: s.loadIntBig(64).toString(),
    grossBudget: s.loadUintBig(64).toString(), consumedGross: s.loadUintBig(64).toString(), posture: s.loadUint(8), flags: s.loadUint(8) };
  end(s);
  if (!policy.policyId || !policy.registrationVersion || !policy.leaseSecs || policy.leaseSecs > 120 ||
      BigInt(policy.validUntil) < 0n || policy.posture > 4 || policy.flags > 7) throw Error('Invalid perps risk policy');
  return policy;
}
export type PerpsOracleRefreshReceipt = {
  queryId: string;
  wireQueryId: string;
  requestHash: string;
  status: number;
  requestedAt: string;
  completedAt: string;
  oracleMarkRaw: string;
  oracleMarkTs: string;
  order: PerpsOracleTradeOrder | null;
};
export type PerpsOracleTradeOrder = {
  request: PerpsRequest;
  requestCell: Cell;
  notification: Cell;
  funding: ReturnType<typeof perpsOpenNotification>;
  nativeBudgetRaw: string;
  outcome: number;
  reason: number;
  admissionPhase: number;
  previousPosition: Cell;
  pool: string;
};

export function readPerpsOracleRefreshes(cell: Cell): Map<string, PerpsOracleRefreshReceipt> {
  const receipts = new Map<string, PerpsOracleRefreshReceipt>();
  const s = cell.beginParse();
  if (!s.remainingBits && !s.remainingRefs) return receipts;
  const count = s.loadUint(16);
  const nextWireQueryId = s.loadUintBig(64);
  const wireQueryIds = new Set<string>();
  const index = s.loadDict(Dictionary.Keys.BigUint(128), rawValue);
  if (count > 128 || nextWireQueryId === 0n || index.size > count) throw Error('Invalid perps oracle journal capacity');
  const eligible = new Map<string, bigint>();
  for (const [key, value] of index) {
    const owner = value.beginParse();
    const address = owner.loadAddress().toRawString();
    end(owner);
    if (key === 0n || eligible.has(address)) throw Error('Invalid perps oracle eligibility index');
    eligible.set(address, key);
  }
  const entries = s.loadDict(Dictionary.Keys.Address(), rawValue);
  const wireOwners = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Address());
  if (wireOwners.size !== count) throw Error('Perps oracle wire index count mismatch');
  for (const [owner, value] of entries) {
    const receipt = value.beginParse();
    const queryId = receipt.loadUintBig(64).toString();
    const wireQueryId = receipt.loadUintBig(64).toString();
    const requestHash = receipt.loadUintBig(256).toString(16).padStart(64, '0');
    const status = receipt.loadUint(8);
    const requestedAt = receipt.loadIntBig(64).toString();
    const completedAt = receipt.loadIntBig(64).toString();
    const oracleMarkRaw = receipt.loadCoins().toString();
    const oracleMarkTs = receipt.loadIntBig(64).toString();
    const orderCell = receipt.loadRef();
    end(receipt);
    if (queryId === '0' || wireQueryId === '0' || BigInt(wireQueryId) >= nextWireQueryId ||
        wireQueryIds.has(wireQueryId) || !wireOwners.get(BigInt(wireQueryId))?.equals(owner) || status < 1 || status > 4 || BigInt(requestedAt) < 0n ||
        BigInt(completedAt) < 0n || BigInt(oracleMarkTs) < 0n ||
        (status === 1 && (completedAt !== '0' || oracleMarkRaw !== '0' || oracleMarkTs !== '0')) ||
        (status !== 1 && BigInt(completedAt) < BigInt(requestedAt)) ||
        (status === 2 && (oracleMarkRaw === '0' || oracleMarkTs === '0'))) {
      throw Error('Invalid perps oracle refresh receipt');
    }
    let order: PerpsOracleTradeOrder | null = null;
    if (orderCell.bits.length || orderCell.refs.length) {
      const value = orderCell.beginParse(), requestCell = value.loadRef(), notification = value.loadRef();
      const nativeBudgetRaw = value.loadCoins().toString(), outcome = value.loadUint(8), reason = value.loadUint(8), admissionPhase = value.loadUint(8);
      const pool = value.loadAddress().toRawString(), previousPosition = value.loadRef();
      end(value);
      const request = perpsRequest(requestCell), funding = perpsOpenNotification(notification);
      const hasNotification = notification.bits.length !== 0 || notification.refs.length !== 0;
      if (request?.operation === 'modify') {
        const previous = readPerpsPosition(previousPosition);
        if (previous.owner !== owner.toRawString() || previous.marketId !== request.marketId || previous.sizeRaw === '0')
          throw Error('Perps modify prior position is not its exact owner and market');
      } else end(previousPosition.beginParse());
      if (!request || !['open', 'modify', 'close'].includes(request.operation) || request.queryId !== queryId ||
          (request.operation === 'close' && (request.sizeRaw !== '0' || hasNotification || admissionPhase !== 0)) ||
          (request.operation === 'open' && !hasNotification) ||
          (request.operation === 'modify' && (BigInt(request.marginRaw!) > 0n) !== hasNotification) ||
          (hasNotification ? !funding || funding.owner !== owner.toRawString() ||
            JSON.stringify(funding.request) !== JSON.stringify(request) || notification.hash().toString('hex') !== requestHash ||
            BigInt(funding.forwardTonRaw) !== BigInt(nativeBudgetRaw) + PERPS_ORACLE_REFRESH_VALUE + PERPS_RISK_ADMISSION_VALUE
            : requestCell.hash().toString('hex') !== requestHash) ||
          admissionPhase > 2 || ![1, 2, 3].includes(outcome) ||
          (outcome === 1 && (reason !== 0 || (admissionPhase === 0 ? status !== 1 : status !== 2))) ||
          (outcome === 2 && (status !== 2 || reason !== 0 || (request.operation !== 'close' && admissionPhase !== 2))) ||
          (outcome === 3 && !((status === 2 && [2, 5, 6, 8].includes(reason)) ||
            (status === 3 && [1, 7, 8].includes(reason)) || (status === 4 && [3, 7, 8].includes(reason)))) ||
          (reason === 8 && admissionPhase === 0)) {
        throw Error('Invalid perps paid oracle order');
      }
      order = { request, requestCell, notification, funding, nativeBudgetRaw, outcome, reason, admissionPhase, previousPosition, pool };
    }
    const key = order?.outcome === 1 ? null :
      ((status === 1 ? BigInt(requestedAt) + 300n : 0n) << 64n) | BigInt(wireQueryId);
    if (key === null ? eligible.has(owner.toRawString()) : eligible.get(owner.toRawString()) !== key) {
      throw Error('Perps oracle eligibility does not match the exact receipt');
    }
    eligible.delete(owner.toRawString());
    wireQueryIds.add(wireQueryId);
    receipts.set(owner.toRawString(), { queryId, wireQueryId, requestHash, status, requestedAt, completedAt, oracleMarkRaw, oracleMarkTs, order });
  }
  end(s);
  if (receipts.size !== count || eligible.size !== 0) throw Error('Perps oracle journal count/index does not match receipts');
  return receipts;
}

/** The immutable original order survives the pending-to-terminal callback. */
export function perpsOracleTradeTransition(before: PerpsState, after: PerpsState, owner: string, request: PerpsRequest) {
  const prior = before.oracleRefreshes.get(request.marketId)?.get(owner);
  const next = after.oracleRefreshes.get(request.marketId)?.get(owner);
  if (!prior?.order || !next?.order || prior.order.outcome !== 1 || ![2, 3].includes(next.order.outcome) ||
      ![1, 2].includes(prior.status) || next.status === 1 || prior.queryId !== request.queryId || next.queryId !== request.queryId ||
      prior.wireQueryId !== next.wireQueryId || prior.requestHash !== next.requestHash || prior.requestedAt !== next.requestedAt ||
      !prior.order.requestCell.hash().equals(next.order.requestCell.hash()) ||
      !prior.order.notification.hash().equals(next.order.notification.hash()) ||
      !prior.order.previousPosition.hash().equals(next.order.previousPosition.hash()) ||
      prior.order.admissionPhase > next.order.admissionPhase ||
      prior.order.nativeBudgetRaw !== next.order.nativeBudgetRaw ||
      prior.order.pool !== next.order.pool ||
      JSON.stringify(next.order.request) !== JSON.stringify(request)) return null;
  return { before: prior, after: next };
}

export type PerpsState = {
  root: string;
  walletCode: Cell;
  feeBps: number;
  feeTreasury: string | null;
  router: string | null;
  riskVault: string | null;
  riskVaultBucketId: number;
  risk: { oracleDegraded: boolean; tvlDegraded: boolean; oracleDriftLevel: number };
  riskNonce: string;
  riskActions: Map<string, PerpsRiskAction>;
  nativeSettlement: { funding: NativeFundingContext; queryId: string; amountRaw: string;
    recipient: string; requestHash: string; remainingRaw: string } | null;
  counterpartyMaintenance: { cursor: string; sequence: string; positionCount: number };
  configHash: string;
  dataHash: string;
  accounts: Map<string, PerpsAccount>;
  positions: Map<string, PerpsPosition>;
  markets: Map<number, PerpsMarket>;
  pending: Map<string, PerpsPending>;
  oracleRefreshes: Map<number, Map<string, PerpsOracleRefreshReceipt>>;
};
export type PerpsRiskAction = {
  kind: number; status: number; actionId: string; previousActionId: string; subjectId: string; requestHash: string;
  queuedAmountRaw: string; settledAmountRaw: string; recordedAt: string; requestBody: Cell; continuation: Cell;
};
export function perpsRiskActionKey(kind: number, subjectId: string) {
  return beginCell().storeUint(0x52565342, 32).storeUint(kind, 8).storeUint(BigInt(`0x${subjectId}`), 256)
    .endCell().hash().toString('hex');
}
export function perpsRiskAction(state: PerpsState, kind: number, subjectId: string) {
  return state.riskActions.get(perpsRiskActionKey(kind, subjectId)) ?? null;
}
export const emptyPerpsAccount = (): PerpsAccount => ({
  collateralRaw: "0",
  pendingFundingRaw: "0",
  referralLinked: 0,
  openPositionCount: 0,
});
export function readPerpsState(boc: string, qualifiedCodeHash: string): PerpsState {
  if (!/^[0-9a-f]{64}$/.test(qualifiedCodeHash)) throw Error('Perps code identity is required');
  const cell = Cell.fromBase64(boc),
    s = cell.beginParse();
  if (s.remainingRefs !== 4) throw Error("Perps storage refs");
  const registry = s.loadRef(),
    maps = s.loadRef();
  s.skip(32 + 64 + 32 + 32 + 32 + 64 + 32 + 32 + 32 + 64 + 32);
  s.loadMaybeAddress();
  s.skip(32 + 64);
  const queues = s.loadRef();
  const guard = s.loadRef().beginParse();
  end(s);
  if (guard.remainingBits !== 767 || guard.remainingRefs !== 1)
    throw Error('Perps canonical risk guard layout');
  const oracleDegraded = guard.loadBoolean(), tvlDegraded = guard.loadBoolean();
  guard.skip(1 + 16 + 32 + 64 * 5 + 2);
  const oracleDriftLevel = guard.loadUint(8);
  guard.skip(32 * 3 + 64 + 32 + 2 + 32 * 6);
  const riskAmounts = guard.loadRef().beginParse();
  for (let index = 0; index < 6; index += 1) riskAmounts.loadCoins();
  end(riskAmounts); end(guard);
  const risk = { oracleDegraded, tvlDegraded, oracleDriftLevel };
  const reg = registry.beginParse();
  if (reg.remainingBits !== 0 || reg.remainingRefs !== 4) throw Error('Perps canonical registry references');
  reg.loadRef();
  const config = reg.loadRef();
  reg.loadRef();
  const maintenance = reg.loadRef().beginParse();
  const counterpartyMaintenance = { cursor: maintenance.loadUintBig(256).toString(16).padStart(64, '0'),
    sequence: maintenance.loadUintBig(64).toString(), positionCount: maintenance.loadUint(16) };
  end(maintenance);
  if (counterpartyMaintenance.positionCount > 128) throw Error('Perps position capacity exceeded');
  end(reg);
  const cfg = config.beginParse();
  for (let i = 0; i < 4; i++) cfg.loadMaybeAddress();
  const feeBps = cfg.loadUint(32);
  cfg.skip(64 + 32 + 32);
  const routerCell = cfg.loadRef();
  cfg.loadRef();
  cfg.loadRef();
  cfg.loadRef();
  if (cfg.loadUint(32) !== 1) throw Error("Perps config version");
  end(cfg);
  const r = routerCell.beginParse(),
    router = r.loadMaybeAddress()?.toRawString() ?? null;
  r.loadMaybeAddress();
  const feeTreasury = r.loadMaybeAddress()?.toRawString() ?? null,
    extras = r.loadRef().beginParse();
  end(r);
  const mask = extras.loadUint(8);
  if (mask & 96) throw Error("Perps unsupported registration hints");
  if (mask & 1 || !(mask & 128)) throw Error("Perps configured collateral");
  if (mask & 2) extras.loadMaybeAddress();
  if (mask & 4) extras.skip(32);
  const riskVault =
    mask & 8 ? (extras.loadMaybeAddress()?.toRawString() ?? null) : null;
  const riskVaultBucketId = mask & 16 ? extras.loadUint(16) : 0;
  const token = extras.loadRef().beginParse(),
    root = token.loadAddress().toRawString(),
    walletCode = token.loadRef();
  end(token);
  end(extras);
  const m = maps.beginParse(),
    marketCell = m.loadRef(),
    accountCell = m.loadRef(),
    positionCell = m.loadRef();
  end(m);
  const accounts = new Map<string, PerpsAccount>();
  for (const [key, value] of accountCell
    .beginParse()
    .loadDict(Dictionary.Keys.Address(), rawValue)) {
    const a = value.beginParse();
    const v = {
      collateralRaw: a.loadCoins().toString(),
      pendingFundingRaw: a.loadIntBig(128).toString(),
      referralLinked: a.loadUint(8),
      openPositionCount: a.loadUint(32),
    };
    end(a);
    accounts.set(key.toRawString(), v);
  }
  const positions = new Map<string, PerpsPosition>();
  for (const [key, value] of positionCell
    .beginParse()
    .loadDict(Dictionary.Keys.BigUint(256), rawValue)) {
    const v = readPerpsPosition(value);
    const id = key.toString(16).padStart(64, "0");
    if (id !== perpsPositionKey(v.owner, v.marketId))
      throw Error("Perps owner/position key mismatch");
    positions.set(id, v);
  }
  const markets = new Map<number, PerpsMarket>();
  if (positions.size !== counterpartyMaintenance.positionCount) throw Error('Perps maintained position count differs from actual positions');
  const oracleRefreshes = new Map<number, Map<string, PerpsOracleRefreshReceipt>>();
  for (const [key, value] of marketCell
    .beginParse()
    .loadDict(Dictionary.Keys.Uint(32), rawValue)) {
    const c = value.beginParse(),
      pool = c.loadAddress().toRawString(),
      p = c.loadRef().beginParse(),
      st = c.loadRef().beginParse();
    end(c);
    const depthRaw = p.loadCoins().toString(),
      alphaRaw = p.loadIntBig(128).toString(),
      betaRaw = p.loadIntBig(128).toString();
    const maxLeverageBps = p.loadUint(32), maintenanceBps = p.loadUint(32);
    p.loadCoins();
    p.skip(32);
    p.loadCoins();
    p.skip(64 + 32);
    end(p);
    if (st.remainingBits !== 353 || st.remainingRefs !== 4)
      throw Error('Perps canonical market stats layout');
    const fundingIndexRaw = st.loadIntBig(128).toString();
    const lastFundingTs = st.loadIntBig(64).toString();
    st.loadBoolean();
    st.loadIntBig(64);
    const oracleMarkTs = st.loadIntBig(64);
    st.loadUint(32);
    const amounts = st.loadRef().beginParse();
    amounts.loadCoins();
    amounts.loadCoins();
    amounts.loadCoins();
    const markRaw = amounts.loadCoins().toString();
    const adlDeficitRaw = amounts.loadCoins().toString();
    amounts.loadCoins();
    amounts.loadCoins();
    end(amounts);
    const extra = st.loadRef().beginParse();
    const refreshes = readPerpsOracleRefreshes(st.loadRef());
    const fundingAndRisk = st.loadRef().beginParse();
    if (fundingAndRisk.remainingBits !== 0 || fundingAndRisk.remainingRefs !== 2)
      throw Error('Perps canonical funding/risk references');
    const fundingAccrual = fundingAndRisk.loadRef().beginParse();
    const riskPolicy = readPerpsRiskPolicy(fundingAndRisk.loadRef());
    end(fundingAndRisk); end(st);
    if (riskPolicy && riskPolicy.scope !== key) throw Error('Perps risk policy belongs to another market');
    const fundingRemainderRaw = fundingAccrual.loadIntBig(64).toString();
    const oraclePriceHealthy = fundingAccrual.loadBoolean();
    const fundingRateBpsRaw = fundingAccrual.loadIntBig(128).toString();
    const fundingValidUntil = fundingAccrual.loadIntBig(64).toString();
    end(fundingAccrual);
    if (BigInt(fundingRemainderRaw) < 0n || BigInt(fundingRemainderRaw) >= 3600n)
      throw Error('Invalid perps funding accrual remainder');
    if (BigInt(lastFundingTs) < 0n || oracleMarkTs < 0n || BigInt(fundingValidUntil) < 0n)
      throw Error('Invalid perps funding checkpoint timestamp');
    for (const receipt of refreshes.values()) if (receipt.order && receipt.order.request.marketId !== key)
      throw Error('Perps paid order belongs to another market');
    oracleRefreshes.set(key, refreshes);
    extra.skip(32 * 3);
    const controlFeeDeltaBps = extra.loadInt(32),
      clampBps = extra.loadUint(32);
    extra.skip(64 + 1);
    extra.loadCoins();
    extra.loadCoins();
    extra.loadCoins();
    extra.skip(64);
    extra.loadCoins();
    const hashes = extra.loadRef().beginParse();
    hashes.skip(256 + 256);
    end(hashes);
    end(extra);
    markets.set(key, {
      pool,
      depthRaw,
      alphaRaw,
      betaRaw,
      maxLeverageBps,
      maintenanceBps,
      fundingIndexRaw,
      fundingRemainderRaw,
      fundingRateBpsRaw,
      fundingValidUntil,
      lastFundingTs,
      oraclePriceHealthy,
      markRaw,
      controlFeeDeltaBps,
      clampBps,
      adlDeficitRaw,
      riskPolicy,
    });
  }
  const q = queues.beginParse();
  if (q.remainingBits !== 0 || q.remainingRefs !== 3) throw Error('Perps canonical queue bundle');
  q.loadRef();
  const pendingCell = q.loadRef();
  const queueTail = q.loadRef().beginParse();
  end(q);
  queueTail.loadRef();
  const feeRouting = queueTail.loadRef().beginParse(); end(queueTail);
  feeRouting.skip(64); feeRouting.loadRef();
  const protocol = feeRouting.loadRef().beginParse();
  feeRouting.loadRef(); feeRouting.loadCoins(); feeRouting.skip(64);
  feeRouting.loadCoins(); feeRouting.loadCoins(); feeRouting.loadCoins(); feeRouting.skip(64); end(feeRouting);
  const riskNonce = protocol.loadUintBig(64).toString();
  const riskActions = new Map<string, PerpsRiskAction>();
  for (const [key, cell] of protocol.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())) {
    const a = cell.beginParse();
    const action = { kind: a.loadUint(8), status: a.loadUint(8), actionId: a.loadUintBig(64).toString(),
      previousActionId: a.loadUintBig(64).toString(), subjectId: a.loadUintBig(256).toString(16).padStart(64, '0'),
      requestHash: a.loadUintBig(256).toString(16).padStart(64, '0'), queuedAmountRaw: a.loadCoins().toString(),
      settledAmountRaw: a.loadCoins().toString(), recordedAt: a.loadIntBig(64).toString(),
      requestBody: a.loadRef(), continuation: a.loadRef() };
    end(a);
    const hex = key.toString(16).padStart(64, '0');
    const idKey = beginCell().storeUint(0x52564944, 32).storeUint(action.kind, 8).storeUint(BigInt(action.actionId), 64)
      .endCell().hash().toString('hex');
    if (![1, 2].includes(action.kind) || ![1, 2, 4].includes(action.status) || BigInt(action.actionId) > BigInt(riskNonce) ||
        !BigInt(action.actionId) || action.requestHash !== action.requestBody.hash().toString('hex') ||
        (hex !== idKey && hex !== perpsRiskActionKey(action.kind, action.subjectId))) throw Error('Invalid perps risk action journal');
    riskActions.set(hex, action);
  }
  // EngineProtocolJournal stores its trailing `cell` as one exact reference,
  // including the canonical empty settlement cell. No inline/omitted fallback
  // is accepted for retired layouts.
  const nativeCell = protocol.loadRef();
  let nativeSettlement: PerpsState['nativeSettlement'] = null;
  if (nativeCell.bits.length || nativeCell.refs.length) {
    const native = nativeCell.beginParse();
    const funding = decodeNativeFundingContext(native.loadRef());
    const queryId = native.loadUintBig(64).toString(), amountRaw = native.loadCoins().toString();
    const recipient = native.loadAddress().toRawString(), requestHash = native.loadUintBig(256).toString(16).padStart(64, '0');
    const remainingRaw = native.loadCoins().toString(); end(native);
    if (queryId === '0' || amountRaw === '0') throw Error('Invalid perps native settlement identity');
    nativeSettlement = { funding, queryId, amountRaw, recipient, requestHash, remainingRaw };
  }
  end(protocol);
  const pending = new Map<string, PerpsPending>();
  for (const [key, value] of pendingCell
    .beginParse()
    .loadDict(Dictionary.Keys.BigUint(256), rawValue)) {
    const p = value.beginParse(),
      v = {
        kind: p.loadUint(8),
        owner: p.loadMaybeAddress()?.toRawString() ?? null,
        marketId: p.loadUint(32),
        wireId: p.loadUintBig(64).toString(),
        amountRaw: p.loadCoins().toString(),
        queuedRaw: p.loadCoins().toString(),
        recordedAt: p.loadIntBig(64).toString(),
      };
    end(p);
    pending.set(key.toString(16).padStart(64, "0"), v);
  }
  return {
    root,
    walletCode,
    feeBps,
    router,
    feeTreasury,
    riskVault,
    riskVaultBucketId,
    risk,
    riskNonce,
    riskActions,
    nativeSettlement,
    counterpartyMaintenance,
    configHash: config.hash().toString("hex"),
    dataHash: cell.hash().toString("hex"),
    accounts,
    positions,
    markets,
    pending,
    oracleRefreshes,
  };
}
export const perpsAccount = (s: PerpsState, owner: string) =>
  s.accounts.get(owner) ?? emptyPerpsAccount();
export const perpsPosition = (s: PerpsState, owner: string, marketId: number) =>
  s.positions.get(perpsPositionKey(owner, marketId)) ?? null;
export const perpsPending = (s: PerpsState, wallet: string) =>
  s.pending.get(perpsTransferKey(wallet)) ?? null;
