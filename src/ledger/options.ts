import { readOptionPositionState } from "./optionState";
import { Address, Cell, beginCell } from "@ton/core";
import type { RawMessage } from "../data/dataSource";
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from "./types";
import type { Node, Flow, ProjectionInput } from "./project";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import { bodyCell, NOTIFY, tokenWire } from "./wire";

export const OPTION_FACTORY_BUY = 0x46425559,
  OPTION_BUY_SHOUT = 0x424f5952,
  OPTION_BUY_SPREAD = 0x42425559,
  OPTION_ACTIVATE = 0x4f424156,
  OPTION_ACTIVATE_ACK = 0x4f424158;
export type LedgerOptionFactory = {
  address: string;
  collateralRoot: string;
  series: Map<string, { address: string; kind: 1 | 2 }>;
  codeHash: string;
  qualification?: import('../config/ledgerOptions').LedgerOptionsCodeHashes;
  vault?: string;
  vaultWallet?: string;
  factoryWallet?: string;
  walletCode?: Cell;
};
export type OptionLedgerOperation = {
  anchor: Node;
  kind: "option_buy";
  queryId: string;
  confirmed: boolean;
  evidence: LedgerEvidenceRef[];
  issue?: string;
  settlement: NonNullable<LedgerEvent["settlement"]>;
};
const end = (s: ReturnType<Cell["beginParse"]>) => {
  if (s.remainingBits || s.remainingRefs)
    throw new Error("Trailing option payload");
};
const addr = (v?: string) => {
  try {
    return v ? canonicalLedgerAddress(v) : null;
  } catch {
    return null;
  }
};
const ok = (n: Node) =>
  n.raw.success &&
  (!n.raw.status || n.raw.status === "success") &&
  !n.raw.inMessage?.bounced;
const ref = (n: Node): LedgerEvidenceRef => ({
  account: n.account,
  lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash),
  utime: n.raw.utime,
});
export function optionBuyForward(cell: Cell) {
  try {
    const s = cell.beginParse();
    if (s.loadUint(32) !== OPTION_FACTORY_BUY) return null;
    const seriesId = s.loadUintBig(64).toString(),
      owner = s.loadAddress().toRawString(),
      notional = s.loadCoins().toString(),
      premium = s.loadCoins().toString(),
      correlationScaleBps = s.loadUint(32),
      referrer = s.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    if (
      seriesId === "0" ||
      notional === "0" ||
      premium === "0" ||
      correlationScaleBps === 0 || referrer === owner
    )
      return null;
    return { seriesId, owner, notional, premium, correlationScaleBps, referrer };
  } catch {
    return null;
  }
}
export function optionSeriesBuy(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse(),
      op = s.loadUint(32);
    if (op !== OPTION_BUY_SHOUT && op !== OPTION_BUY_SPREAD) return null;
    const wireId = s.loadUintBig(64).toString(),
      owner = s.loadAddress().toRawString(),
      positionId = s.loadUintBig(64).toString(),
      notional = s.loadCoins().toString(),
      premium = s.loadCoins().toString(),
      collateral = s.loadCoins().toString();
    end(s);
    if (
      wireId === "0" ||
      positionId === "0" ||
      notional === "0" ||
      collateral === "0"
    )
      return null;
    return { op, wireId, owner, positionId, notional, premium, collateral };
  } catch {
    return null;
  }
}
export function optionActivation(
  message?: RawMessage,
  expected = OPTION_ACTIVATE,
) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== expected) return null;
    const seriesId = s.loadUintBig(64).toString(),
      positionId = s.loadUintBig(64).toString(),
      wireId = s.loadUintBig(64).toString(),
      positionHash = s.loadUintBig(256).toString(16).padStart(64, "0");
    end(s);
    return { seriesId, positionId, wireId, positionHash };
  } catch {
    return null;
  }
}
export function optionPositionHash(
  seriesId: string,
  buy: NonNullable<ReturnType<typeof optionSeriesBuy>>,
) {
  return beginCell()
    .storeUint(OPTION_ACTIVATE, 32)
    .storeUint(BigInt(seriesId), 64)
    .storeUint(BigInt(buy.positionId), 64)
    .storeAddress(Address.parse(buy.owner))
    .storeCoins(BigInt(buy.notional))
    .storeCoins(BigInt(buy.premium))
    .storeCoins(BigInt(buy.collateral))
    .storeUint(BigInt(buy.wireId), 64)
    .endCell()
    .hash()
    .toString("hex");
}

/** Attribution begins at this owner's exact funding message, then follows a
 * unique factory-assigned position and the authenticated activation round trip.
 * Reservation counters and a product ACK alone never certify acquisition. */
export async function decodeOptionPurchases(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (node: Node, index: number) => Node | null,
  attach: (a: Node, b: Node) => void,
): Promise<{ operations: OptionLedgerOperation[]; usedFlows: string[] }> {
  const operations: OptionLedgerOperation[] = [],
    usedFlows: string[] = [];
  for (const flow of flows) {
    const payload = optionBuyForward(flow.wire.forward);
    if (
      !payload ||
      flow.sourceAsset.owner !== input.owner ||
      payload.owner !== input.owner
    )
      continue;
    const factory = input.optionFactories?.get(flow.recipientAsset.owner ?? "");
    const anchor = flow.source;
    usedFlows.push(flow.id);
    const base = {
      status: "incomplete" as const,
      protocol: "options" as const,
      operation: "option_buy" as const,
      queryId: flow.wire.queryId,
      factory: flow.recipientAsset.owner,
      seriesId: payload.seriesId,
      notionalRaw: payload.notional,
      referrer: payload.referrer,
    };
    const incomplete = (issue: string) =>
      operations.push({
        anchor,
        kind: "option_buy",
        queryId: flow.wire.queryId,
        confirmed: false,
        evidence: [ref(flow.source), ref(flow.recipient)],
        issue,
        settlement: {
          ...base,
          evidence: [ref(flow.source), ref(flow.recipient)],
        },
      });
    if (!factory || flow.sourceAsset.master !== factory.collateralRoot) {
      incomplete("option_factory_identity_unresolved");
      continue;
    }
    if (!factory.qualification || factory.codeHash !== factory.qualification.factoryCodeHash) {
      incomplete('option_qualified_code_unavailable');
      continue;
    }
    const series = factory.series.get(payload.seriesId);
    if (!series) {
      incomplete("option_series_identity_unresolved");
      continue;
    }
    const ingress = nodes.filter(
      (n) =>
        n.account === factory.address &&
        ok(n) &&
        flow.recipient.raw.outMessages.some(
          (_, index) => receiptFor(flow.recipient, index)?.id === n.id,
        ) &&
        (() => {
          const notify = tokenWire(n.raw.inMessage);
          return (
            notify?.op === NOTIFY &&
            notify.queryId === flow.wire.queryId &&
            notify.amountRaw === flow.wire.amountRaw &&
            notify.owner === input.owner &&
            (notify.senderWallet === undefined ||
              notify.senderWallet === flow.source.account) &&
            notify.forward.hash().equals(flow.wire.forward.hash())
          );
        })(),
    );
    if (ingress.length !== 1) {
      incomplete("option_ingress_unverified");
      continue;
    }
    const origin = ingress[0];
    const buys = origin.raw.outMessages
      .map((message, index) => ({
        message,
        index,
        buy: optionSeriesBuy(message),
      }))
      .filter(
        (item) =>
          item.buy &&
          addr(item.message.source) === factory.address &&
          addr(item.message.destination) === series.address &&
          item.buy.owner === payload.owner &&
          item.buy.notional === payload.notional &&
          item.buy.op ===
            (series.kind === 2 ? OPTION_BUY_SPREAD : OPTION_BUY_SHOUT) &&
          BigInt(item.buy.premium) <= BigInt(payload.premium) &&
          BigInt(flow.wire.amountRaw) === BigInt(payload.premium),
      );
    if (buys.length !== 1) {
      incomplete("option_position_assignment_unverified");
      continue;
    }
    const assigned = buys[0],
      buy = assigned.buy!,
      reserved = receiptFor(origin, assigned.index),
      positionHash = optionPositionHash(payload.seriesId, buy);
    const expected = {
      seriesId: payload.seriesId,
      positionId: buy.positionId,
      wireId: buy.wireId,
      positionHash,
    };
    const matches = (value: ReturnType<typeof optionActivation>) =>
      Boolean(
        value &&
          Object.entries(expected).every(
            ([key, valueExpected]) =>
              value[key as keyof typeof value] === valueExpected,
          ),
      );
    const activated: Node[][] = [];
    for (const n of nodes)
      if (
        n.account === factory.address &&
        ok(n) &&
        BigInt(n.raw.lt) > BigInt(origin.raw.lt)
      )
        for (const [index, message] of n.raw.outMessages.entries()) {
          if (
            addr(message.destination) !== series.address ||
            !matches(optionActivation(message))
          )
            continue;
          const received = receiptFor(n, index);
          if (!received || received.account !== series.address || !ok(received))
            continue;
          for (const [ackIndex, ack] of received.raw.outMessages.entries()) {
            if (
              addr(ack.source) !== series.address ||
              addr(ack.destination) !== factory.address ||
              !matches(optionActivation(ack, OPTION_ACTIVATE_ACK))
            )
              continue;
            const consumed = receiptFor(received, ackIndex);
            if (consumed?.account === factory.address && ok(consumed))
              activated.push([n, received, consumed]);
          }
        }
    activated.sort((a, b) =>
      BigInt(a[0].raw.lt) < BigInt(b[0].raw.lt) ? -1 : 1,
    );
    let terminal: Node[] | undefined;
    let historical: {
      position: NonNullable<ReturnType<typeof readOptionPositionState>>;
      beforeBuyStateRaw: string;
      evidence: LedgerMovement["evidence"];
    } | null = null;
    for (const candidate of activated) {
      const ack = candidate[2];
      if (!ack.raw.prevTransactionLt || !ack.raw.prevTransactionHash) continue;
      try {
        const before = await input.stateAt(
          factory.address,
          ack.raw.prevTransactionLt,
          ack.raw.prevTransactionHash,
        );
        const after = await input.stateAt(
          factory.address,
          ack.raw.lt,
          ack.raw.hash,
        );
        if (
          !before?.state.dataBoc ||
          !after?.state.dataBoc ||
          [before, after].some(
            (s) =>
              !s.state.codeBoc ||
              Cell.fromBase64(s.state.codeBoc).hash().toString("hex") !==
                factory.codeHash,
          )
        )
          continue;
        const bp = readOptionPositionState(
            before.state.dataBoc,
            payload.seriesId,
            buy.positionId,
          ),
          ap = readOptionPositionState(
            after.state.dataBoc,
            payload.seriesId,
            buy.positionId,
          );
        const expectedFee = (
            BigInt(payload.premium) - BigInt(buy.premium)
          ).toString(),
          expectedExcess = (
            BigInt(flow.wire.amountRaw) -
            BigInt(payload.premium)
          ).toString();
        const exact = (p: typeof bp) =>
          p &&
          p.owner === payload.owner &&
          // Current factory PositionData stores its own custody wallet here.
          // The buyer wallet remains the original funding flow's source.
          p.sourceWallet === flow.recipient.account &&
          p.refundOwner === payload.owner &&
          p.notionalRaw === buy.notional &&
          p.premiumRaw === buy.premium &&
          p.collateralRaw === buy.collateral &&
          p.seriesWireId === buy.wireId &&
          BigInt(p.custodyWireId) > 0n &&
          p.refundWireId === "0" &&
          p.protocolFeeRaw === expectedFee &&
          p.excessRaw === expectedExcess &&
          !p.settlementReady &&
          !p.settled &&
          p.settlementPayoutRaw === "0";
        if (
          !exact(bp) ||
          !exact(ap) ||
          !bp ||
          !ap ||
          bp.custodyWireId !== ap.custodyWireId
        )
          continue;
        const b = BigInt(bp.buyStateRaw),
          a = BigInt(ap.buyStateRaw);
        if (
          (b & 269n) !== 269n ||
          (b & (512n | 16n | 32n | 128n)) !== 0n ||
          a !== ((b | 512n) & ~256n) ||
          (a & 525n) !== 525n ||
          ap.walletFundingRaw !== "0"
        )
          continue;
        terminal = candidate;
        historical = {
          position: ap,
          beforeBuyStateRaw: bp.buyStateRaw,
          evidence: {
            stateBeforeHash: bp.dataHash,
            stateAfterHash: ap.dataHash,
            beforeSeqno: before.seqno,
            afterSeqno: after.seqno,
            kind: "option_activation",
          },
        };
        break;
      } catch {
        /* Missing archive/layout evidence cannot be replaced with current position_info. */
      }
    }
    const exactPosition = Boolean(historical);
    const evidenceNodes = [
      flow.source,
      flow.recipient,
      origin,
      ...(reserved ? [reserved] : []),
      ...(terminal ?? []),
    ];
    const complete =
      flow.confirmed &&
      evidenceNodes.every((n) => input.chains.get(n.account)?.historyComplete);
    const debit = anchor.event?.movements.find(
      (m) =>
        m.id === `${flow.id}:out` &&
        m.asset.kind === "jetton" &&
        m.asset.master === factory.collateralRoot &&
        m.amountRaw === flow.wire.amountRaw,
    );
    const confirmed = Boolean(
      debit &&
        reserved &&
        reserved.account === series.address &&
        ok(reserved) &&
        terminal &&
        exactPosition &&
        complete,
    );
    const evidence = [
      ...new Map(evidenceNodes.map((n) => [n.id, ref(n)])).values(),
    ];
    for (const n of [origin, ...(terminal ? [terminal[2]] : [])])
      for (const [index] of n.raw.outMessages.entries()) {
        const refund = receiptFor(n, index);
        if (refund?.event && refund.account === input.owner)
          attach(anchor, refund);
      }
    const protocolFeeRaw = (
        BigInt(payload.premium) - BigInt(buy.premium)
      ).toString(),
      excess =
        BigInt(flow.wire.amountRaw) -
        BigInt(payload.premium);
    if (confirmed && anchor.event) {
      if (debit) {
        anchor.event.movements = anchor.event.movements.filter(
          (m) => m !== debit,
        );
        for (const [purpose, amount, direction] of [
          ["option_premium", buy.premium, "out"],
          ["protocol_fee", protocolFeeRaw, "fee"],
          ["option_excess", excess.toString(), "out"],
        ] as const)
          if (amount !== "0")
            anchor.event.movements.push({
              ...debit,
              id: `${debit.id}:${purpose}`,
              direction,
              amountRaw: amount,
              purpose,
            });
      }
      const right: LedgerMovement = {
        id: `option-position:${input.network}:${factory.address}:${payload.seriesId}:${buy.positionId}`,
        direction: "in",
        amountRaw: "1",
        asset: {
          kind: "option_position",
          id: `${input.network}:option-position:${factory.address}:${payload.seriesId}:${buy.positionId}`,
          factory: factory.address,
          series: series.address,
          seriesId: payload.seriesId,
          positionId: buy.positionId,
          owner: payload.owner,
          decimals: 0,
        },
        source: factory.address,
        destination: payload.owner,
        evidence: {
          bodyHash: positionHash,
          transactions: evidence,
          ...historical!.evidence,
          optionPosition: {
            factory: factory.address,
            factoryCodeHash: factory.codeHash,
            seriesId: payload.seriesId,
            positionId: buy.positionId,
            owner: historical!.position.owner,
            sourceWallet: historical!.position.sourceWallet,
            notionalRaw: historical!.position.notionalRaw,
            premiumRaw: historical!.position.premiumRaw,
            collateralRaw: historical!.position.collateralRaw,
            seriesWireId: historical!.position.seriesWireId,
            custodyWireId: historical!.position.custodyWireId,
            protocolFeeRaw: historical!.position.protocolFeeRaw,
            excessRaw: historical!.position.excessRaw,
            beforeBuyStateRaw: historical!.beforeBuyStateRaw,
            buyStateRaw: historical!.position.buyStateRaw,
          },
        },
      };
      anchor.event.movements.push(right);
    }
    const issue = !complete
      ? "related_account_history_incomplete"
      : !confirmed
        ? activated.length && !historical
          ? "option_activation_state_unavailable"
          : "option_activation_unverified"
        : excess > 0n
          ? "option_excess_refund_unresolved"
          : undefined;
    operations.push({
      anchor,
      kind: "option_buy",
      queryId: flow.wire.queryId,
      confirmed,
      evidence,
      issue,
      settlement: {
        ...base,
        status: confirmed ? "confirmed" : "incomplete",
        factory: factory.address,
        series: series.address,
        positionId: buy.positionId,
        wireId: buy.wireId,
        positionHash,
        premiumRaw: buy.premium,
        collateralRaw: buy.collateral,
        protocolFeeRaw,
        evidence,
      },
    });
  }
  return { operations, usedFlows };
}
