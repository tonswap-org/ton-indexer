import { Cell } from '@ton/core';
import type { Flow, Node, ProjectionInput } from './project';
import type { LedgerEvent, LedgerEvidenceRef } from './types';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { perpsWalletAddress } from './perpsWire';
import { bodyCell } from './wire';
import type { LedgerLaunchpadFixedSale } from './launchpadModels';
import { readLaunchpadRequests, type LaunchpadOriginalRequest } from './launchpadRequests';
import { readFixedLaunchpadBoundary as boundary, qualifyLaunchpadWallet as qualifyWallet, proveFixedContribution } from './launchpadContributions';
import { readFixedSaleState, type FixedSaleContribution, type FixedSaleSettlement } from './launchpadState';
import {
  fixedSaleSettlementRequestHash, launchpadCommand, launchpadInternalSettlementTransfer,
  launchpadSettlementTransfer, launchpadSettlementTuple,
} from './launchpadWire';

export type LaunchpadRefundMetadata = {
  model: 'fixed'; reason: 'failed-soft-cap' | null; sale: string; factory: string | null;
  saleId: string | null; participant: string; claimQueryId: string; claimBodyHash: string; claimRequest: LaunchpadOriginalRequest;
  paymentRoot: string; sourceWallet: string; recipientOwner: string | null; destinationWallet: string | null;
  amountRaw: string | null; settlementId: string | null; settlementRequestHash: string | null;
  originalPayment: { queryId: string; amountRaw: string; sourceWallet: string; destinationWallet: string;
    requestBodyHash: string; evidence: LedgerEvidenceRef[] } | null;
  contribution: { before: FixedSaleContribution; after: FixedSaleContribution } | null;
  stateEvidence: { purpose: 'contribution' | 'refund-enqueue' | 'delivery' | 'finalization';
    transaction: LedgerEvidenceRef; beforeHash: string; afterHash: string; beforeSeqno: number; afterSeqno: number }[];
  localNetworkFees: { transaction: LedgerEvidenceRef; amountRaw: string | null; includedInOwnerFeeMovements: boolean }[];
};
export type LaunchpadRefundOperation = {
  anchor: Node; kind: 'launchpad_refund'; queryId: string; confirmed: boolean;
  evidence: LedgerEvidenceRef[]; issue?: string; settlement: NonNullable<LedgerEvent['settlement']>;
};
type SaleState = ReturnType<typeof readFixedSaleState>;
type ReceiptFor = (node: Node, index: number) => Node | null;
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
const ok = (node: Node) => node.raw.success && (!node.raw.status || node.raw.status === 'success') && !node.raw.inMessage?.bounced;
const ref = (node: Node): LedgerEvidenceRef => ({ account: node.account, lt: node.raw.lt, hash: canonicalLedgerHash(node.raw.hash), utime: node.raw.utime });
const unique = (nodes: Node[]) => [...new Map(nodes.map(node => [node.id, node])).values()];
const one = <T>(items: T[]) => items.length === 1 ? items[0] : null;
const requireEvidence: (condition: unknown, issue: string) => asserts condition = (condition, issue) => { if (!condition) throw Error(issue); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const except = (object: object, fields: string[]) => Object.fromEntries(Object.entries(object).filter(([key]) => !fields.includes(key)));
const sameOtherEntries = <T>(before: Map<string, T>, after: Map<string, T>, changed: Set<string>) =>
  before.size === after.size && [...before].every(([key, value]) => changed.has(key) || same(value, after.get(key)));
function immutableRecord(before: FixedSaleSettlement, after: FixedSaleSettlement, mutable: string[]) {
  return same(except(before, ['recordHash', 'state', ...mutable]), except(after, ['recordHash', 'state', ...mutable]));
}
function refundRecord(record: FixedSaleSettlement, sale: LedgerLaunchpadFixedSale, owner: string, amount: string) {
  return record.route === 1 && record.kind === 3 && record.amountRaw === amount && record.recipientOwner === owner &&
    record.tokenRoot === sale.paymentRoot && record.sourceWallet === sale.paymentWallet && record.destinationWallet === perpsWalletAddress(sale.paymentWalletCode, sale.paymentRoot, owner) &&
    record.forwardTonAmountRaw === '0' && Cell.fromBase64(record.forwardPayloadBoc).bits.length === 0 &&
    Cell.fromBase64(record.forwardPayloadBoc).refs.length === 0 && record.requestHash === fixedSaleSettlementRequestHash(sale.address, record);
}
function validateEnqueue(before: SaleState, after: SaleState, sale: LedgerLaunchpadFixedSale, owner: string) {
  const old = before.contributions.get(owner), updated = after.contributions.get(owner);
  requireEvidence(before.registry.factory !== null && before.metrics.finalized && after.metrics.finalized && !before.metrics.successful && !after.metrics.successful &&
    BigInt(before.metrics.totalRaisedRaw) < BigInt(before.config.softCapRaw), 'launchpad_refund_failed_sale_unverified');
  requireEvidence(old && updated && !old.claimed && (old.refundWallet === null || old.refundWallet === owner) && BigInt(old.paymentAmountRaw) > 0n && updated.claimed &&
    updated.paymentAmountRaw === '0' && updated.tokenAmountRaw === '0' && old.rewardWallet === updated.rewardWallet && old.refundWallet === updated.refundWallet && old.feePaidRaw === updated.feePaidRaw && old.referrer === updated.referrer &&
    sameOtherEntries(before.contributions, after.contributions, new Set([owner])), 'launchpad_refund_entitlement_unverified');
  const amount = BigInt(old.paymentAmountRaw), oldMetrics = before.metrics, newMetrics = after.metrics;
  requireEvidence(BigInt(oldMetrics.outstandingRaisedRaw) - BigInt(newMetrics.outstandingRaisedRaw) === amount &&
    BigInt(newMetrics.totalRefundedRaw) - BigInt(oldMetrics.totalRefundedRaw) === amount &&
    BigInt(newMetrics.totalRefundedRaw) === BigInt(newMetrics.totalRaisedRaw) - BigInt(newMetrics.outstandingRaisedRaw) &&
    BigInt(oldMetrics.totalFeesRaw) - BigInt(newMetrics.totalFeesRaw) === BigInt(old.feePaidRaw) &&
    same(except(oldMetrics, ['outstandingRaisedRaw', 'totalRefundedRaw', 'escrowBalanceRaw', 'totalFeesRaw']), except(newMetrics, ['outstandingRaisedRaw', 'totalRefundedRaw', 'escrowBalanceRaw', 'totalFeesRaw'])), 'launchpad_refund_accounting_delta_unverified');
  const b = before.journal, a = after.journal;
  const added = [...a.entries.values()].filter(record => !b.entries.has(record.settlementId));
  const record = one(added.filter(item => refundRecord(item, sale, owner, old.paymentAmountRaw)));
  requireEvidence(record && record.settlementId === b.nextSettlementId && record.predecessorId === '0' && record.status === 2 &&
    record.deliveryReservedRaw === '0' && record.finalizeReservedRaw === '40000000' && b.currentPaymentId === '0' && b.tailPaymentId === '0', 'launchpad_refund_initial_record_unverified');
  requireEvidence([...b.entries].every(([id, item]) => same(item, a.entries.get(id))) &&
    a.entries.size === b.entries.size + added.length && added.length >= 1 && added.length <= 2 &&
    BigInt(a.nextSettlementId) === BigInt(b.nextSettlementId) + BigInt(added.length) &&
    a.currentPaymentId === record.settlementId && a.currentSaleId === b.currentSaleId && a.tailSaleId === b.tailSaleId &&
    a.reservedSaleRaw === b.reservedSaleRaw, 'launchpad_refund_enqueue_journal_unverified');
  const escrow = added.filter(item => item !== record);
  if (escrow.length) {
    const item = escrow[0], remaining = BigInt(oldMetrics.escrowBalanceRaw);
    requireEvidence(newMetrics.outstandingRaisedRaw === '0' && newMetrics.escrowBalanceRaw === '0' && remaining > 0n &&
      item.settlementId === (BigInt(record.settlementId) + 1n).toString() && item.route === 1 && item.kind === 6 &&
      item.recipientOwner === before.registry.owner && item.recipientOwner !== owner && item.amountRaw === remaining.toString() &&
      item.sourceWallet === sale.paymentWallet && item.destinationWallet === perpsWalletAddress(sale.paymentWalletCode, sale.paymentRoot, item.recipientOwner) &&
      item.predecessorId === record.settlementId && item.status === 1 && item.requestHash === fixedSaleSettlementRequestHash(sale.address, item) &&
      a.tailPaymentId === item.settlementId, 'launchpad_refund_separate_escrow_unverified');
  } else requireEvidence(BigInt(oldMetrics.escrowBalanceRaw) - BigInt(newMetrics.escrowBalanceRaw) === 0n && a.tailPaymentId === record.settlementId, 'launchpad_refund_escrow_delta_unverified');
  requireEvidence(BigInt(a.reservedPaymentRaw) - BigInt(b.reservedPaymentRaw) === added.reduce((sum, item) => sum + BigInt(item.amountRaw), 0n), 'launchpad_refund_reserve_enqueue_unverified');
  return { old, updated, record };
}
function validateCallback(before: SaleState, after: SaleState, record: FixedSaleSettlement, phase: 'delivery' | 'finalization') {
  const b = before.journal, a = after.journal, old = b.entries.get(record.settlementId), next = a.entries.get(record.settlementId);
  const successor = old?.successorId && old.successorId !== '0' ? b.entries.get(old.successorId) : undefined;
  const advanced = phase === 'finalization' && successor?.status === 1 && BigInt(successor.deliveryReservedRaw) > 0n && successor.finalizeReservedRaw === '40000000';
  const changed = new Set([record.settlementId, ...(advanced ? [successor!.settlementId] : [])]);
  requireEvidence(old && next && immutableRecord(record, old, ['status', 'deliveryReservedRaw', 'finalizeReservedRaw']) &&
    immutableRecord(old, next, ['status', 'finalizeReservedRaw']) && old.deliveryReservedRaw === '0' && next.deliveryReservedRaw === '0' &&
    sameOtherEntries(b.entries, a.entries, changed) && same(before.metrics, after.metrics) && same([...before.contributions], [...after.contributions]) &&
    a.referralCredits.dataHash === b.referralCredits.dataHash && a.nextSettlementId === b.nextSettlementId &&
    a.currentSaleId === b.currentSaleId && a.tailSaleId === b.tailSaleId && a.reservedSaleRaw === b.reservedSaleRaw && b.currentPaymentId === record.settlementId,
    'launchpad_refund_callback_state_unverified');
  if (phase === 'delivery') {
    requireEvidence(old.status === 2 && next.status === 3 && old.finalizeReservedRaw === '40000000' && next.finalizeReservedRaw === '0' &&
      BigInt(b.reservedNativeRaw) - BigInt(a.reservedNativeRaw) === 40000000n &&
      a.currentPaymentId === b.currentPaymentId && a.tailPaymentId === b.tailPaymentId && a.reservedPaymentRaw === b.reservedPaymentRaw,
      'launchpad_refund_delivery_delta_unverified');
  } else {
    if (advanced) {
      const dispatched = a.entries.get(successor!.settlementId);
      requireEvidence(dispatched && successor!.route === old.route && successor!.predecessorId === old.settlementId &&
        immutableRecord(successor!, dispatched, ['status','deliveryReservedRaw']) && dispatched.status === 2 && dispatched.deliveryReservedRaw === '0' &&
        a.currentPaymentId === successor!.settlementId && BigInt(b.reservedNativeRaw) - BigInt(a.reservedNativeRaw) === BigInt(successor!.deliveryReservedRaw),
        'launchpad_refund_successor_dispatch_unverified');
    } else requireEvidence(a.currentPaymentId === '0' && a.reservedNativeRaw === b.reservedNativeRaw, 'launchpad_refund_final_lane_unverified');
    requireEvidence(old.status === 3 && next.status === 5 && old.finalizeReservedRaw === '0' && next.finalizeReservedRaw === '0' &&
      a.tailPaymentId === (b.tailPaymentId === record.settlementId ? '0' : b.tailPaymentId) &&
      BigInt(b.reservedPaymentRaw) - BigInt(a.reservedPaymentRaw) === BigInt(record.amountRaw), 'launchpad_refund_final_reserve_release_unverified');
  }
}
function exactEdge<T>(node: Node, destination: string, receiptFor: ReceiptFor, parse: (message?: Node['raw']['inMessage']) => T | null, match: (value: T) => boolean) {
  return one(node.raw.outMessages.flatMap((message, index) => {
    const value = parse(message), recipient = receiptFor(node, index);
    return address(message.source) === node.account && address(message.destination) === destination && !message.bounced && value && match(value) &&
      recipient && recipient.account === destination && ok(recipient) && BigInt(recipient.raw.lt) > BigInt(node.raw.lt)
      ? [{ node: recipient, value }] : [];
  }));
}
async function proveCash(input: ProjectionInput, start: Node, sale: LedgerLaunchpadFixedSale, record: FixedSaleSettlement, receiptFor: ReceiptFor, retain: (node: Node) => void) {
  const source = exactEdge(start, record.sourceWallet, receiptFor, launchpadSettlementTransfer, value => value.queryId === record.settlementId &&
    value.amountRaw === record.amountRaw && value.recipientOwner === record.recipientOwner && value.responseOwner === sale.address &&
    value.bodyHash === record.requestHash && value.forwardTonAmountRaw === record.forwardTonAmountRaw && value.forwardPayloadHash === record.forwardPayloadHash);
  requireEvidence(source, 'launchpad_refund_dispatch_unverified');
  retain(source.node);
  const credit = exactEdge(source.node, record.destinationWallet, receiptFor, launchpadInternalSettlementTransfer, value => value.queryId === record.settlementId &&
    value.amountRaw === record.amountRaw && value.fromOwner === sale.address && value.responseWallet === record.sourceWallet &&
    value.forwardTonAmountRaw === record.forwardTonAmountRaw && value.forwardPayloadHash === record.forwardPayloadHash);
  requireEvidence(credit, 'launchpad_refund_receiver_credit_unverified');
  retain(credit.node);
  const edge = (node: Node, destination: string, kind: string) => exactEdge(node, destination, receiptFor, launchpadSettlementTuple,
    value => value.kind === kind && value.queryId === record.settlementId && value.amountRaw === record.amountRaw && value.destination === record.destinationWallet)?.node;
  const accepted = edge(credit.node, record.sourceWallet, 'accepted');
  requireEvidence(accepted, 'launchpad_refund_receiver_ack_unverified');
  retain(accepted);
  const delivered = edge(accepted, sale.address, 'succeeded');
  requireEvidence(delivered, 'launchpad_refund_delivery_callback_unverified');
  retain(delivered);
  const finalized = edge(delivered, record.sourceWallet, 'finalize');
  requireEvidence(finalized, 'launchpad_refund_wallet_finalize_unverified');
  retain(finalized);
  const terminal = edge(finalized, sale.address, 'finalized');
  requireEvidence(terminal, 'launchpad_refund_final_callback_unverified');
  retain(terminal);
  const proof = [start, source.node, credit.node, accepted, delivered, finalized, terminal];
  requireEvidence(proof.every(node => input.chains.get(node.account)?.historyComplete), 'launchpad_refund_history_incomplete');
  for (const node of proof.filter(node => [record.sourceWallet, record.destinationWallet].includes(node.account)))
    await qualifyWallet(input, node, sale, node.account === record.sourceWallet ? sale.address : record.recipientOwner);
  return { source: source.node, credit: credit.node, delivered, terminal, nodes: proof };
}
async function originalPayment(input: ProjectionInput, nodes: Node[], flows: Flow[], sale: LedgerLaunchpadFixedSale,
  claim: Node, entry: FixedSaleContribution, receiptFor: ReceiptFor) {
  const matches: Awaited<ReturnType<typeof proveFixedContribution>>[] = [];
  for (const flow of flows) {
    if (flow.sourceAsset.owner !== input.owner || flow.recipientAsset.owner !== sale.address ||
      flow.wire.amountRaw !== entry.paymentAmountRaw || BigInt(flow.recipient.raw.lt) >= BigInt(claim.raw.lt)) continue;
    try {
      const proof = await proveFixedContribution(input, nodes, flow, sale, receiptFor), entitlement = proof.metadata.entitlement;
      // This refund edition remains restricted to one original contribution. A
      // general acceptance proof may validly start with a nonzero prior entry.
      if (entitlement?.model === 'fixed' && entitlement.before === null && same(entitlement.after, entry)) matches.push(proof);
    } catch { /* A different unqualified payment does not certify this claim. */ }
  }
  const proof = one(matches); requireEvidence(proof, 'launchpad_refund_original_payment_unverified');
  return { result: { flow: proof.flow, node: proof.node, evidence: proof.state }, metadata: {
    queryId: proof.metadata.outerQueryId, amountRaw: proof.metadata.payment.amountRaw, sourceWallet: proof.metadata.payment.sourceWallet,
    destinationWallet: proof.metadata.payment.destinationWallet, requestBodyHash: proof.metadata.payment.requestBodyHash,
    evidence: [proof.flow.source, proof.flow.recipient, proof.node].map(ref) } };
}

/** Certify only the initial failed-soft-cap fixed-sale refund. Original payment
 * evidence stays in its original economic event; no movement or fee is invented. */
export async function decodeLaunchpadRefunds(input: ProjectionInput, nodes: Node[], flows: Flow[], receiptFor: ReceiptFor, attach: (a: Node, b: Node) => void) {
  const operations: LaunchpadRefundOperation[] = [], usedFlows = new Set<string>(), seen = new Set<string>();
  for (const node of nodes) {
    const sale = input.launchpadSales?.get(node.account), claim = launchpadCommand(node.raw.inMessage);
    if (!sale || sale.model !== 'fixed' || claim?.kind !== 'claim' || !ok(node) || address(node.raw.inMessage?.source) !== input.owner ||
      (claim.beneficiary !== null && claim.beneficiary !== input.owner)) continue;
    const anchor = one(nodes.filter(candidate => candidate.account === input.owner && candidate.event && ok(candidate) &&
      candidate.raw.outMessages.some((message, index) => receiptFor(candidate, index)?.id === node.id &&
        address(message.source) === input.owner && address(message.destination) === sale.address && !message.bounced && bodyCell(message)?.hash().toString('hex') === claim.bodyHash)));
    if (!anchor) continue;
    const claimIndices = anchor.raw.outMessages.flatMap((message, index) => receiptFor(anchor, index)?.id === node.id &&
      bodyCell(message)?.hash().toString('hex') === claim.bodyHash ? [index] : []);
    if (claimIndices.length !== 1) continue;
    const request = readLaunchpadRequests(input, anchor).find(request => request.kind === 'claim' && request.sale === sale.address &&
      request.originalRequest.messageIndex === claimIndices[0] && request.originalRequest.messageBodyHash === claim.bodyHash);
    if (!request) continue;
    const key = `${sale.address}:${input.owner}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mark = (issue: string) => { if (!anchor.event!.issues.includes(issue)) anchor.event!.issues.push(issue); };
    let claimState: Awaited<ReturnType<typeof boundary>>;
    try { claimState = await boundary(input, node, sale); }
    catch { mark('launchpad_refund_state_or_code_unverified'); continue; }
    if (!claimState.before.metrics.finalized || claimState.before.metrics.successful) { mark('launchpad_claim_unsupported'); continue; }
    const metadata: LaunchpadRefundMetadata = { model: 'fixed', reason: null, sale: sale.address, factory: sale.factory,
      saleId: claimState.before.saleId, participant: input.owner, claimQueryId: claim.queryId, claimBodyHash: claim.bodyHash, claimRequest: request.originalRequest,
      paymentRoot: sale.paymentRoot, sourceWallet: sale.paymentWallet, recipientOwner: null, destinationWallet: null,
      amountRaw: null, settlementId: null, settlementRequestHash: null, originalPayment: null, contribution: null,
      stateEvidence: [], localNetworkFees: [] };
    let proof: Node[] = [anchor, node], issue: string | undefined, confirmed = false;
    try {
      requireEvidence(input.chains.get(input.owner)?.historyComplete && input.chains.get(sale.address)?.historyComplete, 'launchpad_refund_history_incomplete');
      const { old, updated, record } = validateEnqueue(claimState.before, claimState.after, sale, input.owner);
      metadata.reason = 'failed-soft-cap'; metadata.amountRaw = record.amountRaw; metadata.settlementId = record.settlementId;
      metadata.settlementRequestHash = record.requestHash; metadata.recipientOwner = record.recipientOwner; metadata.destinationWallet = record.destinationWallet;
      metadata.contribution = { before: old, after: updated };
      metadata.stateEvidence.push({ purpose: 'refund-enqueue', ...claimState.evidence });
      const original = await originalPayment(input, nodes, flows, sale, node, old, receiptFor);
      metadata.originalPayment = original.metadata;
      metadata.stateEvidence.push({ purpose: 'contribution', ...original.result.evidence.evidence });
      const cash = await proveCash(input, node, sale, record, receiptFor, member => { proof = unique([...proof, member]); });
      proof = unique([...proof, ...cash.nodes]);
      const delivery = await boundary(input, cash.delivered, sale), terminal = await boundary(input, cash.terminal, sale);
      validateCallback(delivery.before, delivery.after, record, 'delivery');
      validateCallback(terminal.before, terminal.after, record, 'finalization');
      metadata.stateEvidence.push({ purpose: 'delivery', ...delivery.evidence }, { purpose: 'finalization', ...terminal.evidence });
      const flow = one(flows.filter(flow => flow.source.id === cash.source.id && flow.recipient.id === cash.credit.id &&
        flow.confirmed && flow.wire.queryId === record.settlementId && flow.wire.amountRaw === record.amountRaw));
      requireEvidence(flow && !usedFlows.has(flow.id), 'launchpad_refund_cash_flow_unverified');
      usedFlows.add(flow.id);
      for (const movement of flow.recipient.event?.movements ?? []) if (movement.id === `${flow.id}:in` &&
        movement.asset.kind === 'jetton' && movement.asset.master === sale.paymentRoot && movement.direction === 'in') {
        movement.purpose = 'launchpad_refund';

      }
      confirmed = true;
    } catch (error) {
      issue = error instanceof Error && error.message.startsWith('launchpad_') ? error.message : 'launchpad_refund_evidence_invalid';
    }
    for (const member of proof) if (member.event) attach(anchor, member);
    metadata.localNetworkFees = proof.map(member => ({ transaction: ref(member), amountRaw: member.raw.totalFeesRaw ?? null, includedInOwnerFeeMovements: Boolean(member.event) }));
    const evidence = unique(proof).map(ref);
    operations.push({ anchor, kind: 'launchpad_refund', queryId: claim.queryId, confirmed, evidence, issue,
      settlement: { status: confirmed ? 'confirmed' : 'incomplete', protocol: 'launchpad', operation: 'launchpad_refund',
        queryId: claim.queryId, launchpad: metadata, evidence } });
  }
  return { operations, usedFlows };
}
