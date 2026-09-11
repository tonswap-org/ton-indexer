import { Address, Cell } from "@ton/core";
import type { LedgerMovement, LedgerEvidenceRef } from "./types";
import type { Node, ProjectionInput } from "./project";
import type { LedgerT3Hub } from "./t3";
import type { LedgerStateSnapshot } from "./archive";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import { perpsWalletAddress } from "./perpsWire";
import { bodyCell } from "./wire";
import * as w from "./t3Wire";
import {
  readT3RecoveryRoot,
  readT3RecoveryWallet,
  readT3RecoveryHub,
} from "./t3RecoveryState";
const ref = (n: Node): LedgerEvidenceRef => ({
  account: n.account,
  lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash),
  utime: n.raw.utime,
});
const ok = (n: Node) =>
  n.raw.success &&
  (!n.raw.status || n.raw.status === "success") &&
  !n.raw.inMessage?.bounced;
const addr = (s?: string) => {
  try {
    return s ? canonicalLedgerAddress(s) : null;
  } catch {
    return null;
  }
};
const unique = (ns: Node[]) => [...new Map(ns.map((n) => [n.id, n])).values()];
type Boundary<T> = {
  before: T;
  after: T;
  evidence: LedgerMovement["evidence"];
};
export type T3BurnRecovery = {
  status: "accepted";
  binding: NonNullable<LedgerT3Hub["redemptionBinding"]>;
  continuationRequestBodyHash: string;
  originalWallet: Boundary<ReturnType<typeof readT3RecoveryWallet>>;
  originalRoot: Boundary<ReturnType<typeof readT3RecoveryRoot>["summary"]>;
  originalProof: Boundary<ReturnType<typeof readT3RecoveryHub>>;
  continuation: Boundary<ReturnType<typeof readT3RecoveryHub>>;
  rootAcceptance: Boundary<ReturnType<typeof readT3RecoveryRoot>["summary"]>;
  walletAcceptance: Boundary<ReturnType<typeof readT3RecoveryWallet>>;
  evidence: LedgerEvidenceRef[];
};
async function boundary<T>(
  input: ProjectionInput,
  n: Node,
  codeHash: string,
  read: (boc: string) => T,
): Promise<Boundary<T> | null> {
  try {
    if (
      !n.raw.prevTransactionLt ||
      !n.raw.prevTransactionHash ||
      !/^[1-9][0-9]*$/.test(n.raw.prevTransactionLt) ||
      !/^[1-9][0-9]*$/.test(n.raw.lt) ||
      BigInt(n.raw.prevTransactionLt) >= BigInt(n.raw.lt)
    )
      return null;
    const before = await input.stateAt(
        n.account,
        n.raw.prevTransactionLt,
        n.raw.prevTransactionHash,
      ),
      after = await input.stateAt(n.account, n.raw.lt, n.raw.hash);
    const matches = (
      snapshot: LedgerStateSnapshot | null,
      lt: string,
      hash: string,
    ): snapshot is LedgerStateSnapshot =>
      Boolean(
        snapshot &&
          Number.isSafeInteger(snapshot.seqno) &&
          snapshot.seqno >= 0 &&
          snapshot.state?.accountState === "active" &&
          snapshot.state.lastTxLt === lt &&
          snapshot.state.lastTxHash &&
          canonicalLedgerHash(snapshot.state.lastTxHash) ===
            canonicalLedgerHash(hash) &&
          snapshot.state.dataBoc &&
          snapshot.state.codeBoc &&
          Cell.fromBase64(snapshot.state.codeBoc).hash().toString("hex") ===
            codeHash,
      );
    // Cached JSON must meet the same exact transaction boundary as a fresh
    // archive lookup. One account has only one final state per masterchain
    // block; an unavailable intrablock state must never be interpolated.
    if (
      !matches(before, n.raw.prevTransactionLt, n.raw.prevTransactionHash) ||
      !matches(after, n.raw.lt, n.raw.hash) ||
      before.seqno >= after.seqno
    )
      return null;
    return {
      before: read(before.state.dataBoc!),
      after: read(after.state.dataBoc!),
      evidence: {
        kind: "t3_burn",
        stateBeforeHash: Cell.fromBase64(before.state.dataBoc!)
          .hash()
          .toString("hex"),
        stateAfterHash: Cell.fromBase64(after.state.dataBoc!)
          .hash()
          .toString("hex"),
        beforeSeqno: before.seqno,
        afterSeqno: after.seqno,
        transactions: [ref(n)],
      },
    };
  } catch {
    return null;
  }
}
/** A later REDM can recover only the original durable root/hub proof. It never burns again or certifies payout. */
export async function recoverT3Burn(
  input: ProjectionInput,
  hub: LedgerT3Hub,
  wallet: Node,
  root: Node,
  proof: Node,
  wireId: string,
  request: NonNullable<ReturnType<typeof w.burnRequest>>,
  requests: Node[],
  receiptFor: (n: Node, i: number) => Node | null,
) {
  const base = [wallet, root, proof],
    q = hub.redemptionBinding;
  const missing = (issue: string, ns = base) => ({
    issue,
    nodes: unique(ns),
    metadata: undefined as T3BurnRecovery | undefined,
    hubAck: undefined as Node | undefined,
    accepted: undefined as Node | undefined,
    continuation: undefined as Node | undefined,
  });
  if (!requests.length) return missing("t3_burn_proof_unverified");
  if (!q) return missing("t3_recovery_binding_unconfigured");
  if (
    q.network !== input.network ||
    q.hub !== hub.address ||
    q.root !== hub.root ||
    q.hubCodeHash !== hub.codeHash ||
    q.reserveRoutes.some(
      (r, i) =>
        r.root !== hub.reserveRoots[i] ||
        r.vault !== hub.vaults[i] ||
        r.discovery !== r.root,
    )
  )
    return missing("t3_recovery_binding_mismatch");
  const requestHash = w.burnRequestHash(
      hub.root,
      wallet.account,
      input.owner,
      request,
    ),
    intentHash = w.burnIntentHash(input.owner, request.queryId);
  const rootRead = (boc: string) =>
    readT3RecoveryRoot(
      boc,
      hub.root,
      wallet.account,
      hub.address,
      request.queryId,
      wireId,
    );
  const walletState = await boundary(
      input,
      wallet,
      q.walletCodeHash,
      readT3RecoveryWallet,
    ),
    rootState = await boundary(input, root, q.rootCodeHash, rootRead),
    proofState = await boundary(input, proof, q.hubCodeHash, (b) =>
      readT3RecoveryHub(b, input.owner, request.queryId),
    );
  if (!walletState || !rootState || !proofState)
    return missing("t3_recovery_original_archive_unavailable");
  const walletMatches = (s: ReturnType<typeof readT3RecoveryWallet>) =>
    s.owner === input.owner &&
    s.root === hub.root &&
    s.journal.queryId === request.queryId &&
    s.journal.amountRaw === request.amountRaw &&
    s.journal.requestHash === requestHash &&
    s.journal.response === hub.address;
  const rootConfig = (s: ReturnType<typeof readT3RecoveryRoot>) =>
    s.summary.enabled === 1 &&
    s.summary.emitter === hub.address &&
    s.summary.walletCodeHash === q.walletCodeHash &&
    perpsWalletAddress(s.walletCode, hub.root, input.owner) === wallet.account;
  const rootTuple = (s: ReturnType<typeof readT3RecoveryRoot>) =>
    rootConfig(s) &&
    s.summary.receiptHash === requestHash &&
    s.summary.pendingHash === requestHash &&
    s.summary.negativeHash === null &&
    (s.summary.acceptedHash === null ||
      s.summary.acceptedHash === requestHash) &&
    s.summary.wireWalletHash ===
      Address.parse(wallet.account).hash.toString("hex") &&
    s.summary.wireQueryId === request.queryId &&
    s.summary.wireIntentHash === intentHash &&
    s.summary.wireAmountRaw === request.amountRaw;
  const proofMatches = (s: ReturnType<typeof readT3RecoveryHub>) =>
    s.root === hub.root &&
    s.proof?.owner === input.owner &&
    s.proof.queryId === request.queryId &&
    s.proof.wireId === wireId &&
    s.proof.amountRaw === request.amountRaw &&
    s.proof.recipient === request.recipient &&
    s.proof.slippage === request.slippage &&
    s.proof.mode === request.mode &&
    s.proof.outputToken === request.outputToken;
  if (
    !walletMatches(walletState.after) ||
    walletState.after.journal.status !== 4 ||
    walletState.before.owner !== input.owner ||
    walletState.before.root !== hub.root ||
    [1, 4, 5].includes(walletState.before.journal.status) ||
    BigInt(walletState.before.journal.queryId) >= BigInt(request.queryId) ||
    BigInt(walletState.before.balanceRaw) -
      BigInt(walletState.after.balanceRaw) !==
      BigInt(request.amountRaw) ||
    !rootConfig(rootState.before) ||
    !rootTuple(rootState.after) ||
    rootState.before.summary.receiptHash !== null ||
    rootState.after.summary.acceptedHash !== null ||
    BigInt(rootState.before.summary.totalSupplyRaw) -
      BigInt(rootState.after.summary.totalSupplyRaw) !==
      BigInt(request.amountRaw) ||
    proofState.before.root !== hub.root ||
    proofState.before.proof !== null ||
    !proofMatches(proofState.after) ||
    proofState.after.proof!.consumed !== 0
  )
    return missing("t3_recovery_original_state_unverified");
  const candidates: Array<{
    node: Node;
    state: Boundary<ReturnType<typeof readT3RecoveryHub>>;
  }> = [];
  for (const node of requests) {
    if (
      BigInt(node.raw.lt) <= BigInt(proof.raw.lt) ||
      addr(node.raw.inMessage?.source) !== input.owner
    )
      continue;
    const state = await boundary(input, node, q.hubCodeHash, (b) =>
      readT3RecoveryHub(b, input.owner, request.queryId),
    );
    if (
      state &&
      state.before.enabled === 1 &&
      state.after.enabled === 1 &&
      proofMatches(state.before) &&
      proofMatches(state.after) &&
      state.before.proof!.consumed === 0 &&
      state.after.proof!.consumed === 1 &&
      state.before.proof!.payoutId === proofState.after.proof!.payoutId &&
      state.after.proof!.payoutId === state.before.proof!.payoutId
    )
      candidates.push({ node, state });
  }
  if (candidates.length !== 1)
    return missing("t3_recovery_continuation_state_unverified", [
      ...base,
      ...requests,
    ]);
  const continuation = candidates[0],
    ns = [...base, continuation.node];
  const ack = (
    node: Node,
    destination: string,
    queryId: string,
    hash: string,
  ) =>
    node.raw.outMessages.flatMap((m, i) => {
      const a = w.burnAck(m),
        next = receiptFor(node, i);
      return addr(m.source) === node.account &&
        addr(m.destination) === destination &&
        !m.bounced &&
        a?.queryId === queryId &&
        a.amountRaw === request.amountRaw &&
        a.requestHash === hash &&
        next &&
        next.account === destination &&
        ok(next)
        ? [next]
        : [];
    });
  const roots = ack(continuation.node, hub.root, wireId, intentHash);
  if (roots.length !== 1) return missing("t3_recovery_root_ack_pending", ns);
  const rootAck = roots[0];
  ns.push(rootAck);
  const wallets = ack(rootAck, wallet.account, request.queryId, requestHash);
  if (wallets.length !== 1)
    return missing("t3_recovery_wallet_ack_pending", ns);
  const walletAck = wallets[0];
  ns.push(walletAck);
  const rootAcceptance = await boundary(
      input,
      rootAck,
      q.rootCodeHash,
      rootRead,
    ),
    walletAcceptance = await boundary(
      input,
      walletAck,
      q.walletCodeHash,
      readT3RecoveryWallet,
    );
  if (!rootAcceptance || !walletAcceptance)
    return missing("t3_recovery_acceptance_archive_unavailable", ns);
  if (
    ![rootAcceptance.before, rootAcceptance.after].every(rootTuple) ||
    rootAcceptance.after.summary.acceptedHash !== requestHash ||
    rootAcceptance.before.summary.totalSupplyRaw !==
      rootAcceptance.after.summary.totalSupplyRaw ||
    ![walletAcceptance.before, walletAcceptance.after].every(walletMatches) ||
    walletAcceptance.before.journal.status !== 4 ||
    walletAcceptance.after.journal.status !== 5 ||
    walletAcceptance.before.balanceRaw !== walletAcceptance.after.balanceRaw
  )
    return missing("t3_recovery_acceptance_state_unverified", ns);
  if (ns.some((n) => !input.chains.get(n.account)?.historyComplete))
    return missing("t3_recovery_related_history_incomplete", ns);
  const summarize = (s: NonNullable<typeof rootState>) => ({
    before: s.before.summary,
    after: s.after.summary,
    evidence: s.evidence,
  });
  const metadata: T3BurnRecovery = {
    status: "accepted",
    binding: q,
    continuationRequestBodyHash: bodyCell(continuation.node.raw.inMessage)!
      .hash()
      .toString("hex"),
    originalWallet: walletState,
    originalRoot: summarize(rootState),
    originalProof: proofState,
    continuation: continuation.state,
    rootAcceptance: summarize(rootAcceptance),
    walletAcceptance,
    evidence: ns.map(ref),
  };
  return {
    nodes: ns,
    metadata,
    hubAck: rootAck,
    accepted: walletAck,
    continuation: continuation.node,
    issue: undefined,
  };
}
