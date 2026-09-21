import {
  decodePerps,
  type LedgerPerpsEngine,
  type PerpsLedgerOperation,
} from "./perps";
import { decodeLaunchpadRefunds, type LaunchpadRefundOperation } from "./launchpad";
import { decodeLaunchpadContributions, type LaunchpadParticipationOperation } from "./launchpadContributions";
import type { LedgerLaunchpadSale } from "./launchpadModels";
import { readLaunchpadRequests } from "./launchpadRequests";
import { PERPS_USER_OPS } from "./perpsWire";
import {
  decodeOptionExercises,
  type OptionLifecycleOperation,
} from "./optionLifecycle";
import { decodeOptionRefunds } from "./optionRefunds";
import { decodeOptionAborts } from "./optionAborts";
import { OPTION_OWNER_ABORT } from "./optionAbortWire";
import {
  OPTION_EXERCISE,
  OPTION_CLAIM_RECEIPT,
  OPTION_CLAIM_RETRY,
  OPTION_NATIVE_REFUND,
} from "./optionLifecycleWire";
import { decodeT3, type LedgerT3Hub, type T3LedgerOperation } from "./t3";
import { T3_OPS, DEPOSIT_NOTE, RECEIVER_PAYOUT } from "./t3Wire";
import {
  decodeOptionPurchases,
  type LedgerOptionFactory,
  type OptionLedgerOperation,
} from "./options";
import { createHash } from "node:crypto";
import { Cell } from "@ton/core";
import type { RawTransaction } from "../data/dataSource";
import type { Network } from "../models";
import { classifyTransaction } from "../utils/txClassifier";
import { createDlmmProofGraph } from "./dlmmProof";
import { verifyDlmmSwapExecution } from "./dlmmSwapProof";
import type { OpcodeSets } from "../utils/opcodes";
import {
  canonicalLedgerAddress,
  canonicalLedgerHash,
  normalizeLedgerEvent,
} from "./normalize";
import type {
  LedgerAsset,
  LedgerEvent,
  LedgerEvidenceRef,
  LedgerMovement,
  LedgerProjection,
  LedgerProjectionScope,
  LedgerRelatedAccount,
} from "./types";
import type { LedgerStateSnapshot } from "./archive";
import { dlmmPendingLiquidityKey, readDlmmLiquidityState } from "./dlmmLiquidityState";
import { projectDlmmLiquidity, verifyDlmmDeposit } from "./dlmmLiquidity";
import type { MarketNode } from "./marketTypes";
import { matchPhysicalJettonFlow } from "./jettonFlow";
import {
  INTERNAL,
  NOTIFY,
  REMOVE,
  COLLECT,
  COLLECT_TO,
  TOKEN_CONTROL_OPS,
  TRANSFER,
  WITHDRAW_COMPLETE,
  bodyCell,
  businessOpcode,
  nativeFundingRefund,
  dlmmLiquidityNotificationCommitment,
  messageKey,
  opcode,
  protocolForward,
  unresolvedPerpsForward,
  unresolvedLaunchpadForward,
  tokenWire,
  type TokenWire,
} from "./wire";

export type LedgerChain = LedgerRelatedAccount & {
  transactions: RawTransaction[];
  checkedAt?: string | null;
  /** Complete linked interval at one pinned masterchain boundary, not older history. */
  verifiedRange?: { fromUtime: number; toUtime: number };

};
export function chainCoversTransaction(chain: LedgerChain | undefined, tx: RawTransaction): boolean {
  return Boolean(chain && (chain.historyComplete || (chain.verifiedRange &&
    tx.utime >= chain.verifiedRange.fromUtime && tx.utime < chain.verifiedRange.toUtime)));
}
export type LedgerPool = {
  address: string;
  tokenT: string;
  tokenX: string;
  codeHash: string;
};
export type ProjectionInput = {
  network: Network;
  owner: string;
  perpsEngines?: Map<string, LedgerPerpsEngine>;
  launchpadSales?: Map<string, LedgerLaunchpadSale>;
  launchpadControllers?: string[];
  t3Hubs?: Map<string, LedgerT3Hub>;
  chains: Map<string, LedgerChain>;
  wallets: Map<string, LedgerAsset>;
  pools: Map<string, LedgerPool>;
  opcodes: OpcodeSets;
  optionFactories?: Map<string, LedgerOptionFactory>;
  /** Configured controllers remain known protocol scope even when qualification fails. */
  optionControllers?: string[];
  stateAt: (
    account: string,
    lt: string,
    hash: string,
  ) => Promise<LedgerStateSnapshot | null>;
};
export type Node = {
  account: string;
  raw: RawTransaction;
  id: string;
  event?: LedgerEvent;
};
export type Flow = {
  id: string;
  source: Node;
  recipient: Node;
  sourceAsset: LedgerAsset;
  recipientAsset: LedgerAsset;
  wire: TokenWire;
  outIndex: number;
  confirmed: boolean;
};
const address = (value?: string) => {
  try {
    return value ? canonicalLedgerAddress(value) : null;
  } catch {
    return null;
  }
};
const success = (raw: RawTransaction) =>
  raw.success && (!raw.status || raw.status === "success");
const ref = (n: Node): LedgerEvidenceRef => ({
  account: n.account,
  lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash),
  utime: n.raw.utime,
});
const uniqueRefs = (refs: LedgerEvidenceRef[]) => [
  ...new Map(
    refs.map((item) => [`${item.account}:${item.lt}:${item.hash}`, item]),
  ).values(),
];
const nodeId = (account: string, raw: RawTransaction) =>
  `${account}:${raw.lt}:${canonicalLedgerHash(raw.hash)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const basicIssues = new Set([
  "settlement_not_decoded",
  "related_account_coverage_unverified",
  "transaction_not_decoded",
]);

export async function projectOwnerLedger(
  input: ProjectionInput,
): Promise<LedgerProjection> {
  const { network, owner, chains, wallets, pools, opcodes } = input;
  const owned = new Set([
    owner,
    ...[...chains.values()]
      .filter((c) => c.role === "controlled_contract")
      .map((c) => c.account),
    ...[...wallets]
      .filter(
        ([, asset]) => asset.owner === owner || asset.controller === owner,
      )
      .map(([wallet]) => wallet),
  ]);
  // This is the same set used below to admit physical nodes, including owned wallets with no observed transactions.
  // Discovery roles such as owned_jetton_wallet alone do not establish projection ownership.
  const projectionScope: LedgerProjectionScope = {
    kind: "owner",
    owner,
    physicalAccounts: [...owned].sort(),
  };
  if (projectionScope.physicalAccounts.some((account) => canonicalLedgerAddress(account) !== account))
    throw new Error("Projection accounts must use canonical raw TON addresses.");
  const ownsAsset = (asset: LedgerAsset) =>
    asset.owner === owner || asset.controller === owner;
  const pendingTokenEvidence = new Map<string, LedgerMovement[]>();
  const nodes: Node[] = [];
  const incoming = new Map<string, Node[]>();
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    const p = parents.get(id);
    if (!p || p === id) return id;
    const root = find(p);
    parents.set(id, root);
    return root;
  };
  const merge = (a: Node, b: Node) => {
    if (!a.event || !b.event) return;
    const ra = find(a.id),
      rb = find(b.id);
    if (ra !== rb) parents.set(rb, ra);
  };
  const mark = (n: Node, issue: string) => {
    if (n.event && !n.event.issues.includes(issue)) n.event.issues.push(issue);
  };
  for (const chain of chains.values())
    for (const raw of chain.transactions) {
      const node: Node = {
        account: chain.account,
        raw,
        id: nodeId(chain.account, raw),
      };
      if (owned.has(chain.account)) {
        node.event = await normalizeLedgerEvent(
          network,
          chain.account,
          raw,
          opcodes,
          async (wallet) => wallets.get(wallet) ?? null,
        );
        node.event.account = owner;
        // Owner notifications repeat the credit already recorded in the controlled wallet.
        pendingTokenEvidence.set(
          node.id,
          node.event.movements.filter((m) => m.asset.kind !== "native"),
        );
        node.event.movements = node.event.movements.filter(
          (m) =>
            m.asset.kind === "native" &&
            !(
              m.source &&
              m.destination &&
              owned.has(m.source) &&
              owned.has(m.destination)
            ),
        );

      }
      nodes.push(node);
      parents.set(node.id, node.id);
      const key = messageKey(raw.inMessage);
      if (key) incoming.set(key, [...(incoming.get(key) ?? []), node]);
    }
  const receiptFor = (node: Node, index: number) => {
    const key = messageKey(node.raw.outMessages[index]);
    const matches = key ? incoming.get(key) : null;
    return matches?.length === 1 ? matches[0] : null;
  };
  // Physical owner/custody message edges preserve fees and every transaction hash.
  for (const n of nodes)
    if (n.event)
      n.raw.outMessages.forEach((_msg, index) => {
        const r = receiptFor(n, index);
        if (r?.event) merge(n, r);
      });
  const creditedNodes = new Set<string>();
  const flows: Flow[] = [];
  const settlementSeen = new Map<string, Flow>();
  const touched = new Set<string>();
  for (const source of nodes) {
    const sourceAsset = wallets.get(source.account);
    if (!sourceAsset) continue;
    for (const [index, msg] of source.raw.outMessages.entries()) {
      const physical = matchPhysicalJettonFlow(source, index, wallets, receiptFor(source, index));
      if (physical.kind === 'irrelevant') continue;
      if (physical.kind === 'unresolved') {
        mark(source, physical.issue);
        if (physical.recipient) mark(physical.recipient, physical.issue);
        continue;
      }
      const { wire, request, destination, recipientAsset, recipient, typed } = physical;
      if (!ownsAsset(sourceAsset) && !ownsAsset(recipientAsset)) continue;
      if (sourceAsset.decimals === undefined) {
        mark(source, "jetton_decimals_unresolved");
        mark(recipient, "jetton_decimals_unresolved");
      }
      const id = sha(
        `${network}:${source.account}:${destination}:${typed ? "settlement:" + wire.queryId : messageKey(msg)}`,
      );
      const previous = typed ? settlementSeen.get(id) : null;
      creditedNodes.add(recipient.id);
      if (previous) {
        if (
          previous.wire.amountRaw !== wire.amountRaw ||
          previous.wire.forward.hash().compare(wire.forward.hash()) !== 0
        ) {
          mark(previous.source, "jetton_replay_conflict");
          mark(previous.recipient, "jetton_replay_conflict");
          previous.confirmed = false;
        }
        if (source.event) {
          merge(previous.source, source);
          touched.add(source.id);
        }
        if (recipient.event) {
          merge(previous.recipient, recipient);
          touched.add(recipient.id);
        }
        continue;
      }
      const confirmed = Boolean(
        chainCoversTransaction(chains.get(source.account), source.raw) &&
          chainCoversTransaction(chains.get(recipient.account), recipient.raw),
      );
      const flow: Flow = {
        id,
        source,
        recipient,
        sourceAsset,
        recipientAsset,
        wire,
        outIndex: index,
        confirmed,
      };
      flows.push(flow);
      if (typed) settlementSeen.set(id, flow);
      const evidence = {
        kind: "jetton_transfer" as const,
        messageIndex: index,
        opcode: wire.op,
        bodyHash: bodyCell(msg)!.hash().toString("hex"),
        requestBodyHash: bodyCell(source.raw.inMessage)!.hash().toString("hex"),
        queryId: request.queryId,
        transactions: [ref(source), ref(recipient)],
      };
      if (ownsAsset(sourceAsset) && !ownsAsset(recipientAsset) && source.event)
        source.event.movements.push({
          id: `${id}:out`,
          direction: "out",
          asset: sourceAsset,
          amountRaw: wire.amountRaw,
          source: sourceAsset.owner,
          destination: recipientAsset.owner,
          evidence,
        });
      if (
        ownsAsset(recipientAsset) &&
        !ownsAsset(sourceAsset) &&
        recipient.event
      )
        recipient.event.movements.push({
          id: `${id}:in`,
          direction: "in",
          asset: recipientAsset,
          amountRaw: wire.amountRaw,
          source: sourceAsset.owner,
          destination: recipientAsset.owner,
          evidence,
        });
      if (source.event) touched.add(source.id);
      if (recipient.event) touched.add(recipient.id);
      if (!confirmed) {
        mark(source, "related_account_history_incomplete");
        mark(recipient, "related_account_history_incomplete");
      }
    }
  }
  // A source-root mint is accepted only by a verified canonical recipient wallet;
  // its economic purpose remains unresolved for rewards and derivatives.
  for (const node of nodes)
    if (node.event && wallets.get(node.account)?.owner === owner) {
      const asset = wallets.get(node.account)!;
      const wire = tokenWire(node.raw.inMessage);
      if (
        wire?.op === INTERNAL &&
        success(node.raw) &&
        address(node.raw.inMessage?.source) === asset.master
      ) {
        node.event.movements.push({
          id: `${node.event.id}:mint-credit`,
          direction: "in",
          asset,
          amountRaw: wire.amountRaw,
          source: asset.master,
          destination: owner,
          evidence: {
            kind: "jetton_internal_transfer",
            opcode: INTERNAL,
            bodyHash: bodyCell(node.raw.inMessage)!.hash().toString("hex"),
            transactions: [ref(node)],
          },
        });
        mark(node, "mint_purpose_unresolved");
        touched.add(node.id);
      }
    }
  type Operation = {
    anchor: Node;
    kind: "swap" | "lp_deposit" | "lp_withdraw" | "lp_fee_collect";
    settlement?: LedgerEvent["settlement"];
    pool: string;
    queryId?: string;
    confirmed: boolean;
    evidence: LedgerEvidenceRef[];
    issue?: string;
  };
  const operations: (
    | Operation
    | OptionLedgerOperation
    | OptionLifecycleOperation
    | T3LedgerOperation
    | PerpsLedgerOperation
    | LaunchpadRefundOperation
    | LaunchpadParticipationOperation
  )[] = [];
  const usedFlows = new Set<string>();
  const relatedReady = (members: Node[]) =>
    members.every((n) => chains.get(n.account)?.historyComplete);
  const attach = (a: Node, b: Node) => {
    merge(a, b);
    touched.add(a.id);
    touched.add(b.id);
  };
  const flowForNotification = (node: Node) => {
    const notification = tokenWire(node.raw.inMessage);
    if (!notification || notification.op !== NOTIFY) return null;
    const matches = flows.filter(
      (flow) =>
        flow.sourceAsset.owner === owner &&
        flow.recipient.account === address(node.raw.inMessage?.source) &&
        flow.wire.queryId === notification.queryId &&
        flow.wire.amountRaw === notification.amountRaw &&
        flow.wire.owner === notification.owner &&
        (notification.senderWallet === undefined ||
          notification.senderWallet === flow.source.account) &&
        flow.wire.forward.hash().equals(notification.forward.hash()) &&
        flow.recipient.raw.outMessages.some(
          (_, index) => receiptFor(flow.recipient, index)?.id === node.id,
        ),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const depositState = (pool: LedgerPool, group: Array<{node: Node; flow: Flow}>, proofNodes: MarketNode[]) => {
    try {
      const first = proofNodes.find(node => nodeId(node.account, node.raw) === group[0].node.id)!;
      const identity = readDlmmLiquidityState(first.before!.state.dataBoc!).market;
      const verified = verifyDlmmDeposit({network, pool: pool.address, poolCodeHash: pool.codeHash, walletCodeHash: identity.walletCodeHash,
        tokenT: pool.tokenT, tokenX: pool.tokenX}, proofNodes, owner, group.map(item => ref(item.node)));
      const contributions = verified.metadata.contributions.map(contribution => {
        const matched = group.filter(item => item.flow.source.account === contribution.sourceWallet &&
          item.flow.source.raw.lt === contribution.debit.lt && canonicalLedgerHash(item.flow.source.raw.hash) === contribution.debit.hash);
        if (matched.length !== 1) throw new Error('dlmm_deposit_movement_identity_unresolved');
        const movementId = `${matched[0].flow.id}:out`;
        const movement = matched[0].flow.source.event?.movements.find(value => value.id === movementId);
        if (!movement || movement.direction !== 'out' || movement.asset.id !== contribution.assetId || movement.amountRaw !== contribution.amountRaw ||
          movement.source !== owner || movement.destination !== pool.address) throw new Error('dlmm_deposit_movement_unverified');
        return {...contribution, movementId};
      });
      return {delta: BigInt(verified.amounts.mintedSharesRaw), before: verified.before, after: verified.after,
        a: {dataHash: verified.beforeDataHash}, b: {dataHash: verified.afterDataHash}, evidence: verified.evidence,
        metadata: {...verified.metadata, contributions}};
    } catch { return null; }
  };
  const addPosition = (
    anchor: Node,
    pool: LedgerPool,
    binId: number,
    amountRaw: string,
    direction: "in" | "out",
    evidence: LedgerMovement["evidence"],
  ) =>
    anchor.event!.movements.push({
      id: sha(
        `${network}:${owner}:${pool.address}:${binId}:${anchor.id}:${direction}`,
      ),
      direction,
      asset: {
        kind: "lp_position",
        id: `${network}:dlmm-position:${pool.address}:${binId}`,
        pool: pool.address,
        binId,
        owner,
        decimals: 0,
        symbol: "DLMM shares",
      },
      amountRaw,
      source: direction === "out" ? owner : pool.address,
      destination: direction === "in" ? owner : pool.address,
      evidence,
    });
  for (const pool of pools.values()) {
    const poolNodes = nodes.filter((n) => n.account === pool.address);
    let swapProof: ReturnType<typeof createDlmmProofGraph> | null = null;
    const swapGraph = async () => {
      if (swapProof) return swapProof;
      const proofNodes: MarketNode[] = await Promise.all(nodes.map(async node => {
        const get = async (lt?: string, hash?: string) => { try { return lt && hash ? await input.stateAt(node.account, lt, hash) : null; } catch { return null; } };
        const [before, after] = await Promise.all([get(node.raw.prevTransactionLt, node.raw.prevTransactionHash), get(node.raw.lt, node.raw.hash)]);
        return {account: node.account, raw: node.raw, before, after};
      }));
      const poolState = proofNodes.find(node => node.account === pool.address && node.before?.state.dataBoc);
      if (!poolState) throw Error('swap_archive_missing');
      const walletCodeHash = readDlmmLiquidityState(poolState.before!.state.dataBoc!).market.walletCodeHash;
      return swapProof = createDlmmProofGraph({network, pool: pool.address, poolCodeHash: pool.codeHash, walletCodeHash,
        tokenT: pool.tokenT, tokenX: pool.tokenX}, proofNodes);
    };
    const deposits = new Map<
      string,
      Array<{ node: Node; flow: Flow; binId: number; queryId: string }>
    >();
    for (const node of poolNodes) {
      if (!success(node.raw)) continue;
      const notification = tokenWire(node.raw.inMessage),
        forward = notification ? protocolForward(notification.forward) : null;
      if (!notification || !forward) continue;
      const inputFlow = flowForNotification(node);
      if (!inputFlow) continue;
      if (forward.operation === "lp_deposit") {
        if (
          (forward.owner ?? notification.owner) !== owner ||
          forward.binId === undefined
        )
          continue;
        const key = `${forward.queryId}:${forward.binId}`;
        deposits.set(key, [
          ...(deposits.get(key) ?? []),
          {
            node,
            flow: inputFlow,
            binId: forward.binId,
            queryId: forward.queryId,
          },
        ]);
        continue;
      }
      if (forward.owner !== owner) continue;
      let qualified: LedgerEvent['settlement'];
      let swapEvidence = uniqueRefs([ref(node), ref(inputFlow.source), ref(inputFlow.recipient)]);
      try {
        const graph = await swapGraph();
        const acceptance = graph.nodes.find(candidate => nodeId(candidate.account, candidate.raw) === node.id)!;
        const proof = verifyDlmmSwapExecution({network, pool: pool.address, poolCodeHash: pool.codeHash,
          walletCodeHash: readDlmmLiquidityState(acceptance.before!.state.dataBoc!).market.walletCodeHash,
          tokenT: pool.tokenT, tokenX: pool.tokenX}, graph, acceptance);
        const matched = proof.settlements.map(settlement => {
          const candidates = flows.filter(flow => flow.source.account === settlement.debit.account && flow.source.raw.lt === settlement.debit.lt &&
            canonicalLedgerHash(flow.source.raw.hash) === canonicalLedgerHash(settlement.debit.hash) &&
            flow.recipient.account === settlement.credit.account && flow.recipient.raw.lt === settlement.credit.lt &&
            canonicalLedgerHash(flow.recipient.raw.hash) === canonicalLedgerHash(settlement.credit.hash) && flow.wire.amountRaw === settlement.amountRaw);
          if (candidates.length !== 1 || !candidates[0].confirmed) throw Error('swap_physical_flow_unresolved');
          return {settlement, flow: candidates[0]};
        });
        const evidence = uniqueRefs([ref(node), ref(inputFlow.source), ref(inputFlow.recipient),
          ...proof.settlements.flatMap(value => [value.request, value.debit, value.credit, value.acknowledged, value.walletFinalized, value.poolFinalized])]
          .map(value => ({...value, hash: canonicalLedgerHash(value.hash)})));
        if (!inputFlow.confirmed || proof.notice.owner !== owner || proof.forward.recipient !== owner ||
          proof.paid.toString() !== inputFlow.wire.amountRaw || !evidence.every(value => chains.get(value.account)?.historyComplete)) throw Error('swap_history_incomplete');
        for (const {flow} of matched) { attach(inputFlow.source, flow.recipient); usedFlows.add(flow.id); }
        const output = matched.find(value => value.settlement.kind === 'swap_output');
        const refund = matched.find(value => value.settlement.kind === 'unused_input_refund');
        swapEvidence = evidence;
        qualified = {status: 'confirmed', protocol: 'dlmm', operation: 'swap', pool: pool.address, queryId: forward.queryId, evidence,
          dlmmSwap: {poolCodeHash: pool.codeHash, paidInputRaw: proof.paid.toString(), consumedInputRaw: proof.consumed.toString(), returnedInputRaw: proof.returned.toString(), outputRaw: proof.output.toString(),
            inputMovementId: `${inputFlow.id}:out`, outputMovementId: output ? `${output.flow.id}:in` : null, refundMovementId: refund ? `${refund.flow.id}:in` : null,
            acceptance: ref(node), finalizations: proof.settlements.map(value => ({...value.poolFinalized, hash: canonicalLedgerHash(value.poolFinalized.hash)}))}};
      } catch { /* Missing archive or any unmatched cash leg keeps the original swap unresolved. */ }
      usedFlows.add(inputFlow.id);
      operations.push({anchor: inputFlow.source, kind: 'swap', pool: pool.address, queryId: forward.queryId,
        confirmed: !!qualified, settlement: qualified, evidence: swapEvidence, issue: qualified ? undefined : 'swap_settlement_unconfirmed'});

    }
    const depositContributions = [...deposits.values()].flat();
    const selectedDeposits = new Set(depositContributions.flatMap(item => [item.node.id, item.flow.source.id, item.flow.recipient.id]));
    const depositProofNodes: MarketNode[] = depositContributions.length ? await Promise.all(nodes.map(async node => {
      const value: MarketNode = {account: node.account, raw: node.raw};
      if (selectedDeposits.has(node.id)) {
        const get = async (lt?: string, hash?: string) => {
          try { return lt && hash ? await input.stateAt(node.account, lt, hash) : null; } catch { return null; }
        };
        [value.before, value.after] = await Promise.all([
          get(node.raw.prevTransactionLt, node.raw.prevTransactionHash), get(node.raw.lt, node.raw.hash)]);
      }
      return value;
    })) : [];
    const depositArchives = new Map(depositProofNodes.map(node => [nodeId(node.account, node.raw), node]));
    type DepositGroup = {group: typeof depositContributions; delta: ReturnType<typeof depositState>};
    const depositOperations: DepositGroup[] = [];
    for (const bucket of deposits.values()) {
      bucket.sort((a, b) => BigInt(a.node.raw.lt) < BigInt(b.node.raw.lt) ? -1 : 1);
      const byCommitment = new Map<string, typeof bucket>();
      for (const item of bucket) {
        const commitment = dlmmLiquidityNotificationCommitment(item.node.raw.inMessage);
        if (commitment) byCommitment.set(commitment, [...(byCommitment.get(commitment) ?? []), item]);
      }
      const assigned = new Set<string>();
      for (const last of bucket) {
        if (assigned.has(last.node.id)) continue;
        try {
          // A business query is a reusable pending-journal slot, not an operation
          // identity. The applying transaction commits to its exact earlier leg.
          const before = readDlmmLiquidityState(depositArchives.get(last.node.id)!.before!.state.dataBoc!);
          const pending = before.pending.get(dlmmPendingLiquidityKey(owner, last.binId, last.queryId));
          if (!pending) continue;
          const lastT = last.flow.sourceAsset.master === pool.tokenT;
          if (!lastT && last.flow.sourceAsset.master !== pool.tokenX) continue;
          const matches = (byCommitment.get(lastT ? pending.notificationHashX : pending.notificationHashT) ?? [])
            .filter(first => first.flow.sourceAsset.master === (lastT ? pool.tokenX : pool.tokenT) &&
              BigInt(first.node.raw.lt) < BigInt(last.node.raw.lt) && !assigned.has(first.node.id));
          if (matches.length !== 1) continue;
          const group = [matches[0], last], delta = depositState(pool, group, depositProofNodes);
          // Never join debits on a guessed pair when archives or original
          // contributions are missing. Each remains an unresolved contribution.
          if (!delta || delta.delta <= 0n) continue;
          for (const item of group) assigned.add(item.node.id);
          depositOperations.push({group, delta});
        } catch { /* Unavailable current-layout evidence remains unresolved. */ }
      }
      for (const item of bucket) if (!assigned.has(item.node.id)) depositOperations.push({group: [item], delta: null});
    }
    depositOperations.sort((a, b) => BigInt(a.group[0].node.raw.lt) < BigInt(b.group[0].node.raw.lt) ? -1 : 1);
    for (const {group, delta} of depositOperations) {
      const first = group[0], last = group[group.length - 1];
      for (const item of group) {
        attach(first.flow.source, item.flow.source);
        usedFlows.add(item.flow.id);
      }
      const confirmed = Boolean(
        delta &&
          delta.delta > 0n &&
          group.every((item) => item.flow.confirmed) &&
          relatedReady(
            group.flatMap((item) => [
              item.node,
              item.flow.source,
              item.flow.recipient,
            ]),
          ),
      );
      if (delta && delta.delta > 0n)
        addPosition(
          first.flow.source,
          pool,
          first.binId,
          delta.delta.toString(),
          "in",
          {
            kind: "lp_position_delta",
            stateBeforeHash: delta.a.dataHash,
            stateAfterHash: delta.b.dataHash,
            beforeSeqno: delta.before.seqno,
            afterSeqno: delta.after.seqno,
            transactions: [ref(last.node)],
            dlmmDeposit: delta.metadata,
          },
        );
      operations.push({
        anchor: first.flow.source,
        kind: "lp_deposit",
        pool: pool.address,
        queryId: first.queryId,
        confirmed,
        evidence: delta ? delta.evidence : uniqueRefs(
          group.flatMap((item) => [
            ref(item.node),
            ref(item.flow.source),
            ref(item.flow.recipient),
          ]),
        ),
        issue: confirmed
          ? undefined
          : delta
            ? "lp_deposit_settlement_unconfirmed"
            : "lp_mint_state_unavailable",
      });
    }
    const requests = poolNodes.filter(node => address(node.raw.inMessage?.source) === owner &&
      [REMOVE, COLLECT, COLLECT_TO].includes(opcode(node.raw.inMessage) ?? node.raw.inMessage?.op ?? -1));
    if (requests.length) {
      // Hydrate exact pool and wallet boundaries. Durable stateAt caches these;
      // owner native transactions remain message-origin evidence only.
      const earliest = requests.reduce((lt, node) => BigInt(node.raw.lt) < lt ? BigInt(node.raw.lt) : lt, BigInt(requests[0].raw.lt));
      const proofNodes: MarketNode[] = await Promise.all(nodes.map(async node => {
        const value: MarketNode = {account: node.account, raw: node.raw};
        if (BigInt(node.raw.lt) >= earliest && (node.account === pool.address || wallets.has(node.account))) {
          const get = async (lt?: string, hash?: string) => {
            try { return lt && hash ? await input.stateAt(node.account, lt, hash) : null; } catch { return null; }
          };
          [value.before, value.after] = await Promise.all([get(node.raw.prevTransactionLt, node.raw.prevTransactionHash), get(node.raw.lt, node.raw.hash)]);
        }
        return value;
      }));
      let walletCodeHash = '0'.repeat(64);
      for (const node of proofNodes.filter(node => requests.some(request => request.id === nodeId(node.account, node.raw)))) {
        try {
          if (node.before?.state.codeBoc && Cell.fromBase64(node.before.state.codeBoc).hash().toString('hex') === pool.codeHash)
            walletCodeHash = readDlmmLiquidityState(node.before.state.dataBoc!).market.walletCodeHash;
          if (walletCodeHash !== '0'.repeat(64)) break;
        } catch { /* Missing historical identity remains unresolved below. */ }
      }
      const decoded = projectDlmmLiquidity({network, pool: pool.address, poolCodeHash: pool.codeHash, walletCodeHash, tokenT: pool.tokenT, tokenX: pool.tokenX}, proofNodes, owner);
      const matchesRef = (node: Node, evidence: LedgerEvidenceRef) => node.account === evidence.account && node.raw.lt === evidence.lt && canonicalLedgerHash(node.raw.hash) === canonicalLedgerHash(evidence.hash);
      for (const candidate of decoded) {
        const start = nodes.find(node => matchesRef(node, candidate.acceptance))!;
        const anchor = candidate.origin ? nodes.find(node => matchesRef(node, candidate.origin!) && node.event) :
          nodes.find(node => node.event && node.account === owner && node.raw.outMessages.some((_, index) => receiptFor(node, index)?.id === start.id));
        if (!anchor?.event) continue;
        for (const evidence of candidate.evidence) {
          const node = nodes.find(node => matchesRef(node, evidence));
          if (node?.event) attach(anchor, node);
        }
        attach(anchor, anchor);
        const metadata = candidate.metadata;
        if (metadata) {
          if (candidate.kind === 'lp_withdraw') addPosition(anchor, pool, metadata.binId, metadata.request.sharesRaw, 'out', {
            kind: 'lp_position_delta', stateBeforeHash: metadata.stateBefore.dataHash, stateAfterHash: metadata.stateAfter.dataHash,
            beforeSeqno: metadata.stateBefore.seqno, afterSeqno: metadata.stateAfter.seqno, transactions: [candidate.acceptance]});
          for (const payout of metadata.payouts) {
            if (payout.status !== 'delivered' || !payout.delivery || payout.destinationOwner !== owner) continue;
            const matching = flows.filter(flow => matchesRef(flow.recipient, payout.delivery!) &&
              matchesRef(flow.source, payout.deliveryEvidence!.debit) && flow.source.account === payout.sourceWallet &&
              flow.recipient.account === payout.destinationWallet && flow.recipientAsset.owner === owner &&
              flow.recipientAsset.master === payout.master && flow.wire.amountRaw === payout.totalRaw && flow.wire.queryId === payout.settlementId);
            const flow = matching.length === 1 ? matching[0] : null;
            const movement = flow?.recipient.event?.movements.find(value => value.id === `${flow.id}:in` && value.asset.id === payout.assetId && value.amountRaw === payout.totalRaw);
            if (!flow || !movement || usedFlows.has(flow.id)) { candidate.issues.push('dlmm_liquidity_owned_receipt_unresolved'); continue; }
            payout.movementId = movement.id;
            movement.evidence.dlmmReceipt = {pool: pool.address, owner, recipient: metadata.recipient, binId: metadata.binId,
              settlementId: payout.settlementId!, principalRaw: payout.principalRaw, earnedFeeRaw: payout.earnedFeeRaw, delivery: payout.delivery};
            attach(anchor, flow.recipient); usedFlows.add(flow.id);
            if (!flow.confirmed) candidate.issues.push('related_account_history_incomplete');
          }
        }
        if (!candidate.evidence.every(value => chains.get(value.account)?.historyComplete)) candidate.issues.push('related_account_history_incomplete');
        for (const issue of candidate.issues) mark(anchor, issue);
        const confirmed = Boolean(metadata && !candidate.issues.length);
        operations.push({anchor, kind: candidate.kind, pool: pool.address, queryId: candidate.queryId ?? undefined, confirmed, evidence: candidate.evidence,
          settlement: {status: confirmed ? 'confirmed' : 'incomplete', protocol: 'dlmm', operation: candidate.kind, pool: pool.address,
            ...(candidate.queryId ? {queryId: candidate.queryId} : {}), evidence: candidate.evidence, ...(metadata ? {dlmmLiquidity: metadata} : {})},
          issue: confirmed ? undefined : 'dlmm_liquidity_evidence_incomplete'});
      }
    }
  }
  const optionResults = await decodeOptionPurchases(
    input,
    nodes,
    flows,
    receiptFor,
    attach,
  );
  operations.push(...optionResults.operations);
  for (const id of optionResults.usedFlows) usedFlows.add(id);
  const optionLifecycle = await decodeOptionExercises(
    input,
    nodes,
    flows,
    receiptFor,
    attach,
  );
  operations.push(...optionLifecycle.operations);
  for (const id of optionLifecycle.usedFlows) usedFlows.add(id);
  const optionRefunds = await decodeOptionRefunds(
    input,
    nodes,
    flows,
    receiptFor,
    attach,
  );
  operations.push(...optionRefunds.operations);
  for (const id of optionRefunds.usedFlows) usedFlows.add(id);
  const optionAborts = await decodeOptionAborts(
    input,
    nodes,
    flows,
    receiptFor,
    merge,
  );
  for (let i = operations.length - 1; i >= 0; i--)
    if (
      operations[i].kind === "option_buy" &&
      !operations[i].confirmed &&
      optionAborts.supersededPurchaseAnchors.includes(operations[i].anchor.id)
    )
      operations.splice(i, 1);
  operations.push(...optionAborts.operations);
  for (const id of optionAborts.usedFlows) usedFlows.add(id);
  const t3Results = await decodeT3(input, nodes, flows, receiptFor, attach);
  operations.push(...t3Results.operations);
  for (const id of t3Results.usedFlows) usedFlows.add(id);
  const perpsResults = await decodePerps(
    input,
    nodes,
    flows,
    receiptFor,
    attach,
  );
  operations.push(...perpsResults.operations);
  for (const id of perpsResults.usedFlows) usedFlows.add(id);
  const participationResults = await decodeLaunchpadContributions(input, nodes, flows, receiptFor, attach);
  operations.push(...participationResults.operations);
  for (const id of participationResults.usedFlows) usedFlows.add(id);
  const launchpadResults = await decodeLaunchpadRefunds(input, nodes, flows, receiptFor, attach);
  operations.push(...launchpadResults.operations);
  for (const id of launchpadResults.usedFlows) usedFlows.add(id);
  // Retain unmatched exact receipt evidence, including unknown asset amounts.
  // Discard a notification only when its exact emitting wallet transaction is
  // represented by a verified credit or root mint, never merely by the same query ID.
  for (const n of nodes)
    if (n.event) {
      const replacements =
        creditedNodes.has(n.id) ||
        n.event.movements.some(
          (m) =>
            m.id.endsWith(":mint-credit") ||
            m.evidence.kind === "t3_mint",
        );
      const emittedByCoveredWallet = nodes.some(
        (sender) =>
          sender.event &&
          wallets.get(sender.account)?.owner === owner &&
          touched.has(sender.id) &&
          sender.raw.outMessages.some(
            (_, index) => receiptFor(sender, index)?.id === n.id,
          ),
      );
      if (!replacements && !emittedByCoveredWallet)
        n.event.movements.push(
          ...(pendingTokenEvidence.get(n.id) ?? []).map((m) => ({
            ...m,
            evidence: { ...m.evidence, transactions: [ref(n)] as [LedgerEvidenceRef] },
          })),
        );
    }
  const grouped = new Map<string, Node[]>();
  for (const n of nodes)
    if (n.event) {
      const root = find(n.id);
      grouped.set(root, [...(grouped.get(root) ?? []), n]);
    }
  const result: LedgerEvent[] = [];
  for (const [root, members] of grouped) {
    members.sort((a, b) =>
      BigInt(a.raw.lt) < BigInt(b.raw.lt)
        ? -1
        : BigInt(a.raw.lt) > BigInt(b.raw.lt)
          ? 1
          : a.id.localeCompare(b.id),
    );
    const first = members[0],
      event = first.event!;
    const groupOps = operations.filter((op) => find(op.anchor.id) === root);
    const hasToken = members.some((n) => touched.has(n.id));
    const knownMessages = members.every((n) =>
      [n.raw.inMessage, ...n.raw.outMessages].every(
        (msg) =>
          !msg?.source ||
          !msg.destination ||
          msg.value === undefined ||
          [null, 0].includes(opcode(msg)) ||
          TOKEN_CONTROL_OPS.has(businessOpcode(msg)!) ||
          nativeFundingRefund(msg) !== null ||
          (groupOps.some((op) => op.kind === "launchpad_refund") && opcode(msg) === 0x434c414d) ||
          (groupOps.some((op) => op.kind === "perps_operation") &&
            PERPS_USER_OPS.has(opcode(msg)!)) ||
          (groupOps.some(
            (op) => op.kind === "t3_mint" || op.kind === "t3_redeem",
          ) &&
            T3_OPS.has(opcode(msg)!)) ||
          (groupOps.length > 0 &&
            [REMOVE, COLLECT, COLLECT_TO, WITHDRAW_COMPLETE].includes(opcode(msg)!)) ||
          (groupOps.some((op) =>
            ["option_buy", "option_exercise", "option_refund"].includes(
              op.kind,
            ),
          ) &&
            [
              OPTION_EXERCISE,
              OPTION_OWNER_ABORT,
              OPTION_CLAIM_RECEIPT,
              OPTION_CLAIM_RETRY,
              OPTION_NATIVE_REFUND,
            ].includes(opcode(msg)!)),
      ),
    );
    const issues = new Set(
      members
        .flatMap((n) => n.event!.issues)
        .filter(
          (issue) =>
            !(
              (hasToken ||
                groupOps.some(
                  (op) => op.kind === "option_exercise" && op.confirmed,
                )) &&
              knownMessages &&
              basicIssues.has(issue)
            ),
        ),
    );
    const movements = [
      ...new Map(
        members.flatMap((n) => n.event!.movements).map((m) => [m.id, m]),
      ).values(),
    ];
    const fees = members.map((n) => n.event!.totalFeesRaw);
    const totalFeesRaw = fees.every((fee) => fee !== null)
      ? fees.reduce((sum, fee) => sum + BigInt(fee!), 0n).toString()
      : null;
    const groupFlows = flows.filter(
      (flow) =>
        (flow.source.event && find(flow.source.id) === root) ||
        (flow.recipient.event && find(flow.recipient.id) === root),
    );
    for (const flow of groupFlows)
      if (!usedFlows.has(flow.id) && protocolForward(flow.wire.forward))
        issues.add("protocol_identity_or_settlement_unresolved");
    const unresolvedPerps = groupFlows.some(
      (flow) =>
        !usedFlows.has(flow.id) && unresolvedPerpsForward(flow.wire.forward),
    );
    if (unresolvedPerps) issues.add("perps_position_settlement_unverified");
    const unresolvedT3 = groupFlows.some(
      (flow) =>
        !usedFlows.has(flow.id) &&
        flow.wire.forward.bits.length >= 32 &&
        [DEPOSIT_NOTE, RECEIVER_PAYOUT].includes(
          flow.wire.forward.beginParse().preloadUint(32),
        ),
    );
    if (unresolvedT3) issues.add("t3_identity_or_settlement_unverified");
    const optionControllers = new Set([
      ...(input.optionControllers ?? []),
      ...[...(input.optionFactories?.values() ?? [])].flatMap((f) =>
        [f.address, f.vault].filter((s): s is string => Boolean(s)),
      ),
    ]);
    const unresolvedOptions = groupFlows.some(
      (flow) =>
        !usedFlows.has(flow.id) &&
        ((flow.wire.forward.bits.length >= 32 &&
          flow.wire.forward.beginParse().preloadUint(32) === 0x46425559) ||
          optionControllers.has(flow.sourceAsset.owner!)),
    );
    if (unresolvedOptions)
      issues.add("option_identity_or_cash_settlement_unverified");
    const launchpadControllers = new Set([
      ...(input.launchpadControllers ?? []),
      ...(input.launchpadSales?.keys() ?? []),
    ]);
    const launchpadRequests = members.flatMap(node => readLaunchpadRequests(input, node));
    const unresolvedLaunchpadClaim = !groupOps.some(op => op.kind === "launchpad_refund") && launchpadRequests.some(request => request.kind === "claim");
    if (unresolvedLaunchpadClaim) issues.add("launchpad_claim_settlement_unverified");
    const unresolvedLaunchpadParticipation = !groupOps.some(op => op.kind === "launchpad_participation") && launchpadRequests.some(request => request.kind !== "claim");
    if (unresolvedLaunchpadParticipation) issues.add("launchpad_participation_settlement_unverified");
    const unresolvedLaunchpad = groupFlows.some((flow) =>
      !usedFlows.has(flow.id) && (
        unresolvedLaunchpadForward(flow.wire.forward) ||
        launchpadControllers.has(flow.sourceAsset.owner!) ||
        launchpadControllers.has(flow.recipientAsset.owner!)
      ),
    ) || unresolvedLaunchpadClaim || unresolvedLaunchpadParticipation;
    if (unresolvedLaunchpad) issues.add("launchpad_identity_or_cash_settlement_unverified");
    const merged: LedgerEvent = {
      ...event,
      ...(launchpadRequests.length ? { launchpadRequests } : {}),
      account: owner,
      totalFeesRaw,
      movements,
      actions: members.flatMap((n) => n.event!.actions),
      issues: [],
    };
    if (groupOps.length === 1) {
      const op = groupOps[0];
      merged.kind = op.kind;
      merged.settlement =
        "settlement" in op && op.settlement
          ? op.settlement
          : "pool" in op && "queryId" in op ? {
              status: op.confirmed ? "confirmed" : "incomplete",
              protocol: "dlmm",
              operation: op.kind,
              pool: op.pool,
              queryId: op.queryId,
              evidence: op.evidence,
            } : undefined;
      if (op.issue) issues.add(op.issue);
    } else if (groupOps.length > 1)
      issues.add("multiple_protocol_operations_grouped");
    else if (hasToken && knownMessages && groupFlows.length > 0) {
      merged.kind = "transfer";
      merged.settlement = {
        status: groupFlows.every((flow) => flow.confirmed)
          ? "confirmed"
          : "incomplete",
        protocol: "jetton",
        operation: "transfer",
        evidence: uniqueRefs(
          groupFlows.flatMap((flow) => [ref(flow.source), ref(flow.recipient)]),
        ),
      };
    }
    // A protocol request remains explicit until the matching verified operation exists.
    if (
      !groupOps.length &&
      members.some(
        (n) =>
          n.event!.kind === "swap" ||
          n.event!.kind === "lp_deposit" ||
          n.event!.kind === "lp_withdraw" ||
          [n.raw.inMessage, ...n.raw.outMessages].some(msg => [COLLECT, COLLECT_TO].includes(opcode(msg)!)),
      )
    )
      issues.add("settlement_not_decoded");
    if (
      (unresolvedPerps || unresolvedT3 || unresolvedOptions || unresolvedLaunchpad) &&
      merged.settlement &&
      !groupOps.some((op) => op.kind === "option_exercise" && op.confirmed)
    )
      merged.settlement.status = "incomplete";
    merged.issues = [...issues].sort();
    result.push(merged);
  }
  return { events: result, projectionScope };
}
