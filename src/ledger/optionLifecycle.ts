import { Cell } from "@ton/core";
import type { ProjectionInput, Node, Flow } from "./project";
import type { LedgerEvent, LedgerMovement, LedgerEvidenceRef } from "./types";
import type { LedgerOptionFactory } from "./options";
import { readOptionPositionState } from "./optionState";
import {
  readOptionFactoryConfig,
  readOptionProductState,
  readOptionVaultState,
  type OptionVaultEntry,
} from "./optionLifecycleState";
import {
  OPTION_SHOUT_EXERCISE,
  OPTION_SPREAD_EXERCISE,
  OPTION_SHOUT_PAYOUT,
  OPTION_SPREAD_PAYOUT,
  optionExercise,
  optionProductExercise,
  optionVaultPayout,
  optionSettlementKey,
} from "./optionLifecycleWire";
import {
  optionNodeOk as ok,
  optionRef as ref,
  optionUnique as unique,
  proveOptionCash,
} from "./optionCash";
import { canonicalLedgerAddress } from "./normalize";
export type OptionLifecycleMetadata = {
  factory: string;
  factoryCodeHash: string;
  vault?: string;
  vaultCodeHash?: string;
  root: string;
  series?: string;
  productCodeHash?: string;
  optionKind?: 1 | 2;
  seriesId?: string;
  positionId?: string;
  owner: string;
  recipient: string;
  originalRequestBodyHash?: string;
  requestedPayoutRaw?: string;
  requestedPremiumBurnRaw?: string;
  outcome: "exercised" | "refunded" | "pending";
  beforePosition?: ReturnType<typeof readOptionPositionState>;
  afterPosition?: ReturnType<typeof readOptionPositionState>;
  productBefore?: ReturnType<typeof readOptionProductState>;
  productAfter?: ReturnType<typeof readOptionProductState>;
  positionEvidence?: LedgerMovement["evidence"];
  requestEvidence?: LedgerMovement["evidence"];
  productEvidence?: LedgerMovement["evidence"];
  payout: {
    status: "none" | "pending" | "completed";
    amountRaw: string | null;
    issue?: string;
    wireId?: string;
    sourceWallet?: string;
    destinationWallet?: string;
    requestHash?: string;
    journalKey?: string;
    beforeJournal?: OptionVaultEntry;
    afterJournal?: OptionVaultEntry;
    evidence: LedgerEvidenceRef[];
  };
  protocolAccounting: {
    status: "not_required" | "unverified" | "confirmed";
    riskClaimId?: string;
    riskRequestHash?: string;
    riskDeliveredRaw?: string;
  };
  collateralLiabilityReleasedRaw?: string;
  premiumAccountingReleasedRaw?: string;
  refund?: {
    kind: "ingress" | "excess" | "aborted_buy";
    claimId?: string;
    identityHash?: string;
    logicalIdentityHash?: string;
    notificationCreatedLt?: string;
    notificationBodyHash?: string;
    sourceWallet?: string;
    queryId?: string;
    payloadHash?: string;
    scope: "individual_claim" | "position_unwind";
    unwind?: import("./optionAbortRecord").OptionBuyUnwind;
    beforeClaim?: import("./optionLifecycleState").OptionOutboundClaim;
  };
  localNetworkFees: Array<{
    transaction: LedgerEvidenceRef;
    amountRaw: string | null;
    includedInOwnerFeeMovements: boolean;
  }>;
};
export type OptionLifecycleOperation = {
  anchor: Node;
  kind: "option_exercise" | "option_refund";
  confirmed: boolean;
  evidence: LedgerEvidenceRef[];
  issue?: string;
  settlement: NonNullable<LedgerEvent["settlement"]>;
};
const addr = (s?: string) => {
  try {
    return s ? canonicalLedgerAddress(s) : null;
  } catch {
    return null;
  }
};
/** Read both exact transaction boundaries; latest getters cannot replace a pruned position or claim. */
export async function optionBoundary<T>(
  input: ProjectionInput,
  n: Node,
  codeHash: string,
  parse: (boc: string) => T,
) {
  try {
    if (!n.raw.prevTransactionLt || !n.raw.prevTransactionHash) return null;
    const b = await input.stateAt(
        n.account,
        n.raw.prevTransactionLt,
        n.raw.prevTransactionHash,
      ),
      a = await input.stateAt(n.account, n.raw.lt, n.raw.hash);
    if (
      !b?.state.dataBoc ||
      !a?.state.dataBoc ||
      [b, a].some(
        (s) =>
          !s.state.codeBoc ||
          Cell.fromBase64(s.state.codeBoc).hash().toString("hex") !== codeHash,
      )
    )
      return null;
    return {
      before: parse(b.state.dataBoc),
      after: parse(a.state.dataBoc),
      beforeBoc: b.state.dataBoc,
      afterBoc: a.state.dataBoc,
      evidence: {
        kind: "option_position_delta" as const,
        stateBeforeHash: Cell.fromBase64(b.state.dataBoc)
          .hash()
          .toString("hex"),
        stateAfterHash: Cell.fromBase64(a.state.dataBoc).hash().toString("hex"),
        beforeSeqno: b.seqno,
        afterSeqno: a.seqno,
        transactions: [ref(n)],
      },
    };
  } catch {
    return null;
  }
}
const factoryConfigMatches = (
  s: ReturnType<typeof readOptionFactoryConfig>,
  f: LedgerOptionFactory,
) =>
  s.vault === f.vault &&
  s.collateralRoot === f.collateralRoot &&
  s.shoutCodeHash === f.qualification?.shoutCodeHash &&
  s.outperformanceCodeHash === f.qualification?.outperformanceCodeHash &&
  s.walletCode.hash().toString("hex") === f.qualification?.walletCodeHash;
const active = (p: ReturnType<typeof readOptionPositionState>) =>
  p &&
  !p.settled &&
  (BigInt(p.buyStateRaw) & 525n) === 525n &&
  (BigInt(p.buyStateRaw) & (16n | 32n | 128n)) === 0n;
const positionAt = (boc: string, series: string, position: string) => {
  try {
    return readOptionPositionState(boc, series, position);
  } catch {
    return null;
  }
};
const samePositionIdentity = (
  a: NonNullable<ReturnType<typeof readOptionPositionState>>,
  b: NonNullable<ReturnType<typeof readOptionPositionState>>,
) =>
  (
    [
      "owner",
      "sourceWallet",
      "notionalRaw",
      "buyStateRaw",
      "refundOwner",
      "seriesWireId",
      "custodyWireId",
      "refundWireId",
      "protocolFeeRaw",
      "excessRaw",
      "walletFundingRaw",
    ] as const
  ).every((key) => a[key] === b[key]);
export async function decodeOptionExercises(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: OptionLifecycleOperation[] = [],
    usedFlows = new Set<string>(),
    retired = new Set<string>();
  for (const n of [...nodes].sort((a, b) =>
    BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1,
  )) {
    const request = optionExercise(n.raw.inMessage),
      factory = input.optionFactories?.get(n.account),
      owner = addr(n.raw.inMessage?.source);
    if (
      !request ||
      !factory ||
      !owner ||
      owner !== input.owner
    )
      continue;
    let anchor = nodes.find(
      (o) =>
        o.account === input.owner &&
        o.event &&
        o.raw.outMessages.some((_, i) => receiptFor(o, i)?.id === n.id),
    );
    const series = factory.series.get(request.seriesId),
      q = factory.qualification;
    const meta: OptionLifecycleMetadata = {
      factory: factory.address,
      factoryCodeHash: factory.codeHash,
      vault: factory.vault,
      vaultCodeHash: q?.vaultCodeHash,
      root: factory.collateralRoot,
      series: series?.address,
      optionKind: series?.kind,
      seriesId: request.seriesId,
      positionId: request.positionId,
      owner,
      recipient: owner,
      originalRequestBodyHash: request.bodyHash,
      outcome: "pending",
      payout: { status: "pending", amountRaw: null, evidence: [] },
      protocolAccounting: { status: "unverified" },
      localNetworkFees: [],
    };
    const group: Node[] = [...(anchor ? [anchor] : []), n];
    let confirmed = false,
      issue = "option_exercise_state_unverified";
    const finish = () => {
      if (!anchor?.event) return;
      for (const member of unique(group)) attach(anchor, member);
      const evidence = unique(group).map(ref);
      meta.localNetworkFees = unique(group).map((member) => ({
        transaction: ref(member),
        amountRaw: member.raw.totalFeesRaw ?? null,
        includedInOwnerFeeMovements: Boolean(member.event),
      }));
      operations.push({
        anchor,
        kind: "option_exercise",
        confirmed,
        evidence,
        issue: confirmed
          ? meta.payout.status === "pending"
            ? "option_payout_settlement_pending"
            : meta.protocolAccounting.status === "unverified"
              ? "option_risk_reimbursement_unverified"
              : undefined
          : issue,
        settlement: {
          status: confirmed ? "confirmed" : "incomplete",
          protocol: "options",
          operation: "option_exercise",
          optionLifecycle: meta,
          evidence,
        },
      });
    };
    if (
      !q ||
      factory.codeHash !== q.factoryCodeHash ||
      !series ||
      !factory.vault ||
      !factory.walletCode ||
      !ok(n)
    ) {
      issue = "option_qualified_lifecycle_identity_unverified";
      finish();
      continue;
    }
    meta.productCodeHash =
      series.kind === 1 ? q.shoutCodeHash : q.outperformanceCodeHash;
    const original = await optionBoundary(
      input,
      n,
      q.factoryCodeHash,
      readOptionFactoryConfig,
    );
    const before =
      original &&
      positionAt(original.beforeBoc, request.seriesId, request.positionId);
    if (
      !original ||
      !factoryConfigMatches(original.before, factory) ||
      !factoryConfigMatches(original.after, factory) ||
      !active(before) ||
      before!.owner !== owner
    ) {
      finish();
      continue;
    }
    const productDispatch = n.raw.outMessages.flatMap((m, i) => {
      const v = optionProductExercise(m),
        next = receiptFor(n, i);
      return addr(m.source) === factory.address &&
        addr(m.destination) === series.address &&
        !m.bounced &&
        v?.opcode ===
          (series.kind === 1
            ? OPTION_SHOUT_EXERCISE
            : OPTION_SPREAD_EXERCISE) &&
        v.positionId === request.positionId &&
        next &&
        ok(next)
        ? [{ v, next }]
        : [];
    });
    if (productDispatch.length !== 1) {
      issue = "option_product_exercise_receipt_missing";
      finish();
      continue;
    }
    const productNode = productDispatch[0].next,
      productRequest = productDispatch[0].v;
    group.push(productNode);
    const product = await optionBoundary(
      input,
      productNode,
      meta.productCodeHash,
      (boc) => readOptionProductState(boc, series.kind, request.positionId),
    );
    const pb = product?.before.position,
      pa = product?.after.position;
    if (
      !product ||
      !pb ||
      [product.before, product.after].some(
        (s) =>
          s.seriesId !== request.seriesId ||
          s.manager !== factory.address ||
          s.vault !== factory.vault,
      ) ||
      pb.owner !== owner ||
      pb.notionalRaw !== before!.notionalRaw ||
      pb.premiumRaw !== before!.premiumRaw ||
      (pb.settled ? pb.collateralRaw !== "0" : pb.collateralRaw !== before!.collateralRaw) ||
      pb.buyWireId !== before!.seriesWireId || !pb.active || !pa || !pa.settled || !pa.exercised ||
      pa.owner !== pb.owner || pa.tokenId !== pb.tokenId || pa.notionalRaw !== pb.notionalRaw ||
      pa.premiumRaw !== pb.premiumRaw || pa.collateralRaw !== "0" || pa.buyWireId !== pb.buyWireId ||
      pa.active !== pb.active
    ) {
      issue = "option_product_position_state_unverified";
      finish();
      continue;
    }
    const premiumRaw = "0";
    if (series.kind === 1 && (productRequest.recipient !== owner || productRequest.refundTo !== owner ||
      productRequest.premiumBurnRaw !== "0" || productRequest.payoutRaw !== "0")) {
      finish(); continue;
    }
    const callbacks = productNode.raw.outMessages.flatMap((m, i) => {
      const v = optionProductExercise(m), next = receiptFor(productNode, i);
      return addr(m.destination) === factory.address && addr(m.source) === series.address && !m.bounced &&
        v?.opcode === (series.kind === 1 ? OPTION_SHOUT_PAYOUT : OPTION_SPREAD_PAYOUT) &&
        v.positionId === request.positionId && v.payoutRaw === pa.payoutRaw &&
        (series.kind === 1 ? v.recipient === owner && v.refundTo === owner && v.premiumBurnRaw === "0" &&
          pa.settlementCallbackBoc !== undefined && Cell.fromBase64(pa.settlementCallbackBoc).hash().toString("hex") === v.bodyHash
          : v.seriesId === request.seriesId) && next && ok(next) ? [{ v, next }] : [];
    });
    if (callbacks.length !== 1) {
      issue = "option_factory_payout_callback_missing"; finish(); continue;
    }
    const terminal = callbacks[0].next, payoutRaw = callbacks[0].v.payoutRaw;
    group.push(terminal);
    const terminalBoundary = await optionBoundary(input, terminal, q.factoryCodeHash, readOptionFactoryConfig);
    if (!terminalBoundary || !factoryConfigMatches(terminalBoundary.before, factory) || !factoryConfigMatches(terminalBoundary.after, factory)) {
      finish(); continue;
    }
    const waiting = positionAt(terminalBoundary.beforeBoc, request.seriesId, request.positionId);
    if (!waiting || !active(waiting) || !waiting.settlementReady || !samePositionIdentity(waiting, before!) ||
      waiting.premiumRaw !== before!.premiumRaw || waiting.collateralRaw !== before!.collateralRaw ||
      waiting.settlementPayoutRaw !== before!.settlementPayoutRaw) {
      finish(); continue;
    }
    const after = positionAt(
      terminalBoundary.afterBoc,
      request.seriesId,
      request.positionId,
    );
    if (
      !after ||
      !after.settled ||
      after.settlementReady ||
      after.settlementPayoutRaw !== payoutRaw ||
      !samePositionIdentity(after, before!) ||
      after.collateralRaw !== "0" ||
      after.premiumRaw !==
        (BigInt(before!.premiumRaw) - BigInt(premiumRaw)).toString() ||
      BigInt(payoutRaw) > BigInt(before!.collateralRaw)
    ) {
      finish();
      continue;
    }
    meta.beforePosition = before;
    meta.afterPosition = after;
    meta.productBefore = product.before;
    meta.productAfter = product.after;
    meta.requestEvidence = { ...original.evidence, bodyHash: request.bodyHash };
    meta.productEvidence = {
      ...product.evidence,
      bodyHash: productRequest.bodyHash,
    };
    meta.positionEvidence = {
      ...terminalBoundary.evidence,
      kind: "option_position_delta",
      bodyHash: request.bodyHash,
      transactions: unique(group).map(ref),
    };
    meta.collateralLiabilityReleasedRaw = (
      BigInt(before!.collateralRaw) - BigInt(payoutRaw)
    ).toString();
    meta.premiumAccountingReleasedRaw = premiumRaw;
    meta.payout = {
      status: payoutRaw === "0" ? "none" : "pending",
      amountRaw: payoutRaw,
      evidence: [],
    };
    if (payoutRaw !== "0" || premiumRaw !== "0") {
      const calls = terminal.raw.outMessages.flatMap((m, i) => {
        const v = optionVaultPayout(m),
          next = receiptFor(terminal, i);
        return addr(m.source) === factory.address &&
          addr(m.destination) === factory.vault &&
          v?.positionId === request.positionId &&
          v.seriesId === request.seriesId &&
          v.recipient === owner &&
          v.refundTo === owner &&
          v.payoutRaw === payoutRaw &&
          v.premiumBurnRaw === premiumRaw &&
          next &&
          ok(next)
          ? [{ v, next }]
          : [];
      });
      if (calls.length !== 1)
        meta.payout.issue = "option_vault_payout_request_missing";
      if (calls.length === 1) {
        const call = calls[0];
        group.push(call.next);
        const key = optionSettlementKey(
          1,
          request.seriesId,
          request.positionId,
        );
        meta.payout.requestHash = call.v.bodyHash;
        meta.payout.journalKey = key;
        for (const candidate of nodes
          .filter(
            (x) =>
              x.account === factory.vault &&
              BigInt(x.raw.lt) >= BigInt(call.next.raw.lt),
          )
          .sort((a, b) => (BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1))) {
          const boundary = await optionBoundary(
              input,
              candidate,
              q.vaultCodeHash,
              readOptionVaultState,
            ),
            entry = boundary?.after.entries.get(key);
          if (
            !boundary ||
            !entry ||
            [boundary.before, boundary.after].some(
              (s) =>
                s.manager !== factory.address ||
                s.collateralRoot !== factory.collateralRoot ||
                s.walletCode.hash().toString("hex") !== q.walletCodeHash,
            ) ||
            entry.kind !== 1 ||
            entry.seriesId !== request.seriesId ||
            entry.requestId !== request.positionId ||
            entry.requestHash !== call.v.bodyHash ||
            entry.amountRaw !== payoutRaw ||
            entry.recipient !== owner ||
            entry.lockedDeltaRaw !== payoutRaw ||
            entry.premiumDeltaRaw !== premiumRaw
          )
            continue;
          if (payoutRaw === "0") {
            if (entry.status === 4 && entry.accountingApplied === 1) {
              meta.protocolAccounting = { status: "confirmed" };
              meta.payout.afterJournal = entry;
              group.push(candidate);
            }
            continue;
          }
          if (entry.status !== 2) continue;
          const cash = proveOptionCash(
            input,
            factory,
            candidate,
            owner,
            entry.wireId,
            payoutRaw,
            receiptFor,
          );
          if (!cash) continue;
          const terminalState = await optionBoundary(
              input,
              cash.terminal,
              q.vaultCodeHash,
              readOptionVaultState,
            ),
            b = terminalState?.before.entries.get(key),
            a = terminalState?.after.entries.get(key);
          if (
            !terminalState ||
            !b ||
            !a ||
            [terminalState.before, terminalState.after].some(
              (s) =>
                s.manager !== factory.address ||
                s.collateralRoot !== factory.collateralRoot ||
                s.collateralWallet !== cash.sourceWallet ||
                s.walletCode.hash().toString("hex") !== q.walletCodeHash,
            ) ||
            b.status !== 3 ||
            a.status !== 4 ||
            [b, a].some(
              (e) =>
                e.kind !== 1 ||
                e.requestId !== request.positionId ||
                e.seriesId !== request.seriesId ||
                e.wireId !== entry.wireId ||
                e.requestHash !== call.v.bodyHash ||
                e.amountRaw !== payoutRaw ||
                e.lockedDeltaRaw !== payoutRaw ||
                e.premiumDeltaRaw !== premiumRaw ||
                e.finalizeReservedRaw !== "0" ||
                e.destinationWallet !== cash.destinationWallet ||
                e.recipient !== owner,
            ) ||
            terminalState.before.pendingFinalizeKey !== key ||
            terminalState.after.pendingFinalizeKey !== "0".repeat(64) ||
            terminalState.after.finalizeAttemptKey !== "0".repeat(64) ||
            BigInt(terminalState.before.trackedBalanceRaw) -
              BigInt(terminalState.after.trackedBalanceRaw) !==
              BigInt(payoutRaw) ||
            BigInt(terminalState.before.reservedTokensRaw) -
              BigInt(terminalState.after.reservedTokensRaw) !==
              BigInt(payoutRaw)
          )
            continue;
          group.push(...cash.nodes);
          meta.payout = {
            ...meta.payout,
            status: "completed",
            wireId: entry.wireId,
            sourceWallet: cash.sourceWallet,
            destinationWallet: cash.destinationWallet,
            beforeJournal: b,
            afterJournal: a,
            evidence: cash.nodes.map(ref),
          };
          meta.protocolAccounting = {
            status:
              a.riskClaimId === "0" && a.accountingApplied === 1
                ? "confirmed"
                : "unverified",
            riskClaimId: a.riskClaimId,
            riskRequestHash: a.riskRequestHash,
            riskDeliveredRaw: a.riskDeliveredRaw,
          };
          const flow = flows.find(
            (f) =>
              f.source.id === cash.source.id &&
              f.recipient.id === cash.credit.id,
          );
          if (flow) {
            usedFlows.add(flow.id);
            const m = cash.credit.event?.movements.find(
              (m) => m.id === `${flow.id}:in`,
            );
            if (m && m.evidence.kind !== "native_message" && m.evidence.kind !== "transaction_fee" && m.evidence.kind !== "message_forward_fee") {
              const tokenEvidence: Omit<typeof m.evidence, "transactionStatus"> = m.evidence;
              m.purpose = "option_payout";
              m.evidence = {
                ...tokenEvidence,
                ...terminalState.evidence,
                kind: "option_payout",
                transactions: cash.nodes.map(ref),
              };
            }
            if (!anchor && cash.credit.event) anchor = cash.credit;
          }
          break;
        }
      }
    } else meta.protocolAccounting = { status: "not_required" };
    if (
      unique(group).some((x) => !input.chains.get(x.account)?.historyComplete)
    ) {
      issue = "option_related_history_incomplete";
      finish();
      continue;
    }
    const retirementKey = `${factory.address}:${request.seriesId}:${request.positionId}`;
    if (retired.has(retirementKey)) continue;
    if (owner === input.owner && anchor?.event)
      anchor.event.movements.push({
        id: `${retirementKey}:exercise`,
        direction: "out",
        purpose: "option_right_retired",
        asset: {
          kind: "option_position",
          id: `${input.network}:option-position:${factory.address}:${request.seriesId}:${request.positionId}`,
          factory: factory.address,
          series: series.address,
          seriesId: request.seriesId,
          positionId: request.positionId,
          owner,
          decimals: 0,
        },
        amountRaw: "1",
        source: owner,
        destination: factory.address,
        evidence: meta.positionEvidence,
      });
    retired.add(retirementKey);
    confirmed = true;
    meta.outcome = "exercised";
    finish();
  }
  return { operations, usedFlows: [...usedFlows] };
}
