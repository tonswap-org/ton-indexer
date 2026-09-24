import { chainCoversTransaction } from "./project";
import { Cell } from "@ton/core";
import { createHash } from "node:crypto";
import type { Flow, Node, ProjectionInput } from "./project";
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from "./types";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import { NOTIFY, SETTLEMENT_INTERNAL, tokenWire, opcode, businessOpcode } from "./wire";
import {
  perpsControl,
  perpsMessage,
  perpsPositionKey,
  perpsRequest,
  perpsWalletAddress,
} from "./perpsWire";
import {
  perpsAccount,
  perpsPending,
  perpsPosition,
  readPerpsState,
} from "./perpsState";
import { provePerpsCounterpartyPayment } from "./perpsCounterparty";
import { perpsEconomics } from "./perpsEconomics";
import { readPerpsOracleExecution } from './perpsOracle';
export type LedgerPerpsEngine = {
  address: string;
  root: string;
  codeHash: string;
  walletCodeHash: string;
  ownerWallet: string;
  engineWallet: string;
};
export type PerpsLedgerOperation = {
  anchor: Node;
  kind: "perps_operation";
  queryId: string;
  confirmed: boolean;
  evidence: LedgerEvidenceRef[];
  issue?: string;
  settlement: NonNullable<LedgerEvent["settlement"]>;
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
const unique = (ns: Node[]) => [...new Map(ns.map((n) => [n.id, n])).values()];
export async function decodePerps(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: PerpsLedgerOperation[] = [],
    usedFlows = new Set<string>(),
    consumedRetries = new Set<string>();
  const complete = (ns: Node[]) =>
    unique(ns).every((n) => chainCoversTransaction(input.chains.get(n.account), n.raw));
  const readBoundary = async (engine: LedgerPerpsEngine, n: Node) => {
    try {
      if (!n.raw.prevTransactionLt || !n.raw.prevTransactionHash) return null;
      const [b, a] = await Promise.all([
        input.stateAt(
          engine.address,
          n.raw.prevTransactionLt,
          n.raw.prevTransactionHash,
        ),
        input.stateAt(engine.address, n.raw.lt, n.raw.hash),
      ]);
      if (
        !b?.state.dataBoc ||
        !a?.state.dataBoc ||
        [b, a].some(
          (s) =>
            !s.state.codeBoc ||
            Cell.fromBase64(s.state.codeBoc).hash().toString("hex") !==
              engine.codeHash,
        )
      )
        return null;
      const before = readPerpsState(b.state.dataBoc, engine.codeHash),
        after = readPerpsState(a.state.dataBoc, engine.codeHash);
      if (
        [before, after].some(
          (s) =>
            s.root !== engine.root ||
            s.walletCode.hash().toString("hex") !== engine.walletCodeHash ||
            perpsWalletAddress(s.walletCode, s.root, input.owner) !==
              engine.ownerWallet ||
            perpsWalletAddress(s.walletCode, s.root, engine.address) !==
              engine.engineWallet,
        )
      )
        return null;
      return {
        before,
        after,
        evidence: {
          kind: "perps_account_delta" as const,
          stateBeforeHash: before.dataHash,
          stateAfterHash: after.dataHash,
          beforeSeqno: b.seqno,
          afterSeqno: a.seqno,
          transactions: [ref(n)],
        },
      };
    } catch {
      return null;
    }
  };
  const boundaryCache = new Map<string, ReturnType<typeof readBoundary>>();
  const boundary = (engine: LedgerPerpsEngine, n: Node) => {
    let result = boundaryCache.get(n.id);
    if (!result) {
      result = readBoundary(engine, n);
      boundaryCache.set(n.id, result);
    }
    return result;
  };
  const edge = (
    n: Node,
    destination: string,
    op: number,
    wireId: string,
    amountRaw: string,
    ownerWallet: string,
  ) => {
    const found = n.raw.outMessages.flatMap((m, i) => {
      const v = perpsControl(m, op),
        next = receiptFor(n, i);
      return addr(m.source) === n.account &&
        addr(m.destination) === destination &&
        !m.bounced &&
        v?.queryId === wireId &&
        v.amountRaw === amountRaw &&
        v.destination === ownerWallet &&
        next &&
        ok(next)
        ? [next]
        : [];
    });
    return found.length === 1 ? found[0] : null;
  };
  for (const engine of input.perpsEngines?.values() ?? []) {
    const engineNodes = nodes
      .filter((n) => n.account === engine.address)
      .sort((a, b) => (BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1));
    for (const n of engineNodes) {
      if (consumedRetries.has(n.id)) continue;
      const notification = tokenWire(n.raw.inMessage),
        fundingRequest =
          notification?.op === NOTIFY
            ? perpsRequest(notification.forward)
            : null,
        direct = perpsMessage(n.raw.inMessage),
        request = fundingRequest ?? direct;
      if (!request) continue;
      const requestOwner = fundingRequest
        ? notification?.owner
        : (request.owner ?? addr(n.raw.inMessage?.source));
      if (requestOwner !== input.owner) continue;
      let deposit: Flow | undefined;
      if (fundingRequest) {
        const candidates = flows.filter(
          (f) =>
            f.source.account === engine.ownerWallet &&
            f.recipient.account === engine.engineWallet &&
            f.sourceAsset.master === engine.root &&
            f.recipientAsset.master === engine.root &&
            f.wire.amountRaw === notification?.amountRaw &&
            f.wire.queryId === notification?.queryId &&
            f.wire.forward.hash().equals(notification.forward.hash()) &&
            f.recipient.raw.outMessages.some(
              (_, i) => receiptFor(f.recipient, i)?.id === n.id,
            ),
        );
        if (
          candidates.length === 1 &&
          addr(n.raw.inMessage?.source) === engine.engineWallet &&
          notification?.senderWallet === engine.ownerWallet
        )
          deposit = candidates[0];
      }
      // Engine executions initiated by a keeper have no owner-wallet transaction.
      // Create an owner-scoped record without charging the engine's native fees to the owner.
      if (!n.event)
        n.event = {
          id: createHash("sha256")
            .update(`${input.network}:${input.owner}:perps:${n.id}`)
            .digest("hex"),
          network: input.network,
          account: input.owner,
          lt: n.raw.lt,
          hash: canonicalLedgerHash(n.raw.hash),
          txId: `${n.raw.lt}:${canonicalLedgerHash(n.raw.hash)}`,
          utime: n.raw.utime,
          status: ok(n) ? "success" : "failed",
          kind: "perps_operation",
          totalFeesRaw: "0",
          movements: [],
          actions: [],
          issues: [],
        };
      const group: Node[] = [n];
      if (deposit) group.push(deposit.source, deposit.recipient);
      for (const candidate of nodes)
        if (
          candidate.event &&
          candidate.raw.outMessages.some(
            (_, i) => receiptFor(candidate, i)?.id === n.id,
          )
        )
          group.push(candidate);
      const meta: NonNullable<NonNullable<LedgerEvent["settlement"]>["perps"]> =
        {
          engine: engine.address,
          engineCodeHash: engine.codeHash,
          root: engine.root,
          owner: input.owner,
          ownerWallet: engine.ownerWallet,
          engineWallet: engine.engineWallet,
          marketId: request.marketId,
          positionKey: perpsPositionKey(input.owner, request.marketId),
          queryId: request.queryId,
          fundingQueryId: fundingRequest ? notification!.queryId : undefined,
          request,
          outcome: "unresolved",
          depositRaw: deposit?.wire.amountRaw ?? "0",
          payout: { status: "none", amountRaw: "0", evidence: [] },
          counterpartyPayout: { status: "none", amountRaw: "0", evidence: [] },
          localNetworkFees: [],
        };
      const failedClose = request.operation === "close" && !fundingRequest &&
        n.raw.success === false && n.raw.status === "failed" && !n.raw.inMessage?.bounced;
      const intakeStates = ok(n) || failedClose ? await boundary(engine, n) : null;
      let states = intakeStates;
      let execution = n;
      let issue = !ok(n)
        ? "perps_execution_failed"
        : !states
          ? "perps_exact_state_unavailable"
          : undefined;
      const funded =
        ["open", "add_margin"].includes(request.operation) ||
        (request.operation === "modify" &&
          BigInt(request.marginRaw ?? "0") > 0n);
      const authenticated = fundingRequest
        ? Boolean(deposit && deposit.confirmed && funded)
        : !funded &&
          (request.owner
            ? ["liquidation", "adl"].includes(request.operation)
            : addr(n.raw.inMessage?.source) === input.owner);
      let oracle: Awaited<ReturnType<typeof readPerpsOracleExecution>> = null;
      const usesOracleContinuation = intakeStates !== null && intakeStates.before.markets.has(request.marketId) &&
        (['open', 'close'].includes(request.operation) || request.operation === 'modify' &&
          intakeStates.after.oracleRefreshes.get(request.marketId)?.get(input.owner)?.queryId === request.queryId);
      if (authenticated && intakeStates && ok(n) && usesOracleContinuation) {
        oracle = await readPerpsOracleExecution({ owner: input.owner, ownerWallet: engine.ownerWallet, engine: engine.address,
          request, original: n, intake: intakeStates, engineNodes, boundary: node => boundary(engine, node), receiptFor });
        if (oracle) {
          group.push(...oracle.nodes);
          const receipt = oracle.receipt;
          meta.oracleExecution = { status: receipt.order!.outcome === 1 ? 'pending' : receipt.order!.outcome === 2 ? 'accepted' : 'rejected',
            wireQueryId: receipt.wireQueryId, requestHash: receipt.requestHash, nativeBudgetRaw: receipt.order!.nativeBudgetRaw,
            requestedPool: receipt.order!.pool,
            reason: receipt.order!.reason, queued: ref(n), pool: oracle.pool ? ref(oracle.pool) : null,
            completed: oracle.execution ? ref(oracle.execution) : null, intakeEvidence: intakeStates.evidence,
            intake: { account: perpsAccount(intakeStates.before, input.owner),
              position: perpsPosition(intakeStates.before, input.owner, request.marketId),
              pending: perpsPending(intakeStates.before, engine.ownerWallet) } };
          const vault = intakeStates.after.riskVault, controller = intakeStates.after.markets.get(request.marketId)?.riskPolicy?.controller;
          const reservation = oracle.nodes.find(node => node.account === vault && businessOpcode(node.raw.inMessage) === 0x52564c54);
          const vaultResponse = oracle.nodes.find(node => node.account === engine.address && [0x5256414b, 0x52564e4b].includes(businessOpcode(node.raw.inMessage) ?? 0));
          if (vault && controller && reservation && vaultResponse) {
            const policyRequest = oracle.nodes.find(node => node.account === controller && businessOpcode(node.raw.inMessage) === 0x52505251);
            const policyResponse = oracle.nodes.find(node => node.account === engine.address && businessOpcode(node.raw.inMessage) === 0x52505253);
            meta.oracleExecution.admission = { version: 'perps-funded-admission-v1', vault, controller,
              reservation: ref(reservation), vaultResponse: ref(vaultResponse),
              policyRequest: policyRequest ? ref(policyRequest) : null, policyResponse: policyResponse ? ref(policyResponse) : null };
          }
          states = oracle.states;
          if (oracle.execution) execution = oracle.execution;
        }
      }
      let economics =
        states && authenticated && ok(n)
          ? perpsEconomics(
              states.before,
              states.after,
              input.owner,
              engine.ownerWallet,
              request,
              meta.depositRaw,
            )
          : null;
      if (usesOracleContinuation && economics) {
        // Linear OPEN/CLOS admission happens only at the authenticated oracle
        // continuation. An ingress refund is still a provable rejection.
        if ((economics.outcome === 'accepted' && !oracle?.execution) ||
            (oracle && (oracle.receipt.order!.outcome === 1 ||
              economics.outcome !== (oracle.receipt.order!.outcome === 2 ? 'accepted' : 'rejected')))) economics = null;
      }
      if (states) {
        meta.before = {
          account: perpsAccount(states.before, input.owner),
          position: perpsPosition(states.before, input.owner, request.marketId),
          pending: perpsPending(states.before, engine.ownerWallet),
        };
        meta.after = {
          account: perpsAccount(states.after, input.owner),
          position: perpsPosition(states.after, input.owner, request.marketId),
          pending: perpsPending(states.after, engine.ownerWallet),
        };
        meta.stateEvidence = states.evidence;
      }
      // A direct CLOSE carries no collateral. A failed VM execution can only
      // terminally reject it when the exact qualified state is unchanged and a
      // successful owner transaction delivered the original request.
      const rejectedClose = Boolean(failedClose && authenticated && states &&
        states.before.dataHash === states.after.dataHash &&
        group.some(member => member.account === input.owner && ok(member) &&
          member.raw.outMessages.some((_, index) => receiptFor(member, index)?.id === n.id)));
      if (!authenticated) issue = "perps_request_identity_unverified";
      else if (oracle && !oracle.execution) issue = 'perps_oracle_execution_pending';
      else if (states && !economics && !rejectedClose)
        issue = "perps_economic_conservation_unverified";
      const needsCustodyHistory = BigInt(meta.depositRaw) > 0n || BigInt(economics?.payoutContributionRaw ?? '0') > 0n;
      const verified = Boolean(
        (economics || rejectedClose) &&
          complete(group) &&
          (!needsCustodyHistory ||
            (input.chains.get(engine.ownerWallet)?.historyComplete || input.chains.get(engine.ownerWallet)?.verifiedRange) &&
            (input.chains.get(engine.engineWallet)?.historyComplete || input.chains.get(engine.engineWallet)?.verifiedRange)),
      );
      if ((economics || rejectedClose) && !verified) issue = "perps_related_history_incomplete";
      if (verified && rejectedClose) {
        meta.outcome = "rejected";
        meta.execution = { status: "failed", transaction: ref(n) };
        issue = undefined;
      }
      if (verified && states && economics) {
        meta.outcome = economics.outcome;
        meta.economics = economics;
        if (deposit) usedFlows.add(deposit.id);
        const amount = BigInt(economics.payoutContributionRaw);
        let pending = meta.after!.pending,
          dispatch = execution;
        meta.payout = {
          status:
            amount === 0n
              ? "none"
              : meta.before!.pending
                ? "aggregate_unresolved"
                : "pending",
          amountRaw: amount.toString(),
          wireId: pending?.wireId,
          evidence: [],
        };
        // A READY liability has no wire yet. Follow exact journal boundaries until
        // the same sole liability is assigned its wire; any additional contribution
        // makes individual payout attribution unresolved.
        if (
          amount > 0n &&
          !meta.before!.pending &&
          pending?.kind === 2 &&
          pending.wireId === "0" &&
          pending.queuedRaw === "0" &&
          pending.amountRaw === amount.toString()
        ) {
          for (const later of engineNodes.filter(
            (v) => BigInt(v.raw.lt) > BigInt(execution.raw.lt),
          )) {
            const next = await boundary(engine, later);
            if (!next) break;
            const bp = perpsPending(next.before, engine.ownerWallet),
              ap = perpsPending(next.after, engine.ownerWallet);
            const exact = (v: typeof bp) =>
              v?.owner === input.owner &&
              v.amountRaw === amount.toString() &&
              v.queuedRaw === "0";
            if (!exact(bp) || !exact(ap)) {
              meta.payout.status = "aggregate_unresolved";
              break;
            }
            if (
              bp!.kind === 2 &&
              bp!.wireId === "0" &&
              ap!.kind === 3 &&
              BigInt(ap!.wireId) > 0n
            ) {
              const retry = perpsMessage(later.raw.inMessage);
              if (
                !ok(later) ||
                retry?.operation !== "claim" ||
                addr(later.raw.inMessage?.source) !== input.owner ||
                JSON.stringify(perpsAccount(next.before, input.owner)) !==
                  JSON.stringify(perpsAccount(next.after, input.owner))
              )
                break;
              pending = ap;
              dispatch = later;
              meta.payout.wireId = ap!.wireId;
              group.push(later);
              for (const caller of nodes)
                if (
                  caller.event &&
                  caller.raw.outMessages.some(
                    (_, i) => receiptFor(caller, i)?.id === later.id,
                  )
                )
                  group.push(caller);
              consumedRetries.add(later.id);
              break;
            }
            if (
              bp!.kind !== 2 ||
              ap!.kind !== 2 ||
              bp!.wireId !== "0" ||
              ap!.wireId !== "0"
            )
              break;
          }
        }
        const candidates =
          amount > 0n &&
          !meta.before!.pending &&
          pending &&
          pending.amountRaw === amount.toString() &&
          pending.queuedRaw === "0"
            ? flows.filter(
                (f) =>
                  f.wire.op === SETTLEMENT_INTERNAL &&
                  f.wire.queryId === pending.wireId &&
                  f.wire.amountRaw === amount.toString() &&
                  f.source.account === engine.engineWallet &&
                  f.recipient.account === engine.ownerWallet &&
                  f.sourceAsset.master === engine.root &&
                  f.recipientAsset.master === engine.root &&
                  dispatch.raw.outMessages.some(
                    (_, i) => receiptFor(dispatch, i)?.id === f.source.id,
                  ),
              )
            : [];
        if (candidates.length === 1) {
          const flow = candidates[0],
            ack = edge(
              flow.recipient,
              engine.engineWallet,
              0x4a534143,
              pending!.wireId,
              amount.toString(),
              engine.ownerWallet,
            ),
            success = ack
              ? edge(
                  ack,
                  engine.address,
                  0x4a535543,
                  pending!.wireId,
                  amount.toString(),
                  engine.ownerWallet,
                )
              : null,
            finalize = success
              ? edge(
                  success,
                  engine.engineWallet,
                  0x4a53464e,
                  pending!.wireId,
                  amount.toString(),
                  engine.ownerWallet,
                )
              : null,
            finalized = finalize
              ? edge(
                  finalize,
                  engine.address,
                  0x4a53464b,
                  pending!.wireId,
                  amount.toString(),
                  engine.ownerWallet,
                )
              : null;
          const terminal = finalized ? await boundary(engine, finalized) : null,
            bp = terminal
              ? perpsPending(terminal.before, engine.ownerWallet)
              : null,
            ap = terminal
              ? perpsPending(terminal.after, engine.ownerWallet)
              : null;
          const cleared =
            bp &&
            [10, 12].includes(bp.kind) &&
            bp.owner === input.owner &&
            bp.wireId === pending!.wireId &&
            bp.amountRaw === amount.toString() &&
            (bp.queuedRaw === "0"
              ? !ap
              : ap?.kind === 2 &&
                ap.owner === input.owner &&
                ap.wireId === "0" &&
                ap.amountRaw === bp.queuedRaw &&
                ap.queuedRaw === "0");
          if (
            ack &&
            success &&
            finalize &&
            finalized &&
            terminal &&
            cleared &&
            flow.confirmed &&
            complete([
              flow.source,
              flow.recipient,
              ack,
              success,
              finalize,
              finalized,
            ])
          ) {
            const evidence = [
              flow.source,
              flow.recipient,
              ack,
              success,
              finalize,
              finalized,
            ];
            group.push(...evidence);
            meta.payout.status = "completed";
            meta.payout.evidence = evidence.map(ref);
            usedFlows.add(flow.id);
            for (const movement of flow.recipient.event?.movements ?? [])
              if (
                movement.id === `${flow.id}:in` &&
                movement.asset.kind === "jetton" &&
                movement.evidence.kind !== "native_message" && movement.evidence.kind !== "transaction_fee" && movement.evidence.kind !== "message_forward_fee" &&
                movement.asset.master === engine.root &&
                movement.direction === "in"
              ) {
                const tokenEvidence: Omit<typeof movement.evidence, "transactionStatus"> = movement.evidence;
                movement.purpose = "perps_payout";
                movement.evidence = {
                  ...tokenEvidence,
                  kind: "perps_payout",
                  transactions: unique(evidence).map(ref),
                  stateBeforeHash: terminal.before.dataHash,
                  stateAfterHash: terminal.after.dataHash,
                  beforeSeqno: terminal.evidence.beforeSeqno,
                  afterSeqno: terminal.evidence.afterSeqno,
                };
              }
          }
        }
        if (economics.counterpartySettlement && BigInt(economics.counterpartySettlement.amountRaw) > 0n) {
          const payment = await provePerpsCounterpartyPayment({ input, engine, execution, states, nodes, flows,
            marketId: request.marketId, claim: economics.counterpartySettlement, receiptFor,
            boundary: node => boundary(engine, node) });
          meta.counterpartyPayout = payment.payout;
          if (payment.payout.status !== 'completed') issue = 'perps_counterparty_payout_pending';
          group.push(...payment.nodes);
          if (payment.flow) {
            usedFlows.add(payment.flow.id);
            for (const movement of payment.flow.recipient.event?.movements ?? []) {
              if (movement.id === `${payment.flow.id}:in` && movement.asset.kind === 'jetton' &&
                  movement.asset.master === engine.root && movement.direction === 'in') {
                movement.purpose = 'perps_counterparty_profit';
              }
            }
          }
        }
        const ownerAsset = input.wallets.get(engine.ownerWallet)!;
        const movement = (
          balanceType: "collateral" | "funding" | "payout",
          delta: bigint,
          evidence: LedgerMovement["evidence"],
        ) => {
          if (delta === 0n) return;
          n.event!.movements.push({
            id: `${n.event!.id}:perps:${balanceType}`,
            direction: delta > 0n ? "in" : "out",
            purpose:
              balanceType === "funding"
                ? "perps_funding"
                : balanceType === "payout"
                  ? "perps_payout"
                  : "perps_collateral",
            asset: {
              kind: "perps_balance",
              id: `${input.network}:perps-balance:${engine.address}:${input.owner}:${balanceType}`,
              master: engine.root,
              owner: input.owner,
              engine: engine.address,
              balanceType,
              decimals: ownerAsset?.decimals,
            },
            amountRaw: (delta < 0n ? -delta : delta).toString(),
            evidence,
          });
        };
        const assessedFee = BigInt(economics.tradeFeeRaw);
        const bookFee = request.operation === "open" ? 0n : assessedFee;
        // Split an assessed fee from the existing net debit, never append a
        // second debit for the same wealth change. OPEN pays from its deposit;
        // modify/close pay from booked collateral.
        if (bookFee > 0n)
          n.event.movements.push({
            id: `${n.event.id}:perps:assessed-fee`,
            direction: "fee",
            purpose: "protocol_fee",
            asset: {
              kind: "perps_balance",
              id: `${input.network}:perps-balance:${engine.address}:${input.owner}:collateral`,
              master: engine.root,
              owner: input.owner,
              engine: engine.address,
              balanceType: "collateral",
              decimals: ownerAsset?.decimals,
            },
            amountRaw: bookFee.toString(),
            evidence: states.evidence,
          });
        if (assessedFee > 0n && request.operation === "open" && deposit) {
          const debit = deposit.source.event?.movements.find(
            (m) => m.id === `${deposit.id}:out`,
          );
          if (debit && debit.evidence.kind !== "native_message" && debit.evidence.kind !== "transaction_fee" && debit.evidence.kind !== "message_forward_fee") {
            const tokenEvidence: Omit<typeof debit.evidence, "transactionStatus"> = debit.evidence;
            debit.amountRaw = (
              BigInt(debit.amountRaw) - assessedFee
            ).toString();
            deposit.source.event!.movements.push({
              ...debit,
              id: `${deposit.id}:assessed-fee`,
              direction: "fee",
              purpose: "protocol_fee",
              amountRaw: assessedFee.toString(),
              evidence: {
                ...tokenEvidence,
                ...states.evidence,
                transactions: [
                  ref(deposit.source),
                  ref(deposit.recipient),
                  ref(execution),
                ],
              },
            });
          }
        }
        movement(
          "collateral",
          BigInt(meta.after!.account.collateralRaw) -
            BigInt(meta.before!.account.collateralRaw) +
            bookFee,
          states.evidence,
        );
        movement(
          "funding",
          BigInt(meta.after!.account.pendingFundingRaw) -
            BigInt(meta.before!.account.pendingFundingRaw),
          states.evidence,
        );
        if (deposit)
          for (const m of deposit.source.event?.movements ?? [])
            if (
              m.asset.kind === "jetton" &&
              m.asset.master === engine.root &&
              m.direction === "out"
            )
              m.purpose = "perps_collateral";
        if (
          meta.payout.status === "pending" ||
          meta.payout.status === "aggregate_unresolved"
        )
          n.event.issues.push("perps_payout_settlement_pending");
      }
      for (const member of unique(group)) if (member.event) attach(n, member);
      meta.localNetworkFees = unique(group).map((member) => ({
        transaction: ref(member),
        amountRaw: member.raw.totalFeesRaw ?? null,
        includedInOwnerFeeMovements:
          member.account !== engine.address && Boolean(member.event),
      }));
      const evidence = unique(group).map(ref);
      operations.push({
        anchor: n,
        kind: "perps_operation",
        queryId: request.queryId,
        confirmed: verified,
        evidence,
        issue,
        settlement: {
          status: verified ? "confirmed" : "incomplete",
          protocol: "perps",
          operation: "perps_operation",
          queryId: request.queryId,
          perps: meta,
          evidence,
        },
      });
    }
  }
  return { operations, usedFlows };
}
