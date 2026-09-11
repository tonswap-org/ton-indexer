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
  decodeSccp,
  type LedgerSccpMaster,
  type SccpLedgerOperation,
} from "./sccp";
import { SCCP_BURN, SCCP_BURN_NOTIFY, SCCP_BURNED } from "./sccpWire";
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
import { resolveDlmmPoolSettlementEvidence } from "../utils/dlmmSettlementEvidence";
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
import { readDlmmPositionState, readDlmmWithdrawalState } from "./archive";
import { matchPhysicalJettonFlow } from "./jettonFlow";
import {
  INTERNAL,
  NOTIFY,
  REMOVE,
  TOKEN_CONTROL_OPS,
  TRANSFER,
  WITHDRAW_COMPLETE,
  bodyCell,
  messageKey,
  opcode,
  protocolForward,
  unresolvedPerpsForward,
  unresolvedLaunchpadForward,
  tokenWire,
  withdrawalReceipt,
  withdrawalRequest,
  type TokenWire,
} from "./wire";

export type LedgerChain = LedgerRelatedAccount & {
  transactions: RawTransaction[];
  checkedAt?: string | null;
};
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
  sccpMasters?: Map<string, LedgerSccpMaster>;
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
        for (const m of node.event.movements)
          m.evidence.transactions = [ref(node)];
        // Outbound forwarding fees are separate from transaction.totalFees in TON.
        raw.outMessages.forEach((msg, index) => {
          if (msg.value === undefined) return;
          for (const [field, amount] of [
            ["forward", msg.forwardFeeRaw],
            ["ihr", msg.ihrFeeRaw],
          ] as const) {
            if (amount === undefined) {
              mark(node, `outgoing_${field}_fee_unavailable`);
              continue;
            }
            if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
              mark(node, `outgoing_${field}_fee_invalid`);
              continue;
            }
            if (amount !== "0")
              node.event!.movements.push({
                id: `${node.event!.id}:${field}:${index}`,
                direction: "fee",
                asset: {
                  kind: "native",
                  id: `${network}:native`,
                  symbol: "TON",
                  decimals: 9,
                },
                amountRaw: amount,
                source: chain.account,
                evidence: {
                  kind: "message_forward_fee",
                  messageIndex: index,
                  transactions: [ref(node)],
                },
              });
          }
        });
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
        chains.get(source.account)?.historyComplete &&
          chains.get(recipient.account)?.historyComplete,
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
  // its economic purpose remains unresolved for rewards, derivatives and bridge mints.
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
    kind: "swap" | "lp_deposit" | "lp_withdraw";
    pool: string;
    queryId: string;
    confirmed: boolean;
    evidence: LedgerEvidenceRef[];
    issue?: string;
  };
  const operations: (
    | Operation
    | OptionLedgerOperation
    | OptionLifecycleOperation
    | SccpLedgerOperation
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
  const positionDelta = async (pool: LedgerPool, node: Node, binId: number) => {
    const previousLt = node.raw.prevTransactionLt,
      previousHash = node.raw.prevTransactionHash;
    if (!previousLt || !previousHash || previousLt === "0") return null;
    const [before, after] = await Promise.all([
      input.stateAt(pool.address, previousLt, previousHash),
      input.stateAt(pool.address, node.raw.lt, node.raw.hash),
    ]);
    try {
      if (
        !before?.state.dataBoc ||
        !after?.state.dataBoc ||
        !before.state.codeBoc ||
        !after.state.codeBoc
      )
        return null;
      if (
        Cell.fromBase64(before.state.codeBoc).hash().toString("hex") !==
          pool.codeHash ||
        Cell.fromBase64(after.state.codeBoc).hash().toString("hex") !==
          pool.codeHash
      )
        return null;
      const a = readDlmmPositionState(before.state.dataBoc, owner, binId),
        b = readDlmmPositionState(after.state.dataBoc, owner, binId);
      if (
        a.tokenT !== pool.tokenT ||
        a.tokenX !== pool.tokenX ||
        b.tokenT !== pool.tokenT ||
        b.tokenX !== pool.tokenX
      )
        return null;
      return { delta: b.shares - a.shares, before, after, a, b };
    } catch {
      return null;
    }
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
    const settlements = resolveDlmmPoolSettlementEvidence(
      pool.address,
      poolNodes.map((n) =>
        classifyTransaction(
          n.account,
          { ...n.raw, hash: canonicalLedgerHash(n.raw.hash) },
          opcodes,
        ),
      ),
    );
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
      const outputAmount = settlements.get(
        `${node.raw.lt}:${canonicalLedgerHash(node.raw.hash)}`,
      )?.amountOutRaw;
      const candidates = flows.filter(
        (flow) =>
          flow.sourceAsset.owner === pool.address &&
          flow.recipientAsset.owner === owner &&
          flow.wire.amountRaw === outputAmount &&
          node.raw.outMessages.some(
            (_, index) => receiptFor(node, index)?.id === flow.source.id,
          ),
      );
      const output = candidates.length === 1 ? candidates[0] : null;
      const pair = new Set([
        inputFlow.sourceAsset.master,
        output?.recipientAsset.master,
      ]);
      const confirmed = Boolean(
        outputAmount &&
          output &&
          output.confirmed &&
          inputFlow.confirmed &&
          pair.has(pool.tokenT) &&
          pair.has(pool.tokenX) &&
          relatedReady([
            node,
            inputFlow.source,
            inputFlow.recipient,
            output.source,
            output.recipient,
          ]),
      );
      if (output) attach(inputFlow.source, output.recipient);
      usedFlows.add(inputFlow.id);
      if (output) usedFlows.add(output.id);
      operations.push({
        anchor: inputFlow.source,
        kind: "swap",
        pool: pool.address,
        queryId: forward.queryId,
        confirmed,
        evidence: uniqueRefs([
          ref(node),
          ref(inputFlow.source),
          ref(inputFlow.recipient),
          ...(output ? [ref(output.source), ref(output.recipient)] : []),
        ]),
        issue: confirmed ? undefined : "swap_settlement_unconfirmed",
      });
    }
    for (const group of deposits.values()) {
      group.sort((a, b) =>
        BigInt(a.node.raw.lt) < BigInt(b.node.raw.lt) ? -1 : 1,
      );
      const first = group[0],
        last = group[group.length - 1];
      for (const item of group) {
        attach(first.flow.source, item.flow.source);
        usedFlows.add(item.flow.id);
      }
      const roots = new Set(group.map((item) => item.flow.sourceAsset.master));
      const delta =
        group.length === 2 && roots.has(pool.tokenT) && roots.has(pool.tokenX)
          ? await positionDelta(pool, last.node, first.binId)
          : null;
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
          },
        );
      operations.push({
        anchor: first.flow.source,
        kind: "lp_deposit",
        pool: pool.address,
        queryId: first.queryId,
        confirmed,
        evidence: uniqueRefs(
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
    const withdrawals = new Map<string, Node[]>();
    for (const node of poolNodes) {
      const request = withdrawalRequest(node.raw.inMessage);
      if (
        request &&
        success(node.raw) &&
        address(node.raw.inMessage?.source) === owner &&
        request.recipient === owner
      )
        withdrawals.set(request.queryId, [
          ...(withdrawals.get(request.queryId) ?? []),
          node,
        ]);
    }
    for (const attempts of withdrawals.values()) {
      attempts.sort((a, b) => (BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1));
      const start = attempts[0],
        request = withdrawalRequest(start.raw.inMessage)!;
      const anchors = nodes.filter(
        (n) =>
          n.event &&
          n.account === owner &&
          n.raw.outMessages.some((_, index) =>
            attempts.some((attempt) => receiptFor(n, index)?.id === attempt.id),
          ),
      );
      if (!anchors.length) continue;
      const anchor = anchors[0];
      for (const n of anchors) attach(anchor, n);
      const receipts = poolNodes
        .flatMap((n) =>
          n.raw.outMessages.map((msg, index) => ({
            node: n,
            index,
            receipt: withdrawalReceipt(msg),
          })),
        )
        .filter(
          (item) =>
            success(item.node.raw) &&
            item.receipt?.queryId === request.queryId &&
            item.receipt.owner === owner &&
            item.receipt.recipient === owner &&
            item.receipt.binId === request.binId &&
            item.receipt.shares === request.shares,
        );
      const receipt = receipts[0];
      const delivered = receipt
        ? receiptFor(receipt.node, receipt.index)
        : null;
      if (delivered?.event) attach(anchor, delivered);
      const uniqueReceipt =
        receipt &&
        receipts.every(
          (item) =>
            JSON.stringify(item.receipt) === JSON.stringify(receipt.receipt),
        );
      let terminal: ReturnType<typeof readDlmmWithdrawalState> = null;
      if (receipt) {
        try {
          const snapshot = await input.stateAt(
            pool.address,
            receipt.node.raw.lt,
            receipt.node.raw.hash,
          );
          if (
            snapshot?.state.dataBoc &&
            snapshot.state.codeBoc &&
            Cell.fromBase64(snapshot.state.codeBoc).hash().toString("hex") ===
              pool.codeHash
          )
            terminal = readDlmmWithdrawalState(
              snapshot.state.dataBoc,
              request.queryId,
            );
        } catch {
          /* An unavailable exact terminal state never becomes amount-only correlation. */
        }
      }
      const exactRecord =
        terminal &&
        terminal.owner === owner &&
        terminal.recipient === owner &&
        terminal.binId === request.binId &&
        terminal.shares === request.shares &&
        terminal.legT === 1 &&
        terminal.legX === 1 &&
        terminal.totalT === receipt?.receipt?.amountT &&
        terminal.totalX === receipt?.receipt?.amountX;
      const candidates = receipt
        ? flows.filter(
            (flow) =>
              flow.sourceAsset.owner === pool.address &&
              flow.recipientAsset.owner === owner &&
              BigInt(flow.source.raw.lt) > BigInt(start.raw.lt) &&
              BigInt(flow.recipient.raw.lt) <= BigInt(receipt.node.raw.lt) &&
              !usedFlows.has(flow.id),
          )
        : [];
      const leg = (
        root: string,
        value?: string,
        queryId?: string,
        sourceWallet?: string | null,
        recipientWallet?: string | null,
      ) =>
        value === "0"
          ? []
          : candidates.filter(
              (flow) =>
                flow.recipientAsset.master === root &&
                flow.wire.amountRaw === value &&
                flow.wire.queryId === queryId &&
                flow.source.account === sourceWallet &&
                flow.recipient.account === recipientWallet,
            );
      const t = leg(
          pool.tokenT,
          terminal?.totalT,
          terminal?.settlementTId,
          terminal?.poolWalletT,
          terminal?.recipientWalletT,
        ),
        x = leg(
          pool.tokenX,
          terminal?.totalX,
          terminal?.settlementXId,
          terminal?.poolWalletX,
          terminal?.recipientWalletX,
        );
      const exact = Boolean(
        exactRecord &&
          uniqueReceipt &&
          receipt &&
          ((receipt.receipt!.amountT === "0" && t.length === 0) ||
            t.length === 1) &&
          ((receipt.receipt!.amountX === "0" && x.length === 0) ||
            x.length === 1),
      );
      const outputs = exact ? [...t, ...x] : [];
      for (const flow of outputs) {
        attach(anchor, flow.recipient);
        usedFlows.add(flow.id);
      }
      const delta = await positionDelta(pool, start, request.binId);
      const confirmed = Boolean(
        exact &&
          delivered &&
          success(delivered.raw) &&
          delta?.delta === -BigInt(request.shares) &&
          outputs.every((flow) => flow.confirmed) &&
          relatedReady([
            start,
            ...outputs.flatMap((flow) => [flow.source, flow.recipient]),
            ...(receipt ? [receipt.node] : []),
          ]),
      );
      if (delta?.delta === -BigInt(request.shares))
        addPosition(anchor, pool, request.binId, request.shares, "out", {
          kind: "lp_position_delta",
          stateBeforeHash: delta.a.dataHash,
          stateAfterHash: delta.b.dataHash,
          beforeSeqno: delta.before.seqno,
          afterSeqno: delta.after.seqno,
          transactions: [ref(start)],
        });
      operations.push({
        anchor,
        kind: "lp_withdraw",
        pool: pool.address,
        queryId: request.queryId,
        confirmed,
        evidence: uniqueRefs([
          ref(start),
          ...(receipt ? [ref(receipt.node)] : []),
          ...outputs.flatMap((flow) => [ref(flow.source), ref(flow.recipient)]),
        ]),
        issue: confirmed
          ? undefined
          : !delta
            ? "lp_burn_state_unavailable"
            : !terminal
              ? "lp_terminal_state_unavailable"
              : "lp_withdrawal_settlement_unconfirmed",
      });
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
  operations.push(...decodeSccp(input, nodes, receiptFor, attach));
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
            m.evidence.kind === "sccp_mint" ||
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
            evidence: { ...m.evidence, transactions: [ref(n)] },
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
          TOKEN_CONTROL_OPS.has(opcode(msg)!) ||
          (groupOps.some((op) => op.kind === "launchpad_refund") && opcode(msg) === 0x434c414d) ||
          (groupOps.some((op) => op.kind === "perps_operation") &&
            PERPS_USER_OPS.has(opcode(msg)!)) ||
          (groupOps.some(
            (op) => op.kind === "t3_mint" || op.kind === "t3_redeem",
          ) &&
            T3_OPS.has(opcode(msg)!)) ||
          (groupOps.length > 0 &&
            [REMOVE, WITHDRAW_COMPLETE].includes(opcode(msg)!)) ||
          (groupOps.some(
            (op) => op.kind === "bridge_burn" || op.kind === "bridge_mint",
          ) &&
            [SCCP_BURN, SCCP_BURN_NOTIFY, SCCP_BURNED].includes(
              opcode(msg)!,
            )) ||
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
        "settlement" in op
          ? op.settlement
          : {
              status: op.confirmed ? "confirmed" : "incomplete",
              protocol: "dlmm",
              operation: op.kind,
              pool: op.pool,
              queryId: op.queryId,
              evidence: op.evidence,
            };
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
          n.event!.kind === "lp_withdraw",
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
