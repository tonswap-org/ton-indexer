import type { ProjectionInput, Node } from "./project";
import type { LedgerOptionFactory } from "./options";
import { optionBoundary } from "./optionLifecycle";
import {
  readOptionFactoryConfig,
  readOptionVaultState,
} from "./optionLifecycleState";
import {
  optionPositionAt,
  optionFactoryMatches,
  sameOptionPrincipal,
  type StoredOptionPosition,
} from "./optionAbortOrigin";
import { optionNodeOk as ok, optionTransactionSucceeded, proveOptionCash } from "./optionCash";
import { BUY } from "./optionAbortWire";
export async function proveFactoryAbortReturn(
  input: ProjectionInput,
  nodes: Node[],
  f: LedgerOptionFactory,
  p: StoredOptionPosition,
  seriesId: string,
  positionId: string,
  amountRaw: string,
  minLt: string,
  receiptFor: (n: Node, i: number) => Node | null,
  provedBounceDispatch: Node | null = null,
) {
  const q = f.qualification;
  if (!q || amountRaw === "0") return null;
  const key = ((BigInt(seriesId) << 64n) | BigInt(positionId)).toString();
  for (const n of nodes
    .filter(
      (n) =>
        n.account === f.address &&
        (ok(n) || (n.id === provedBounceDispatch?.id && optionTransactionSucceeded(n))) &&
        BigInt(n.raw.lt) >= BigInt(minLt),
    )
    .sort((a, b) => (BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1))) {
    const dispatch = await optionBoundary(
      input,
      n,
      q.factoryCodeHash,
      readOptionFactoryConfig,
    );
    const active =
      dispatch && optionPositionAt(dispatch.afterBoc, seriesId, positionId);
    if (
      !dispatch ||
      !active ||
      ![dispatch.before, dispatch.after].every((s) =>
        optionFactoryMatches(s, f),
      ) ||
      !sameOptionPrincipal(active, p) ||
      !active.settled ||
      active.custodyWireId !== p.custodyWireId ||
      dispatch.after.activeBuyKey !== key ||
      (BigInt(active.buyStateRaw) &
        (BUY.ABORTING | BUY.CANCELLED | BUY.REFUND_IN_FLIGHT)) !==
        (BUY.ABORTING | BUY.CANCELLED | BUY.REFUND_IN_FLIGHT) ||
      (BigInt(active.buyStateRaw) &
        (BUY.REFUNDED |
          BUY.ACTIVE |
          BUY.CUSTODY_IN_FLIGHT |
          BUY.ACTIVATING)) !==
        0n ||
      active.refundWireId === "0"
    )
      continue;
    const cash = proveOptionCash(
      input,
      f,
      n,
      p.refundOwner,
      active.refundWireId,
      amountRaw,
      receiptFor,
    );
    if (!cash) continue;
    const terminal = await optionBoundary(
        input,
        cash.terminal,
        q.factoryCodeHash,
        readOptionFactoryConfig,
      ),
      before =
        terminal && optionPositionAt(terminal.beforeBoc, seriesId, positionId),
      after =
        terminal && optionPositionAt(terminal.afterBoc, seriesId, positionId);
    if (
      !terminal ||
      !before ||
      !after ||
      ![terminal.before, terminal.after].every((s) =>
        optionFactoryMatches(s, f),
      ) ||
      ![before, after].every(
        (s) =>
          sameOptionPrincipal(s, p) &&
          s.settled &&
          s.custodyWireId === p.custodyWireId &&
          s.refundWireId === active.refundWireId,
      ) ||
      terminal.before.activeBuyKey !== key ||
      (BigInt(before.buyStateRaw) &
        (BUY.REFUND_FINALIZING |
          BUY.REFUND_IN_FLIGHT |
          BUY.ABORTING |
          BUY.CANCELLED)) !==
        (BUY.REFUND_FINALIZING |
          BUY.REFUND_IN_FLIGHT |
          BUY.ABORTING |
          BUY.CANCELLED) ||
      (BigInt(before.buyStateRaw) &
        (BUY.REFUNDED |
          BUY.ACTIVE |
          BUY.CUSTODY_IN_FLIGHT |
          BUY.ACTIVATING)) !==
        0n ||
      (BigInt(before.buyStateRaw) & BUY.REFUND_BOUNCED) !== 0n ||
      BigInt(after.buyStateRaw) !==
        ((BigInt(before.buyStateRaw) | BUY.REFUNDED) &
          ~BUY.REFUND_IN_FLIGHT &
          ~BUY.REFUND_FINALIZING) ||
      after.walletFundingRaw !== "0"
    )
      continue;
    return {
      ...cash,
      dispatch,
      terminalState: terminal,
      beforePosition: before,
      afterPosition: after,
      wireId: active.refundWireId,
    };
  }
  return null;
}
export async function proveVaultAbortReturn(
  input: ProjectionInput,
  nodes: Node[],
  f: LedgerOptionFactory,
  seriesId: string,
  custodyWireId: string,
  amountRaw: string,
  recipient: string,
  key: string,
  requestHash: string,
  minLt: string,
  receiptFor: (n: Node, i: number) => Node | null,
) {
  const q = f.qualification;
  if (!q || !f.vault || amountRaw === "0") return null;
  const matchesConfig = (s: ReturnType<typeof readOptionVaultState>) =>
    s.manager === f.address &&
    s.collateralRoot === f.collateralRoot &&
    s.collateralWallet === f.vaultWallet &&
    s.walletCode.hash().toString("hex") === q.walletCodeHash;
  const matchesEntry = (e: import("./optionLifecycleState").OptionVaultEntry) =>
    e.kind === 3 &&
    e.seriesId === seriesId &&
    e.requestId === custodyWireId &&
    e.amountRaw === amountRaw &&
    e.requestHash === requestHash &&
    e.recipient === recipient &&
    e.lockedDeltaRaw === "0" &&
    e.premiumDeltaRaw === "0" &&
    e.riskClaimId === "0" &&
    e.riskStatus === 0 &&
    e.riskDeliveredRaw === "0";
  for (const n of nodes
    .filter(
      (n) =>
        n.account === f.vault && ok(n) && BigInt(n.raw.lt) >= BigInt(minLt),
    )
    .sort((a, b) => (BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1))) {
    const dispatch = await optionBoundary(
        input,
        n,
        q.vaultCodeHash,
        readOptionVaultState,
      ),
      entry = dispatch?.after.entries.get(key);
    if (
      !dispatch ||
      ![dispatch.before, dispatch.after].every(matchesConfig) ||
      !entry ||
      entry.status !== 2 ||
      entry.accountingApplied !== 0 ||
      !matchesEntry(entry)
    )
      continue;
    const cash = proveOptionCash(
      input,
      f,
      n,
      recipient,
      entry.wireId,
      amountRaw,
      receiptFor,
    );
    if (!cash) continue;
    const terminal = await optionBoundary(
        input,
        cash.terminal,
        q.vaultCodeHash,
        readOptionVaultState,
      ),
      before = terminal?.before.entries.get(key),
      after = terminal?.after.entries.get(key);
    if (
      !terminal ||
      ![terminal.before, terminal.after].every(matchesConfig) ||
      !before ||
      !after ||
      before.status !== 3 ||
      after.status !== 4 ||
      before.accountingApplied !== 0 ||
      after.accountingApplied !== 1 ||
      ![before, after].every(
        (e) =>
          matchesEntry(e) &&
          e.wireId === entry.wireId &&
          e.destinationWallet === cash.destinationWallet &&
          e.finalizeReservedRaw === "0",
      ) ||
      terminal.before.pendingFinalizeKey !== key ||
      terminal.after.pendingFinalizeKey !== "0".repeat(64) ||
      terminal.after.finalizeAttemptKey !== "0".repeat(64) ||
      BigInt(terminal.before.trackedBalanceRaw) -
        BigInt(terminal.after.trackedBalanceRaw) !==
        BigInt(amountRaw) ||
      BigInt(terminal.before.reservedTokensRaw) -
        BigInt(terminal.after.reservedTokensRaw) !==
        BigInt(amountRaw)
    )
      continue;
    return {
      ...cash,
      dispatch,
      terminalState: terminal,
      beforeJournal: before,
      afterJournal: after,
      wireId: entry.wireId,
    };
  }
  return null;
}
