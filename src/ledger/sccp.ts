import type { LedgerSccpBinding } from '../config/ledgerBridge';
import type { Node, ProjectionInput } from './project';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, INTERNAL, tokenWire, uint } from './wire';
import {
  parseSccpBurnedNotification,
  type parseSccpBurnRecord,
} from '../utils/sccpEvidence';
import {
  hex256,
  sccpBurnNotification,
  sccpBurnRequest,
  sccpMessageId,
  sccpMintRequest,
} from './sccpWire';
export type LedgerSccpMaster = LedgerSccpBinding & {
  nonce: string;
  verifierTrusted: boolean;
  burns: Map<
    string,
    {
      record: ReturnType<typeof parseSccpBurnRecord>;
      boc: string;
      observedAt: string;
    }
  >;
};
export type SccpLedgerOperation = {
  anchor: Node;
  kind: 'bridge_burn' | 'bridge_mint';
  queryId: string;
  confirmed: boolean;
  evidence: LedgerEvidenceRef[];
  issue?: string;
  settlement: NonNullable<LedgerEvent['settlement']>;
};
const addr = (value?: string) => {
  try {
    return value ? canonicalLedgerAddress(value) : null;
  } catch {
    return null;
  }
};
const ref = (node: Node): LedgerEvidenceRef => ({
  account: node.account,
  lt: node.raw.lt,
  hash: canonicalLedgerHash(node.raw.hash),
  utime: node.raw.utime,
});
const ok = (node: Node) =>
  node.raw.success &&
  (!node.raw.status || node.raw.status === 'success') &&
  !node.raw.inMessage?.bounced;
/** Local chain completion only. No remote receipt, fee, owner or asset amount is
 * fabricated from a bridge message ID or a TON supply change. */
export function decodeSccp(
  input: ProjectionInput,
  nodes: Node[],
  receiptFor: (node: Node, index: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: SccpLedgerOperation[] = [],
    seen = new Map<string, SccpLedgerOperation>();
  const relatedReady = (evidence: Node[]) =>
    evidence.every((n) => input.chains.get(n.account)?.historyComplete);
  const fees = (evidence: Node[]) =>
    [...new Map(evidence.map((n) => [n.id, n])).values()].map((n) => ({
      transaction: ref(n),
      amountRaw: uint(n.raw.totalFeesRaw) ? n.raw.totalFeesRaw : null,
      includedInOwnerFeeMovements: Boolean(n.event),
    }));
  const attachReturns = (anchor: Node, source: Node) => {
    const found: Node[] = [];
    for (const [index] of source.raw.outMessages.entries()) {
      const recipient = receiptFor(source, index);
      if (recipient?.event && ok(recipient)) {
        attach(anchor, recipient);
        found.push(recipient);
      }
    }
    return found;
  };
  const add = (op: SccpLedgerOperation) => {
    const messageId = op.settlement.bridge?.messageId;
    const key =
      op.confirmed && messageId
        ? `${op.kind}:${op.settlement.bridge!.tonMaster}:${messageId}`
        : null;
    const previous = key ? seen.get(key) : undefined;
    if (previous) {
      attach(previous.anchor, op.anchor);
      previous.evidence.push(...op.evidence);
      previous.settlement.evidence = [
        ...new Map(
          previous.evidence.map((r) => [`${r.account}:${r.lt}:${r.hash}`, r]),
        ).values(),
      ];
      previous.settlement.bridge!.localNetworkFees = [
        ...new Map(
          [
            ...previous.settlement.bridge!.localNetworkFees,
            ...op.settlement.bridge!.localNetworkFees,
          ].map((f) => [
            `${f.transaction.account}:${f.transaction.lt}:${f.transaction.hash}`,
            f,
          ]),
        ).values(),
      ];
      return;
    }
    operations.push(op);
    if (key) seen.set(key, op);
  };
  for (const node of nodes) {
    const asset = input.wallets.get(node.account);
    if (!node.event || asset?.owner !== input.owner || !asset.master) continue;
    const master = input.sccpMasters?.get(asset.master),
      request = sccpBurnRequest(node.raw.inMessage);
    if (
      request &&
      addr(node.raw.inMessage?.source) === input.owner &&
      ok(node)
    ) {
      const parent = nodes.filter(
        (n) =>
          n.account === input.owner &&
          ok(n) &&
          n.raw.outMessages.some((_, i) => receiptFor(n, i)?.id === node.id),
      );
      const evidenceNodes = [...parent, node];
      for (const p of parent) attach(node, p);
      const bridge: NonNullable<
        NonNullable<LedgerEvent['settlement']>['bridge']
      > = {
        messageId: null,
        nonce: null,
        amountRaw: request.amountRaw,
        sourceDomain: 4,
        destinationDomain: request.destinationDomain,
        recipient32: request.recipient32,
        soraAssetId: master?.soraAssetId ?? null,
        tonMaster: asset.master,
        tonWallet: node.account,
        tonOwner: input.owner,
        masterCodeHash: master?.masterCodeHash ?? null,
        localStage: 'unresolved',
        counterpartyStatus: 'unverified',
        localNetworkFees: [],
      };
      let issue = 'sccp_master_identity_unresolved',
        confirmed = false,
        recordEvidence: LedgerMovement['evidence'] | undefined;
      if (master) {
        const candidates = node.raw.outMessages
          .map((message, index) => ({
            message,
            index,
            value: sccpBurnNotification(message),
          }))
          .filter(
            ({ message, value }) =>
              value &&
              addr(message.source) === node.account &&
              addr(message.destination) === master.master &&
              value.owner === input.owner &&
              value.queryId === request.queryId &&
              value.amountRaw === request.amountRaw &&
              value.destinationDomain === request.destinationDomain &&
              value.recipient32 === request.recipient32 &&
              value.response === request.response,
          );
        const delivered =
          candidates.length === 1
            ? receiptFor(node, candidates[0].index)
            : null;
        issue = 'sccp_burn_delivery_unverified';
        if (delivered && delivered.account === master.master && ok(delivered)) {
          evidenceNodes.push(delivered, ...attachReturns(node, delivered));
          const receipts = delivered.raw.outMessages.flatMap((message) => {
            try {
              const value = parseSccpBurnedNotification(
                message.body,
                message.op,
              );
              return value &&
                addr(message.source) === master.master &&
                addr(message.destination) === input.owner &&
                value.queryId.toString() === request.queryId
                ? [value]
                : [];
            } catch {
              return [];
            }
          });
          issue = 'sccp_burn_record_unverified';
          if (receipts.length === 1) {
            const receipt = receipts[0],
              messageId = hex256(receipt.messageId),
              nonce = receipt.nonce.toString(),
              stored = master.burns.get(messageId);
            bridge.messageId = messageId;
            bridge.nonce = nonce;
            const expected = sccpMessageId(
                4,
                request.destinationDomain,
                nonce,
                master.soraAssetId,
                request.amountRaw,
                request.recipient32,
              ),
              record = stored?.record;
            if (
              record &&
              record.burnInitiator === input.owner &&
              record.destDomain === BigInt(request.destinationDomain) &&
              hex256(record.recipient32) === request.recipient32 &&
              record.amount.toString() === request.amountRaw &&
              record.nonce === receipt.nonce &&
              receipt.nonce > 0n &&
              receipt.nonce <= BigInt(master.nonce) &&
              expected === messageId
            ) {
              confirmed = parent.length === 1 && relatedReady(evidenceNodes);
              issue = confirmed
                ? 'bridge_counterparty_unverified'
                : 'related_account_history_incomplete';
              recordEvidence = {
                kind: 'sccp_burn_record',
                bodyHash: bodyCell(delivered.raw.inMessage)!
                  .hash()
                  .toString('hex'),
                transactions: evidenceNodes.map(ref),
                getter: {
                  account: master.master,
                  method: 'get_sccp_burn_record',
                  args: [receipt.messageId.toString()],
                  result: [stored!.boc],
                  observedAt: stored!.observedAt,
                },
              };
            }
          }
        }
      }
      bridge.localStage = confirmed ? 'burned' : 'unresolved';
      bridge.localNetworkFees = fees(evidenceNodes);
      if (confirmed)
        node.event.movements.push({
          id: `sccp:${input.network}:${asset.master}:${bridge.messageId}:burn`,
          direction: 'out',
          amountRaw: request.amountRaw,
          asset,
          source: input.owner,
          destination: asset.master,
          evidence: recordEvidence!,
        });
      const evidence = evidenceNodes.map(ref);
      add({
        anchor: node,
        kind: 'bridge_burn',
        queryId: request.queryId,
        confirmed,
        issue,
        evidence,
        settlement: {
          status: confirmed ? 'confirmed' : 'incomplete',
          protocol: 'sccp',
          operation: 'bridge_burn',
          queryId: request.queryId,
          bridge,
          evidence,
        },
      });
    }
    const wire = tokenWire(node.raw.inMessage);
    if (
      wire?.op !== INTERNAL ||
      wire.owner !== null ||
      addr(node.raw.inMessage?.source) !== asset.master ||
      !ok(node) ||
      wire.forward.bits.length !== 256 ||
      wire.forward.refs.length
    )
      continue;
    const messageId = hex256(wire.forward.beginParse().loadUintBig(256));
    const sourceNodes = nodes.filter(
      (n) =>
        n.account === asset.master &&
        ok(n) &&
        n.raw.outMessages.some((_, i) => receiptFor(n, i)?.id === node.id),
    );
    const mint =
      sourceNodes.length === 1
        ? sccpMintRequest(sourceNodes[0].raw.inMessage)
        : null;
    if (!mint) continue;
    const rootNode = sourceNodes[0],
      evidenceNodes = [rootNode, node];
    let confirmed = false,
      issue = 'sccp_master_identity_unresolved';
    const bridge: NonNullable<
      NonNullable<LedgerEvent['settlement']>['bridge']
    > = {
      messageId,
      nonce: mint.nonce,
      amountRaw: wire.amountRaw,
      sourceDomain: mint.sourceDomain,
      destinationDomain: 4,
      recipient32: mint.recipient32,
      soraAssetId: master?.soraAssetId ?? null,
      tonMaster: asset.master,
      tonWallet: node.account,
      tonOwner: input.owner,
      masterCodeHash: master?.masterCodeHash ?? null,
      localStage: 'unresolved',
      counterpartyStatus: 'unverified',
      localNetworkFees: [],
    };
    if (master) {
      const verifierNodes = nodes.filter(
        (n) =>
          n.account === master.verifier &&
          ok(n) &&
          n.raw.outMessages.some(
            (_, i) => receiptFor(n, i)?.id === rootNode.id,
          ),
      );
      if (verifierNodes.length === 1) {
        evidenceNodes.unshift(verifierNodes[0]);
        for (const parent of nodes.filter(
          (n) =>
            n.event &&
            ok(n) &&
            n.raw.outMessages.some(
              (_, i) => receiptFor(n, i)?.id === verifierNodes[0].id,
            ),
        )) {
          attach(node, parent);
          evidenceNodes.unshift(parent);
        }
      }
      issue = 'sccp_mint_authorization_unverified';
      if (
        master.verifierTrusted &&
        master.verifier &&
        addr(rootNode.raw.inMessage?.source) === master.verifier &&
        verifierNodes.length === 1 &&
        mint.queryId === wire.queryId &&
        mint.amountRaw === wire.amountRaw &&
        mint.response === wire.response &&
        `0:${mint.recipient32.slice(2)}` === input.owner &&
        sccpMessageId(
          mint.sourceDomain,
          4,
          mint.nonce,
          master.soraAssetId,
          mint.amountRaw,
          mint.recipient32,
        ) === messageId
      ) {
        confirmed = relatedReady(evidenceNodes);
        issue = confirmed
          ? 'bridge_counterparty_unverified'
          : 'related_account_history_incomplete';
        bridge.verifier = master.verifier;
        bridge.verifierCodeHash = master.verifierCodeHash;
      }
    }
    evidenceNodes.push(...attachReturns(node, node));
    bridge.localStage = confirmed ? 'minted' : 'unresolved';
    bridge.localNetworkFees = fees(evidenceNodes);
    if (confirmed) {
      const credit = node.event.movements.find((m) =>
        m.id.endsWith(':mint-credit'),
      );
      if (credit) {
        credit.id = `sccp:${input.network}:${asset.master}:${messageId}:mint`;
        credit.evidence = {
          kind: 'sccp_mint',
          bodyHash: bodyCell(node.raw.inMessage)!.hash().toString('hex'),
          transactions: evidenceNodes.map(ref),
        };
        node.event.issues = node.event.issues.filter(
          (i) => i !== 'mint_purpose_unresolved',
        );
      } else {
        confirmed = false;
        bridge.localStage = 'unresolved';
        issue = 'sccp_mint_credit_unverified';
      }
    }
    const evidence = evidenceNodes.map(ref);
    add({
      anchor: node,
      kind: 'bridge_mint',
      queryId: mint.queryId,
      confirmed,
      issue,
      evidence,
      settlement: {
        status: confirmed ? 'confirmed' : 'incomplete',
        protocol: 'sccp',
        operation: 'bridge_mint',
        queryId: mint.queryId,
        bridge,
        evidence,
      },
    });
  }
  return operations;
}
