import type { Flow, Node, ProjectionInput } from "./project";
import { createOptionAbortRecord } from "./optionAbortRecord";
import { decodeInitialOptionBuyBounce } from "./optionBuyBounce";
import type {
  OptionLifecycleOperation,
} from "./optionLifecycle";
import { optionBoundary } from "./optionLifecycle";
import { optionActivation } from "./options";
import {
  readOptionFactoryConfig,
  readOptionProductState,
  readOptionVaultState,
  readOptionVaultBucket,
} from "./optionLifecycleState";
import { optionSettlementKey } from "./optionLifecycleWire";
import {
  BUY,
  OPTION_CANCEL,
  OPTION_CANCEL_ACK,
  OPTION_VAULT_ABORT_ACK,
  optionOwnerAbort,
  optionVaultAbort,
  optionBuyResponse,
  optionVaultCommit,
  optionDepositReceiptHash,
  optionAbortReceiptHash,
  optionAbortRefundHash,
} from "./optionAbortWire";
import {
  optionFactoryMatches,
  optionPositionAt,
  sameOptionPrincipal,
  proveOptionAbortOrigin,
} from "./optionAbortOrigin";
import {
  proveFactoryAbortReturn,
  proveVaultAbortReturn,
} from "./optionAbortCash";
import {
  optionNodeOk as ok,
  optionRef as ref,
  optionUnique as unique,
  proveOptionCash,
} from "./optionCash";
import { canonicalLedgerAddress } from "./normalize";
const addr = (s?: string) => {
  try {
    return s ? canonicalLedgerAddress(s) : null;
  } catch {
    return null;
  }
};
/** A completed aborted purchase conserves the original gross credit across its
 * factory and, when custody was proven, vault return. No REFUNDED bit or OBAA
 * alone is cash, and no new ACTIVE right is created by a reservation. */
export async function decodeOptionAborts(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: OptionLifecycleOperation[] = [],
    usedFlows = new Set<string>(),
    supersededPurchaseAnchors = new Set<string>(),
    seen = new Set<string>();
  for (const flow of flows) {
    const f = input.optionFactories?.get(flow.recipientAsset.owner ?? "");
    if (!f?.qualification || !f.vault || !f.walletCode || !flow.source.event)
      continue;
    const original = await proveOptionAbortOrigin(
      input,
      nodes,
      flow,
      f,
      receiptFor,
    );
    if (!original) continue;
    const { payload, buy, position, series } = original,
      q = f.qualification,
      key = `${f.address}:${payload.seriesId}:${buy.positionId}`;
    if (seen.has(key)) continue;
    const automatic = await decodeInitialOptionBuyBounce(input, nodes, flows, original, receiptFor, attach);
    if (automatic) {
      operations.push(automatic.operation);
      supersededPurchaseAnchors.add(automatic.operation.anchor.id);
      for (const id of automatic.usedFlows) usedFlows.add(id);
      seen.add(key);
      continue;
    }
    const aborts = nodes.filter((n) => {
      const r = optionOwnerAbort(n.raw.inMessage);
      return (
        n.account === f.address &&
        ok(n) &&
        addr(n.raw.inMessage?.source) === position.owner &&
        r?.seriesId === payload.seriesId &&
        r.positionId === buy.positionId &&
        BigInt(n.raw.lt) > BigInt(original.origin.raw.lt)
      );
    });
    for (const abort of aborts.sort((a, b) =>
      BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1,
    )) {
      const request = optionOwnerAbort(abort.raw.inMessage)!;
      const state = await optionBoundary(
          input,
          abort,
          q.factoryCodeHash,
          readOptionFactoryConfig,
        ),
        before =
          state &&
          optionPositionAt(state.beforeBoc, payload.seriesId, buy.positionId),
        after =
          state &&
          optionPositionAt(state.afterBoc, payload.seriesId, buy.positionId);
      if (
        !state ||
        !before ||
        !after ||
        ![state.before, state.after].every((s) => optionFactoryMatches(s, f)) ||
        ![before, after].every(
          (p) =>
            sameOptionPrincipal(p, position) &&
            !p.settled &&
            !p.settlementReady &&
            p.settlementPayoutRaw === "0",
        ) ||
        (BigInt(before.buyStateRaw) &
          (BUY.ACTIVE |
            BUY.ABORTING |
            BUY.CUSTODY_IN_FLIGHT |
            BUY.ACTIVATING |
            BUY.REFUNDED)) !==
          0n ||
        BigInt(after.buyStateRaw) !==
          (BigInt(before.buyStateRaw) | BUY.ABORTING) ||
        after.custodyWireId !== before.custodyWireId
      )
        continue;
      const transferred =
          (BigInt(before.buyStateRaw) & BUY.CUSTODY_PROVEN) !== 0n,
        vaultAmount = transferred
          ? BigInt(position.premiumRaw)
          : 0n,
        factoryAmount = BigInt(flow.wire.amountRaw) - vaultAmount;
      if (
        factoryAmount < 0n ||
        (transferred && before.custodyWireId === "0") ||
        (!transferred &&
          (before.custodyWireId !== position.custodyWireId ||
            (BigInt(before.buyStateRaw) & ~BUY.RESERVED) !== 0n))
      )
        continue;
      const record = createOptionAbortRecord(input, nodes, flows, original, abort,
        state.evidence, before, after, { kind: "owner_abort", bodyHash: request.bodyHash }, receiptFor, attach),
        { anchor, group, unwind, meta, retainCash } = record;
      let issue = "option_abort_cancellation_unverified",
        confirmed = false,
        cancelStart = abort;
      const finish = () => {
        operations.push(record.finish(confirmed, issue));
        supersededPurchaseAnchors.add(anchor.id);
        for (const id of record.usedFlows) usedFlows.add(id);
        seen.add(key);
      };
      if (transferred) {
        // Prove the original reserved principal actually crossed into vault custody.
        for (const n of nodes.filter(
          (n) =>
            n.account === f.address &&
            ok(n) &&
            BigInt(n.raw.lt) > BigInt(original.origin.raw.lt) &&
            BigInt(n.raw.lt) < BigInt(abort.raw.lt),
        )) {
          const cash = proveOptionCash(
            input,
            f,
            n,
            f.vault,
            before.custodyWireId,
            vaultAmount.toString(),
            receiptFor,
          );
          if (!cash || BigInt(cash.terminal.raw.lt) >= BigInt(abort.raw.lt))
            continue;
          const b = await optionBoundary(
              input,
              cash.terminal,
              q.factoryCodeHash,
              readOptionFactoryConfig,
            ),
            bp =
              b &&
              optionPositionAt(b.beforeBoc, payload.seriesId, buy.positionId),
            ap =
              b &&
              optionPositionAt(b.afterBoc, payload.seriesId, buy.positionId);
          if (
            !b ||
            !bp ||
            !ap ||
            ![b.before, b.after].every((s) => optionFactoryMatches(s, f)) ||
            ![bp, ap].every(
              (p) =>
                sameOptionPrincipal(p, position) &&
                p.custodyWireId === before.custodyWireId,
            ) ||
            b.before.activeBuyKey !==
              (
                (BigInt(payload.seriesId) << 64n) |
                BigInt(buy.positionId)
              ).toString() ||
            (BigInt(bp.buyStateRaw) &
              (BUY.CUSTODY_FINALIZING | BUY.CUSTODY_IN_FLIGHT)) !==
              (BUY.CUSTODY_FINALIZING | BUY.CUSTODY_IN_FLIGHT) ||
            (BigInt(bp.buyStateRaw) &
              (BUY.CUSTODY_PROVEN |
                BUY.CUSTODY_BOUNCED |
                BUY.ABORTING |
                BUY.ACTIVE)) !==
              0n ||
            BigInt(ap.buyStateRaw) !==
              ((BigInt(bp.buyStateRaw) | BUY.CUSTODY_PROVEN) &
                ~BUY.CUSTODY_IN_FLIGHT &
                ~BUY.CUSTODY_FINALIZING)
          )
            continue;
          unwind.custody = {
            status: "proven",
            amountRaw: vaultAmount.toString(),
            wireId: before.custodyWireId,
            evidence: cash.nodes.map(ref),
            stateEvidence: b.evidence,
          };
          group.push(...cash.nodes);
          const commits = cash.terminal.raw.outMessages.flatMap((m, i) => {
            const c = optionVaultCommit(m);
            return addr(m.source) === f.address &&
              addr(m.destination) === f.vault &&
              !m.bounced &&
              c?.seriesId === payload.seriesId &&
              c.positionId === buy.positionId &&
              c.custodyWireId === before.custodyWireId &&
              c.collateralRaw === position.collateralRaw &&
              c.premiumRaw === position.premiumRaw &&
              c.vaultWallet === f.vaultWallet
              ? [{ request: c, node: receiptFor(cash.terminal, i) }]
              : [];
          });
          if (commits.length !== 1) {
            unwind.commit = { status: "unverified", evidence: [] };
            break;
          }
          const commit = commits[0],
            cn = commit.node;
          if (!cn) {
            unwind.commit = {
              status: "unobserved",
              evidence: [ref(cash.terminal)],
            };
            break;
          }
          group.push(cn);
          unwind.commit = {
            status: "unverified",
            evidence: [ref(cash.terminal), ref(cn)],
          };
          const cs = await optionBoundary(
              input,
              cn,
              q.vaultCodeHash,
              readOptionVaultState,
            ),
            dk = (BigInt(payload.seriesId) << 64n) | BigInt(buy.positionId),
            rh = BigInt(
              "0x" +
                optionDepositReceiptHash(
                  payload.seriesId,
                  buy.positionId,
                  before.custodyWireId,
                  position.collateralRaw,
                  position.premiumRaw,
                  f.vaultWallet!,
                ),
            );
          if (
            !cs ||
            [cs.before, cs.after].some(
              (s) =>
                s.manager !== f.address ||
                s.collateralRoot !== f.collateralRoot ||
                s.collateralWallet !== f.vaultWallet ||
                s.walletCode.hash().toString("hex") !== q.walletCodeHash,
            )
          )
            break;
          unwind.commit.stateEvidence = cs.evidence;
          if (!ok(cn)) {
            if (
              cn.raw.status === "failed" &&
              !cn.raw.success &&
              cs.beforeBoc === cs.afterBoc
            )
              unwind.commit.status = "failed";
            break;
          }
          try {
            const cb = readOptionVaultBucket(
                cs.before.bucketCell,
                payload.seriesId,
              ),
              ca = readOptionVaultBucket(cs.after.bucketCell, payload.seriesId);
            if (
              cs.before.depositReceipts.get(dk) === undefined &&
              cs.after.depositReceipts.get(dk) === rh &&
              BigInt(cs.after.trackedBalanceRaw) -
                BigInt(cs.before.trackedBalanceRaw) ===
                vaultAmount &&
              BigInt(ca?.lockedRaw ?? "0") - BigInt(cb?.lockedRaw ?? "0") ===
                BigInt(position.collateralRaw) &&
              BigInt(ca?.premiumRaw ?? "0") - BigInt(cb?.premiumRaw ?? "0") ===
                BigInt(position.premiumRaw)
            )
              unwind.commit.status = "committed";
          } catch {
            /* Archive data that cannot be decoded remains unverified. */
          }
          break;
        }
        if (unwind.commit?.status === "unverified") {
          issue = "option_abort_original_commit_unverified";
          finish();
          break;
        }
        if (unwind.custody.status !== "proven") {
          issue = "option_abort_original_custody_unverified";
          finish();
          break;
        }
        const calls = abort.raw.outMessages.flatMap((message, i) => {
          const v = optionVaultAbort(message),
            next = receiptFor(abort, i);
          return addr(message.source) === f.address &&
            addr(message.destination) === f.vault &&
            !message.bounced &&
            v?.seriesId === payload.seriesId &&
            v.positionId === buy.positionId &&
            v.custodyWireId === before.custodyWireId &&
            v.collateralRaw === position.collateralRaw &&
            v.premiumRaw === position.premiumRaw &&
            v.recipient === position.refundOwner &&
            v.vaultWallet === f.vaultWallet &&
            next &&
            ok(next)
            ? [{ v, next }]
            : [];
        });
        if (calls.length !== 1) {
          issue = "option_abort_vault_request_unverified";
          finish();
          break;
        }
        const call = calls[0],
          boundary = await optionBoundary(
            input,
            call.next,
            q.vaultCodeHash,
            readOptionVaultState,
          ),
          receiptHash = optionDepositReceiptHash(
            payload.seriesId,
            buy.positionId,
            before.custodyWireId,
            position.collateralRaw,
            position.premiumRaw,
            f.vaultWallet!,
          ),
          abortHash = optionAbortReceiptHash(receiptHash),
          depositKey =
            (BigInt(payload.seriesId) << 64n) | BigInt(buy.positionId),
          requestHash = optionAbortRefundHash(
            payload.seriesId,
            buy.positionId,
            before.custodyWireId,
            vaultAmount.toString(),
            position.refundOwner,
            receiptHash,
          ),
          journalKey = optionSettlementKey(
            3,
            payload.seriesId,
            before.custodyWireId,
          );
        const receiptBefore = boundary?.before.depositReceipts.get(depositKey),
          receiptAfter = boundary?.after.depositReceipts.get(depositKey),
          queued = boundary?.after.entries.get(journalKey);
        if (
          !boundary ||
          [boundary.before, boundary.after].some(
            (s) =>
              s.manager !== f.address ||
              s.collateralRoot !== f.collateralRoot ||
              s.collateralWallet !== f.vaultWallet ||
              s.walletCode.hash().toString("hex") !== q.walletCodeHash,
          ) ||
          (receiptBefore !== undefined &&
            receiptBefore !== BigInt("0x" + receiptHash)) ||
          receiptAfter !== BigInt("0x" + abortHash) ||
          !queued ||
          queued.kind !== 3 ||
          queued.requestId !== before.custodyWireId ||
          queued.seriesId !== payload.seriesId ||
          queued.amountRaw !== vaultAmount.toString() ||
          queued.recipient !== position.refundOwner ||
          queued.requestHash !== requestHash
        ) {
          issue = "option_abort_vault_receipt_unverified";
          finish();
          break;
        }
        let beforeBucket: ReturnType<typeof readOptionVaultBucket>,
          afterBucket: ReturnType<typeof readOptionVaultBucket>;
        if (
          (receiptBefore !== undefined) !==
          (unwind.commit?.status === "committed")
        ) {
          issue = "option_abort_commit_receipt_mismatch";
          finish();
          break;
        }
        try {
          beforeBucket = readOptionVaultBucket(
            boundary.before.bucketCell,
            payload.seriesId,
          );
          afterBucket = readOptionVaultBucket(
            boundary.after.bucketCell,
            payload.seriesId,
          );
        } catch {
          issue = "option_abort_vault_bucket_unverified";
          finish();
          break;
        }
        if (receiptBefore !== undefined) {
          if (
            !beforeBucket ||
            !afterBucket ||
            BigInt(beforeBucket.lockedRaw) - BigInt(afterBucket.lockedRaw) !==
              BigInt(position.collateralRaw) ||
            BigInt(beforeBucket.premiumRaw) - BigInt(afterBucket.premiumRaw) !==
              BigInt(position.premiumRaw) ||
            BigInt(boundary.before.totalLockedRaw) -
              BigInt(boundary.after.totalLockedRaw) !==
              BigInt(position.collateralRaw) ||
            BigInt(boundary.before.totalPremiumRaw) -
              BigInt(boundary.after.totalPremiumRaw) !==
              BigInt(position.premiumRaw) ||
            boundary.before.trackedBalanceRaw !== boundary.after.trackedBalanceRaw
          ) {
            issue = "option_abort_vault_bucket_unverified";
            finish();
            break;
          }
        } else if (
          BigInt(boundary.after.trackedBalanceRaw) -
            BigInt(boundary.before.trackedBalanceRaw) !==
            vaultAmount ||
          !boundary.before.bucketCell.hash().equals(boundary.after.bucketCell.hash()) ||
          boundary.before.totalLockedRaw !== boundary.after.totalLockedRaw ||
          boundary.before.totalPremiumRaw !== boundary.after.totalPremiumRaw
        ) {
          issue = "option_abort_orphan_custody_accounting_unverified";
          finish();
          break;
        }
        group.push(call.next);
        unwind.vaultAbort = {
          receiptHash,
          abortHash,
          receiptBeforeHash: receiptBefore === undefined
            ? null : receiptBefore.toString(16).padStart(64, "0"),
          receiptAfterHash: receiptAfter!.toString(16).padStart(64, "0"),
          trackedBalanceBeforeRaw: boundary.before.trackedBalanceRaw,
          trackedBalanceAfterRaw: boundary.after.trackedBalanceRaw,
          requestHash,
          journalKey,
          evidence: [ref(call.next)],
          stateEvidence: boundary.evidence,
          beforeBucket,
          afterBucket,
        };
        const acks = call.next.raw.outMessages.flatMap((m, i) => {
          const v = optionBuyResponse(m, OPTION_VAULT_ABORT_ACK),
            next = receiptFor(call.next, i);
          return addr(m.source) === f.vault &&
            addr(m.destination) === f.address &&
            v?.seriesId === payload.seriesId &&
            v.positionId === buy.positionId &&
            v.leg === 2 &&
            v.wireId === before.custodyWireId &&
            next &&
            ok(next)
            ? [next]
            : [];
        });
        if (acks.length !== 1) {
          issue = "option_abort_vault_ack_missing";
          finish();
          break;
        }
        cancelStart = acks[0];
        group.push(cancelStart);
        const ackState = await optionBoundary(
            input,
            cancelStart,
            q.factoryCodeHash,
            readOptionFactoryConfig,
          ),
          ab =
            ackState &&
            optionPositionAt(
              ackState.beforeBoc,
              payload.seriesId,
              buy.positionId,
            ),
          aa =
            ackState &&
            optionPositionAt(
              ackState.afterBoc,
              payload.seriesId,
              buy.positionId,
            );
        if (
          !ackState ||
          !ab ||
          !aa ||
          ![ackState.before, ackState.after].every((s) =>
            optionFactoryMatches(s, f),
          ) ||
          ![ab, aa].every(
            (p) =>
              sameOptionPrincipal(p, position) &&
              p.custodyWireId === before.custodyWireId,
          ) ||
          BigInt(aa.buyStateRaw) !==
            (BigInt(ab.buyStateRaw) | BUY.VAULT_ABORTED)
        ) {
          issue = "option_abort_factory_ack_state_unverified";
          finish();
          break;
        }
        const cash = await proveVaultAbortReturn(
          input,
          nodes,
          f,
          payload.seriesId,
          before.custodyWireId,
          vaultAmount.toString(),
          position.refundOwner,
          journalKey,
          requestHash,
          call.next.raw.lt,
          receiptFor,
        );
        if (cash && retainCash(cash, unwind.vaultReturn)) {
          unwind.vaultReturn.requestHash = requestHash;
          unwind.vaultReturn.journalKey = journalKey;
          unwind.vaultReturn.beforeJournal = cash.beforeJournal;
          unwind.vaultReturn.afterJournal = cash.afterJournal;
        }
      }
      const cancellations = cancelStart.raw.outMessages.flatMap((m, i) => {
        const c = optionActivation(m, OPTION_CANCEL),
          next = receiptFor(cancelStart, i);
        return addr(m.source) === f.address &&
          addr(m.destination) === series.address &&
          !m.bounced &&
          c?.seriesId === payload.seriesId &&
          c.positionId === buy.positionId &&
          c.wireId === position.seriesWireId &&
          c.positionHash === original.positionHash &&
          next &&
          ok(next)
          ? [next]
          : [];
      });
      if (cancellations.length !== 1) {
        finish();
        break;
      }
      const cancelled = cancellations[0],
        product = await optionBoundary(
          input,
          cancelled,
          meta.productCodeHash!,
          (boc) => readOptionProductState(boc, series.kind, buy.positionId),
        ),
        pb = product?.before.position;
      if (
        !product ||
        [product.before, product.after].some(
          (p) =>
            p.manager !== f.address ||
            p.vault !== f.vault ||
            p.seriesId !== payload.seriesId,
        ) ||
        product.after.position !== null ||
        (pb &&
          (pb.active ||
            pb.owner !== position.owner ||
            pb.notionalRaw !== position.notionalRaw ||
            pb.premiumRaw !== position.premiumRaw ||
            pb.collateralRaw !== position.collateralRaw ||
            pb.buyWireId !== position.seriesWireId))
      ) {
        issue = "option_abort_product_cancellation_unverified";
        finish();
        break;
      }
      const cancellationAcks = cancelled.raw.outMessages.flatMap((m, i) => {
        const c = optionBuyResponse(m, OPTION_CANCEL_ACK),
          next = receiptFor(cancelled, i);
        return addr(m.source) === series.address &&
          addr(m.destination) === f.address &&
          c?.seriesId === payload.seriesId &&
          c.positionId === buy.positionId &&
          c.leg === 0 &&
          c.wireId === position.seriesWireId &&
          next &&
          ok(next)
          ? [next]
          : [];
      });
      if (cancellationAcks.length !== 1) {
        issue = "option_abort_cancellation_ack_missing";
        finish();
        break;
      }
      const finalCancel = cancellationAcks[0],
        cancelState = await optionBoundary(
          input,
          finalCancel,
          q.factoryCodeHash,
          readOptionFactoryConfig,
        ),
        cb =
          cancelState &&
          optionPositionAt(
            cancelState.beforeBoc,
            payload.seriesId,
            buy.positionId,
          ),
        ca =
          cancelState &&
          optionPositionAt(
            cancelState.afterBoc,
            payload.seriesId,
            buy.positionId,
          );
      if (
        !cancelState ||
        !cb ||
        !ca ||
        ![cancelState.before, cancelState.after].every((s) =>
          optionFactoryMatches(s, f),
        ) ||
        ![cb, ca].every(
          (p) =>
            sameOptionPrincipal(p, position) &&
            p.custodyWireId === before.custodyWireId,
        ) ||
        cb.settled ||
        !ca.settled ||
        (BigInt(cb.buyStateRaw) & BUY.ABORTING) === 0n ||
        (BigInt(ca.buyStateRaw) & (BUY.ABORTING | BUY.CANCELLED)) !==
          (BUY.ABORTING | BUY.CANCELLED) ||
        (BigInt(ca.buyStateRaw) & BUY.ACTIVE) !== 0n
      ) {
        issue = "option_abort_cancellation_state_unverified";
        finish();
        break;
      }
      group.push(cancelled, finalCancel);
      unwind.cancellation = {
        status: "completed",
        evidence: [cancelStart, cancelled, finalCancel].map(ref),
        stateEvidence: product.evidence,
      };
      meta.productBefore = product.before;
      meta.productAfter = product.after;
      meta.productEvidence = product.evidence;
      meta.afterPosition = ca;
      meta.positionEvidence = cancelState.evidence;
      if (factoryAmount === 0n) {
        if ((BigInt(ca.buyStateRaw) & BUY.REFUNDED) === 0n) {
          issue = "option_abort_zero_factory_return_unverified";
          finish();
          break;
        }
      } else {
        const cash = await proveFactoryAbortReturn(
          input,
          nodes,
          f,
          before,
          payload.seriesId,
          buy.positionId,
          factoryAmount.toString(),
          finalCancel.raw.lt,
          receiptFor,
        );
        if (cash && retainCash(cash, unwind.factoryReturn)) {
          meta.afterPosition = cash.afterPosition;
          meta.positionEvidence = cash.terminalState.evidence;
        }
      }
      if (
        unique(group).some((n) => !input.chains.get(n.account)?.historyComplete)
      ) {
        issue = "option_abort_related_history_incomplete";
        finish();
        break;
      }
      confirmed = [unwind.factoryReturn, unwind.vaultReturn].every(
        (p) => p.status === "none" || p.status === "completed",
      );
      if (confirmed) {
        meta.outcome = "refunded";
        meta.payout = {
          status: "completed",
          amountRaw: flow.wire.amountRaw,
          evidence: [
            ...unwind.factoryReturn.evidence,
            ...unwind.vaultReturn.evidence,
          ],
        };
      } else issue = "option_abort_return_pending";
      finish();
      break;
    }
  }
  return {
    operations,
    usedFlows: [...usedFlows],
    supersededPurchaseAnchors: [...supersededPurchaseAnchors],
  };
}
