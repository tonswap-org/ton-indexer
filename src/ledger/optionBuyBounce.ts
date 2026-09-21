import { beginCell } from "@ton/core";
import type { Flow, Node, ProjectionInput } from "./project";
import { optionBoundary } from "./optionLifecycle";
import { readOptionFactoryConfig, type OptionFactorySeries } from "./optionLifecycleState";
import { optionFactoryMatches, optionPositionAt, sameOptionPrincipal, proveOptionAbortOrigin } from "./optionAbortOrigin";
import { createOptionAbortRecord } from "./optionAbortRecord";
import { BUY, optionInitialBuyBounce } from "./optionAbortWire";
import { proveFactoryAbortReturn } from "./optionAbortCash";
import { optionRef as ref, optionTransactionSucceeded, optionUnique } from "./optionCash";
import { bodyCell } from "./wire";
import { canonicalLedgerAddress } from "./normalize";

const addr = (value?: string) => {
  try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; }
};
type FactoryState = ReturnType<typeof readOptionFactoryConfig>;
const unchangedSeries = (a: OptionFactorySeries, b: OptionFactorySeries, allocation = false) =>
  (Object.keys(a) as Array<keyof OptionFactorySeries>).every(key =>
    key === "stateHash" || key === "openNotionalRaw" || key === "collateralLockedRaw" ||
    (allocation && key === "nextTokenId") || (key === "writer" ? JSON.stringify(a.writer) === JSON.stringify(b.writer) : a[key] === b[key]));
function unchangedOtherSeries(a: FactoryState, b: FactoryState, own: string) {
  return a.series.size === b.series.size && [...a.series].every(([id, series]) =>
    id === own || series.stateHash === b.series.get(id)?.stateHash);
}
function indexTransition(a: FactoryState, b: FactoryState, wire: bigint, key: bigint, allocating: boolean) {
  const before = a.seriesBuyIndex, after = b.seriesBuyIndex;
  return allocating
    ? !before.has(wire) && after.get(wire) === key && after.size === before.size + 1 &&
      [...before].every(([id, value]) => after.get(id) === value)
    : before.get(wire) === key && !after.has(wire) && before.size === after.size + 1 &&
      [...after].every(([id, value]) => before.get(id) === value);
}
/** A qualified, failed initial product transaction can cause an automatic
 * unwind. Its actual VM bounce and the exact factory state transition prove
 * cancellation; only the independent wallet finalizer proves returned cash. */
export async function decodeInitialOptionBuyBounce(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  original: NonNullable<Awaited<ReturnType<typeof proveOptionAbortOrigin>>>,
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const { factory: f, series, payload, buy, position, reservation, product } = original,
    assigned = bodyCell(reservation.raw.inMessage),
    wire = BigInt(buy.wireId), key = (BigInt(payload.seriesId) << 64n) | BigInt(buy.positionId),
    allocationBefore = original.state.before.series.get(payload.seriesId),
    allocationAfter = original.state.after.series.get(payload.seriesId);
  if (reservation.raw.status !== "failed" || reservation.raw.success || reservation.raw.inMessage?.bounced ||
    addr(reservation.raw.inMessage?.source) !== f.address || addr(reservation.raw.inMessage?.destination) !== series.address ||
    BigInt(reservation.raw.lt) <= BigInt(original.origin.raw.lt) || !assigned || assigned.bits.length < 256 ||
    wire >= 0xfffffffffffffffen || position.walletFundingRaw !== "360000000" ||
    product.before.dataHash !== product.after.dataHash || product.before.position || product.after.position ||
    !allocationBefore || !allocationAfter ||
    [allocationBefore, allocationAfter].some(s => s.kind !== series.kind || s.optionAddress !== series.address) ||
    !unchangedSeries(allocationBefore, allocationAfter, true) ||
    !unchangedOtherSeries(original.state.before, original.state.after, payload.seriesId) ||
    !indexTransition(original.state.before, original.state.after, wire, key, true) ||
    original.state.before.nextBuyWireId !== buy.wireId ||
    BigInt(original.state.after.nextBuyWireId) !== wire + 1n ||
    original.state.before.activeBuyKey !== original.state.after.activeBuyKey ||
    allocationBefore.nextTokenId !== buy.positionId ||
    BigInt(allocationAfter.nextTokenId) !== BigInt(buy.positionId) + 1n ||
    BigInt(allocationAfter.openNotionalRaw) - BigInt(allocationBefore.openNotionalRaw) !== BigInt(position.notionalRaw) ||
    BigInt(allocationAfter.collateralLockedRaw) - BigInt(allocationBefore.collateralLockedRaw) !== BigInt(position.collateralRaw)) return null;

  const expectedBounce = beginCell().storeUint(0xffffffff, 32).storeBits(assigned.beginParse().loadBits(256)).endCell(),
    matches = reservation.raw.outMessages.flatMap((message, index) => {
      const bounce = optionInitialBuyBounce(message), recovery = receiptFor(reservation, index);
      return bounce && bounce.opcode === buy.op && bounce.wireId === buy.wireId &&
        bodyCell(message)?.equals(expectedBounce) && addr(message.source) === series.address &&
        addr(message.destination) === f.address && recovery?.account === f.address &&
        optionTransactionSucceeded(recovery) && recovery.raw.inMessage?.bounced &&
        bodyCell(recovery.raw.inMessage)?.equals(expectedBounce) &&
        BigInt(recovery.raw.lt) > BigInt(reservation.raw.lt) ? [{ bounce, recovery }] : [];
    });
  if (matches.length !== 1) return null;
  const { bounce, recovery } = matches[0],
    boundary = await optionBoundary(input, recovery, f.qualification!.factoryCodeHash, readOptionFactoryConfig),
    before = boundary && optionPositionAt(boundary.beforeBoc, payload.seriesId, buy.positionId),
    after = boundary && optionPositionAt(boundary.afterBoc, payload.seriesId, buy.positionId),
    beforeSeries = boundary?.before.series.get(payload.seriesId),
    afterSeries = boundary?.after.series.get(payload.seriesId);
  if (!boundary || !before || !after || !beforeSeries || !afterSeries ||
    ![boundary.before, boundary.after].every(s => optionFactoryMatches(s, f)) ||
    ![before, after].every(p => sameOptionPrincipal(p, position) && p.custodyWireId === position.custodyWireId &&
      !p.settlementReady && p.settlementPayoutRaw === "0") ||
    before.settled || before.buyStateRaw !== "0" || before.refundWireId !== "0" || !after.settled ||
    before.walletFundingRaw !== position.walletFundingRaw ||
    [beforeSeries, afterSeries].some(s => s.kind !== series.kind || s.optionAddress !== series.address) ||
    !unchangedSeries(beforeSeries, afterSeries) || !unchangedOtherSeries(boundary.before, boundary.after, payload.seriesId) ||
    !indexTransition(boundary.before, boundary.after, wire, key, false) ||
    BigInt(beforeSeries.openNotionalRaw) - BigInt(afterSeries.openNotionalRaw) !== BigInt(position.notionalRaw) ||
    BigInt(beforeSeries.collateralLockedRaw) - BigInt(afterSeries.collateralLockedRaw) !== BigInt(position.collateralRaw)) return null;

  const dispatching = boundary.before.activeBuyKey === "0" && BigInt(before.walletFundingRaw) >= 180000000n,
    nextWire = BigInt(boundary.before.nextBuyWireId), abortFlags = BUY.ABORTING | BUY.CANCELLED;
  if (dispatching ?
    nextWire <= 0n || nextWire >= 0xffffffffffffffffn ||
      BigInt(after.buyStateRaw) !== (abortFlags | BUY.REFUND_IN_FLIGHT) ||
      after.refundWireId !== nextWire.toString() || BigInt(boundary.after.nextBuyWireId) !== nextWire + 1n ||
      boundary.after.activeBuyKey !== key.toString() ||
      BigInt(before.walletFundingRaw) - BigInt(after.walletFundingRaw) !== 140000000n
    : BigInt(after.buyStateRaw) !== abortFlags || after.refundWireId !== "0" ||
      boundary.after.nextBuyWireId !== boundary.before.nextBuyWireId ||
      boundary.after.activeBuyKey !== boundary.before.activeBuyKey || after.walletFundingRaw !== before.walletFundingRaw) return null;

  const capacity = (value: OptionFactorySeries) => ({ kind: series.kind, optionAddress: series.address,
    openNotionalRaw: value.openNotionalRaw, collateralLockedRaw: value.collateralLockedRaw }),
    record = createOptionAbortRecord(input, nodes, flows, original, recovery, boundary.evidence, before, after, {
      kind: "initial_series_buy_bounced", ...bounce, originalMessageBodyHash: assigned.hash().toString("hex"),
      failedTransaction: ref(reservation), recoveryTransaction: ref(recovery),
      factoryUnwind: { seriesBuyIndexBefore: key.toString(), seriesBuyIndexAfter: null,
        beforeSeries: capacity(beforeSeries), afterSeries: capacity(afterSeries) },
    }, receiptFor, attach), { meta, unwind } = record;
  const productEvidence = { ...product.evidence, bodyHash: assigned.hash().toString("hex") };
  unwind.reservationStateEvidence = productEvidence;
  unwind.cancellation = { status: "completed", evidence: [ref(reservation), ref(recovery)],
    stateEvidence: { ...boundary.evidence, bodyHash: bounce.bodyHash } };
  meta.productBefore = product.before;
  meta.productAfter = product.after;
  meta.productEvidence = productEvidence;
  meta.positionEvidence = boundary.evidence;
  const cash = await proveFactoryAbortReturn(input, nodes, f, before, payload.seriesId, buy.positionId,
    original.flow.wire.amountRaw, recovery.raw.lt, receiptFor, recovery);
  if (cash && record.retainCash(cash, unwind.factoryReturn)) {
    meta.afterPosition = cash.afterPosition;
    meta.positionEvidence = cash.terminalState.evidence;
  }
  const historyComplete = optionUnique(record.group).every(n => input.chains.get(n.account)?.historyComplete),
    confirmed = historyComplete && unwind.factoryReturn.status === "completed";
  if (confirmed) {
    meta.outcome = "refunded";
    meta.payout = { status: "completed", amountRaw: original.flow.wire.amountRaw, evidence: unwind.factoryReturn.evidence };
  }
  return { operation: record.finish(confirmed, historyComplete ? "option_abort_return_pending" : "option_abort_related_history_incomplete"),
    usedFlows: record.usedFlows };
}
