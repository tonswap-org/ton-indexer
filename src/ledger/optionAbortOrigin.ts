import type { Flow, Node, ProjectionInput } from "./project";
import {
  optionBuyForward,
  optionSeriesBuy,
  optionPositionHash,
  OPTION_BUY_SHOUT,
  OPTION_BUY_SPREAD,
  type LedgerOptionFactory,
} from "./options";
import { bodyCell, NOTIFY, tokenWire } from "./wire";
import { optionBoundary } from "./optionLifecycle";
import {
  readOptionFactoryConfig,
  readOptionProductState,
} from "./optionLifecycleState";
import { readOptionPositionState } from "./optionState";
import { optionNodeOk as ok } from "./optionCash";
import { canonicalLedgerAddress } from "./normalize";
const addr = (s?: string) => {
  try {
    return s ? canonicalLedgerAddress(s) : null;
  } catch {
    return null;
  }
};
export const optionFactoryMatches = (
  state: ReturnType<typeof readOptionFactoryConfig>,
  f: LedgerOptionFactory,
) =>
  Boolean(
    f.qualification &&
      f.codeHash === f.qualification.factoryCodeHash &&
      state.vault === f.vault &&
      state.collateralRoot === f.collateralRoot &&
      state.walletCode.hash().toString("hex") ===
        f.qualification.walletCodeHash &&
      state.shoutCodeHash === f.qualification.shoutCodeHash &&
      state.outperformanceCodeHash === f.qualification.outperformanceCodeHash,
  );
export function optionPositionAt(
  boc: string,
  seriesId: string,
  positionId: string,
) {
  try {
    return readOptionPositionState(boc, seriesId, positionId);
  } catch {
    return null;
  }
}
export type StoredOptionPosition = NonNullable<
  ReturnType<typeof readOptionPositionState>
>;
export const sameOptionPrincipal = (
  a: StoredOptionPosition,
  b: StoredOptionPosition,
) =>
  (
    [
      "owner",
      "sourceWallet",
      "notionalRaw",
      "premiumRaw",
      "collateralRaw",
      "protocolFeeRaw",
      "excessRaw",
      "refundOwner",
      "seriesWireId",
    ] as const
  ).every((k) => a[k] === b[k]);
/** Original reservation attribution does not grant an ACTIVE option right. */
export async function proveOptionAbortOrigin(
  input: ProjectionInput,
  nodes: Node[],
  flow: Flow,
  factory: LedgerOptionFactory,
  receiptFor: (n: Node, i: number) => Node | null,
) {
  const payload = optionBuyForward(flow.wire.forward),
    q = factory.qualification;
  if (
    !payload ||
    !q ||
    !factory.vault ||
    !factory.walletCode ||
    !flow.confirmed ||
    payload.owner !== input.owner ||
    flow.sourceAsset.owner !== payload.owner ||
    flow.sourceAsset.master !== factory.collateralRoot ||
    flow.recipientAsset.owner !== factory.address ||
    flow.recipientAsset.master !== factory.collateralRoot
  )
    return null;
  const series = factory.series.get(payload.seriesId);
  if (!series) return null;
  const origins = nodes.filter((n) => {
    const w = tokenWire(n.raw.inMessage);
    return (
      n.account === factory.address &&
      ok(n) &&
      w?.op === NOTIFY &&
      w.owner === payload.owner &&
      w.queryId === flow.wire.queryId &&
      w.amountRaw === flow.wire.amountRaw &&
      w.forward.hash().equals(flow.wire.forward.hash()) &&
      flow.recipient.raw.outMessages.some(
        (_, i) => receiptFor(flow.recipient, i)?.id === n.id,
      )
    );
  });
  if (origins.length !== 1) return null;
  const origin = origins[0],
    assigned = origin.raw.outMessages.flatMap((message, index) => {
      const buy = optionSeriesBuy(message),
        receipt = receiptFor(origin, index);
      return addr(message.source) === factory.address &&
        addr(message.destination) === series.address &&
        !message.bounced &&
        buy &&
        buy.op === (series.kind === 1 ? OPTION_BUY_SHOUT : OPTION_BUY_SPREAD) &&
        buy.owner === payload.owner &&
        buy.notional === payload.notional &&
        BigInt(buy.premium) <= BigInt(payload.premium) &&
        receipt?.account === series.address
        ? [{ buy, receipt }]
        : [];
    });
  if (assigned.length !== 1) return null;
  const { buy, receipt: reservation } = assigned[0],
    state = await optionBoundary(
      input,
      origin,
      q.factoryCodeHash,
      readOptionFactoryConfig,
    );
  if (
    !state ||
    !optionFactoryMatches(state.before, factory) ||
    !optionFactoryMatches(state.after, factory)
  )
    return null;
  const before = optionPositionAt(
      state.beforeBoc,
      payload.seriesId,
      buy.positionId,
    ),
    position = optionPositionAt(
      state.afterBoc,
      payload.seriesId,
      buy.positionId,
    );
  const fee = BigInt(payload.premium) - BigInt(buy.premium),
    excess =
      BigInt(flow.wire.amountRaw) -
      BigInt(payload.premium) -
      BigInt(buy.collateral);
  if (
    before ||
    !position ||
    excess < 0n ||
    position.owner !== payload.owner ||
    position.sourceWallet !== flow.recipient.account ||
    position.refundOwner !== payload.owner ||
    position.notionalRaw !== buy.notional ||
    position.premiumRaw !== buy.premium ||
    position.collateralRaw !== buy.collateral ||
    position.protocolFeeRaw !== fee.toString() ||
    position.excessRaw !== excess.toString() ||
    position.seriesWireId !== buy.wireId ||
    position.custodyWireId !== buy.wireId ||
    position.refundWireId !== "0" ||
    position.buyStateRaw !== "0" ||
    position.settled ||
    position.settlementReady ||
    position.settlementPayoutRaw !== "0"
  )
    return null;
  const product = await optionBoundary(
    input,
    reservation,
    series.kind === 1 ? q.shoutCodeHash : q.outperformanceCodeHash,
    (boc) => readOptionProductState(boc, series.kind, buy.positionId),
  );
  if (
    !product ||
    [product.before, product.after].some(
      (s) =>
        s.manager !== factory.address ||
        s.vault !== factory.vault ||
        s.seriesId !== payload.seriesId,
    )
  )
    return null;
  if (
    product.before.position ||
    (!ok(reservation) &&
      (reservation.raw.status !== "failed" || reservation.raw.success))
  )
    return null;
  const p = product.after.position;
  if (
    ok(reservation)
      ? !p ||
        p.active ||
        p.exercised ||
        p.settled ||
        p.owner !== position.owner ||
        p.notionalRaw !== position.notionalRaw ||
        p.premiumRaw !== position.premiumRaw ||
        p.collateralRaw !== position.collateralRaw ||
        p.buyWireId !== position.seriesWireId
      : p !== null
  )
    return null;
  return {
    payload,
    buy,
    flow,
    factory,
    series,
    origin,
    reservation,
    state,
    position,
    product,
    positionHash: optionPositionHash(payload.seriesId, buy),
    requestBodyHash: bodyCell(flow.source.raw.inMessage)!
      .hash()
      .toString("hex"),
  };
}
