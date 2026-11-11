import type { Flow, Node, ProjectionInput } from "./project";
import type { LedgerEvidenceRef, LedgerMovement } from "./types";
import type { OptionLifecycleMetadata, OptionLifecycleOperation } from "./optionLifecycle";
import type { StoredOptionPosition, proveOptionAbortOrigin } from "./optionAbortOrigin";
import type { proveFactoryAbortReturn, proveVaultAbortReturn } from "./optionAbortCash";
import type { readOptionVaultBucket } from "./optionLifecycleState";
import { BUY } from "./optionAbortWire";
import { optionNodeOk as ok, optionRef as ref, optionUnique as unique } from "./optionCash";

export type OptionAbortTrigger =
  | { kind: "owner_abort"; bodyHash: string }
  | {
      kind: "initial_series_buy_bounced";
      bodyHash: string;
      bodyBoc: string;
      opcode: number;
      wireId: string;
      originalMessageBodyHash: string;
      failedTransaction: LedgerEvidenceRef;
      recoveryTransaction: LedgerEvidenceRef;
      factoryUnwind: {
        seriesBuyIndexBefore: string;
        seriesBuyIndexAfter: null;
        beforeSeries: { kind: 1 | 2; optionAddress: string; openNotionalRaw: string; collateralLockedRaw: string };
        afterSeries: { kind: 1 | 2; optionAddress: string; openNotionalRaw: string; collateralLockedRaw: string };
      };
    };

export type CashLeg = OptionLifecycleMetadata["payout"] & {
  stateEvidence?: LedgerMovement["evidence"];
};
export type OptionBuyUnwind = {
  funding: {
    queryId: string;
    amountRaw: string;
    ownerWallet: string;
    factoryWallet: string;
    requestBodyHash: string;
    payloadHash: string;
    evidence: LedgerEvidenceRef[];
    stateEvidence: LedgerMovement["evidence"];
  };
  trigger: OptionAbortTrigger;
  beforeAbortBuyStateRaw: string;
  reservationStatus: "reserved" | "failed";
  reservationEvidence: LedgerEvidenceRef[];
  reservationStateEvidence: LedgerMovement["evidence"];
  custody: {
    status: "not_transferred" | "proven" | "unverified";
    amountRaw: string;
    wireId?: string;
    evidence: LedgerEvidenceRef[];
    stateEvidence?: LedgerMovement["evidence"];
  };
  commit?: {
    status: "committed" | "failed" | "unobserved" | "unverified";
    evidence: LedgerEvidenceRef[];
    stateEvidence?: LedgerMovement["evidence"];
  };
  cancellation: {
    status: "pending" | "completed";
    evidence: LedgerEvidenceRef[];
    stateEvidence?: LedgerMovement["evidence"];
  };
  vaultAbort?: {
    receiptHash: string;
    abortHash: string;
    receiptBeforeHash: string | null;
    receiptAfterHash: string;
    trackedBalanceBeforeRaw: string;
    trackedBalanceAfterRaw: string;
    requestHash: string;
    journalKey: string;
    evidence: LedgerEvidenceRef[];
    stateEvidence: LedgerMovement["evidence"];
    beforeBucket: ReturnType<typeof readOptionVaultBucket>;
    afterBucket: ReturnType<typeof readOptionVaultBucket>;
  };
  factoryReturn: CashLeg;
  vaultReturn: CashLeg;
};
/** Shared physical-cash attribution and event assembly for all proved buy-abort triggers. */
export function createOptionAbortRecord(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  original: NonNullable<Awaited<ReturnType<typeof proveOptionAbortOrigin>>>,
  abort: Node,
  stateEvidence: LedgerMovement["evidence"],
  before: StoredOptionPosition,
  after: StoredOptionPosition,
  trigger: OptionAbortTrigger,
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const { flow, factory: f, payload, buy, position, series } = original,
    q = f.qualification!, state = { evidence: stateEvidence },
    transferred = (BigInt(before.buyStateRaw) & BUY.CUSTODY_PROVEN) !== 0n,
    vaultAmount = transferred ? BigInt(position.premiumRaw) : 0n,
    factoryAmount = BigInt(flow.wire.amountRaw) - vaultAmount,
    usedFlows = new Set<string>([flow.id]);
  const anchor = flow.source,
    group: Node[] = [
      flow.source,
      flow.recipient,
      original.origin,
      original.reservation,
      abort,
    ];
  const caller = nodes.find(
    (n) =>
      n.account === input.owner &&
      n.event &&
      n.raw.outMessages.some((_, i) => receiptFor(n, i)?.id === abort.id),
  );
  if (caller) group.push(caller);
  const fundingCaller = nodes.find(
    (n) =>
      n.account === input.owner &&
      n.event &&
      n.raw.outMessages.some(
        (_, i) => receiptFor(n, i)?.id === flow.source.id,
      ),
  );
  if (fundingCaller) group.push(fundingCaller);
  const unwind: OptionBuyUnwind = {
    funding: {
      queryId: flow.wire.queryId,
      amountRaw: flow.wire.amountRaw,
      ownerWallet: flow.source.account,
      factoryWallet: flow.recipient.account,
      requestBodyHash: original.requestBodyHash,
      payloadHash: flow.wire.forward.hash().toString("hex"),
      evidence: [flow.source, flow.recipient, original.origin].map(ref),
      stateEvidence: original.state.evidence,
    },
    trigger,
    beforeAbortBuyStateRaw: before.buyStateRaw,
    reservationStatus: ok(original.reservation) ? "reserved" : "failed",
    reservationEvidence: [ref(original.reservation)],
    reservationStateEvidence: original.product.evidence,
    custody: {
      status: transferred ? "unverified" : "not_transferred",
      amountRaw: vaultAmount.toString(),
      evidence: [],
    },
    cancellation: { status: "pending", evidence: [] },
    factoryReturn: {
      status: factoryAmount === 0n ? "none" : "pending",
      amountRaw: factoryAmount.toString(),
      evidence: [],
    },
    vaultReturn: {
      status: transferred ? "pending" : "none",
      amountRaw: vaultAmount.toString(),
      evidence: [],
    },
  };
  const meta: OptionLifecycleMetadata = {
    factory: f.address,
    factoryCodeHash: q.factoryCodeHash,
    vault: f.vault,
    vaultCodeHash: q.vaultCodeHash,
    root: f.collateralRoot,
    series: series.address,
    productCodeHash:
      series.kind === 1 ? q.shoutCodeHash : q.outperformanceCodeHash,
    optionKind: series.kind,
    seriesId: payload.seriesId,
    positionId: buy.positionId,
    owner: position.owner,
    recipient: position.refundOwner,
    originalRequestBodyHash: original.requestBodyHash,
    outcome: "pending",
    beforePosition: before,
    afterPosition: after,
    requestEvidence: { ...state.evidence, bodyHash: trigger.bodyHash },
    payout: {
      status: "pending",
      amountRaw: flow.wire.amountRaw,
      evidence: [],
    },
    protocolAccounting: {
      status: transferred ? "unverified" : "not_required",
    },
    refund: {
      kind: "aborted_buy",
      scope: "position_unwind",
      queryId: flow.wire.queryId,
      payloadHash: flow.wire.forward.hash().toString("hex"),
      unwind,
    },
    localNetworkFees: [],
  };
  const retainCash = (
    cash:
      | NonNullable<Awaited<ReturnType<typeof proveFactoryAbortReturn>>>
      | NonNullable<Awaited<ReturnType<typeof proveVaultAbortReturn>>>,
    leg: CashLeg,
  ) => {
    const physical = flows.find(
        (v) =>
          v.source.id === cash.source.id &&
          v.recipient.id === cash.credit.id,
      ),
      movement =
        physical &&
        cash.credit.event?.movements.find(
          (m) => m.id === `${physical.id}:in`,
        );
    if (!physical || !physical.confirmed || !movement || (movement.evidence.kind === "native_message" || movement.evidence.kind === "transaction_fee" || movement.evidence.kind === "message_forward_fee")) return false;
    const tokenEvidence: Omit<typeof movement.evidence, "transactionStatus"> = movement.evidence;
    movement.purpose = "option_refund";
    movement.evidence = {
      ...tokenEvidence,
      ...cash.terminalState.evidence,
      kind: "option_refund",
      transactions: cash.nodes.map(ref),
    };
    usedFlows.add(physical.id);
    group.push(...cash.nodes);
    for (const n of cash.nodes)
      for (let i = 0; i < n.raw.outMessages.length; i++) {
        const received = receiptFor(n, i);
        if (received?.event && received.account === input.owner)
          group.push(received);
      }
    Object.assign(leg, {
      status: "completed",
      wireId: cash.wireId,
      sourceWallet: cash.sourceWallet,
      destinationWallet: cash.destinationWallet,
      evidence: cash.nodes.map(ref),
      stateEvidence: cash.terminalState.evidence,
    });
    return true;
  };
  const finish = (confirmed: boolean, issue: string): OptionLifecycleOperation => {
    for (const n of unique(group)) attach(anchor, n);
    const evidence = unique(group).map(ref);
    meta.localNetworkFees = unique(group).map(n => ({
      transaction: ref(n), amountRaw: n.raw.totalFeesRaw ?? null,
      includedInOwnerFeeMovements: Boolean(n.event),
    }));
    return {
      anchor, kind: "option_refund", confirmed, evidence,
      issue: confirmed ? meta.protocolAccounting.status === "unverified"
        ? "option_abort_risk_accounting_unverified" : undefined : issue,
      settlement: { status: confirmed ? "confirmed" : "incomplete", protocol: "options",
        operation: "option_refund", queryId: flow.wire.queryId, optionLifecycle: meta, evidence },
    };
  };
  return { anchor, group, unwind, meta, usedFlows, retainCash, finish };
}
