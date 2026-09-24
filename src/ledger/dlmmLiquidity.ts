import { DLMM_ADD_PROCESSING_VALUE } from './dlmmState';
import { canonicalLedgerHash } from './normalize';
import type { LedgerEvidenceRef, DlmmLiquidityMetadata, DlmmDepositMetadata } from './types';
import type { MarketNode } from './marketTypes';
import type { DlmmProofBinding } from './dlmmProof';
import { address, createDlmmProofGraph, key, marketHash, ref, requireProof } from './dlmmProof';
import { dlmmPendingLiquidityKey, readDlmmLiquidityState, verifyDlmmLiquidityTransition, type DlmmLiquidityRequest } from './dlmmLiquidityState';
import { perpsWalletAddress } from './perpsWire';
import { bodyCell, collectionRequest, dlmmLiquidityNotificationCommitment, opcode, REMOVE, COLLECT, COLLECT_TO, NOTIFY, protocolForward, tokenWire, withdrawalRequest, withdrawalReceipt } from './wire';

export type DlmmLiquidityCandidate = {
  acceptance: LedgerEvidenceRef; origin: LedgerEvidenceRef | null;
  kind: 'lp_withdraw' | 'lp_fee_collect'; queryId: string | null;
  metadata: DlmmLiquidityMetadata | null; evidence: LedgerEvidenceRef[];
  completion: LedgerEvidenceRef | null; issues: string[];
};
/** The owner-ledger wire uses base64 transaction hashes throughout, including
 * nested proof references. Contract/data/body hashes remain hexadecimal. */
function ownerLedgerEvidence<T>(candidate: T): T {
  const serialize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(serialize);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (typeof record.account === 'string' && typeof record.lt === 'string' && typeof record.hash === 'string' && typeof record.utime === 'number')
      return {...record, hash: canonicalLedgerHash(record.hash)};
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, serialize(item)]));
  };
  return serialize(candidate) as T;
}
const unique = (values: LedgerEvidenceRef[]) => [...new Map(values.map(value => [`${value.account}:${value.lt}:${marketHash(value.hash)}`, value])).values()];

/** Two funded contributions and the current pending journal prove an original
 * mint. A requested minimum or a free-standing share dictionary is insufficient. */
export function verifyDlmmDeposit(binding: DlmmProofBinding, supplied: readonly MarketNode[], owner: string, acceptanceRefs: LedgerEvidenceRef[]) {
  requireProof(acceptanceRefs.length === 2, 'dlmm_deposit_contribution_count_invalid');
  const graph = createDlmmProofGraph(binding, supplied);
  const acceptances = acceptanceRefs.map(value => graph.pools.find(node => key(node) === `${value.account}:${value.lt}:${marketHash(value.hash)}`));
  requireProof(acceptances.every(Boolean) && acceptances[0] !== acceptances[1], 'dlmm_deposit_acceptance_missing');
  const ordered = (acceptances as MarketNode[]).sort((a, b) => BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1);
  const contributions = ordered.map(node => {
    const notice = tokenWire(node.raw.inMessage), intent = notice && protocolForward(notice.forward);
    requireProof(notice?.op === NOTIFY && intent?.operation === 'lp_deposit' && intent.binId !== undefined && intent.minSharesRaw !== undefined &&
      (intent.owner ?? notice.owner) === owner && notice.owner === owner && notice.queryId !== intent.queryId && BigInt(notice.amountRaw) > 0n,
      'dlmm_deposit_intent_unverified');
    const state = graph.poolAt(node), credit = graph.origin(node).node, source = graph.origin(credit), original = graph.origin(source.node).node;
    const roots = [binding.tokenT, binding.tokenX].filter(root => perpsWalletAddress(state.after.walletCode, root, binding.pool) === credit.account);
    requireProof(roots.length === 1 && original.account === owner && source.node.account === notice.senderWallet, 'dlmm_deposit_source_identity_invalid');
    const paid = graph.physical(source.node, source.index, roots[0], owner, binding.pool, notice.amountRaw, false);
    requireProof(paid.credit === credit && paid.flow.wire.forward.hash().equals(notice.forward.hash()) && paid.flow.wire.queryId === notice.queryId &&
      paid.flow.wire.forwardTonRaw === notice.forwardTonRaw, 'dlmm_deposit_payment_unverified');
    return {node, notice, intent, state, paid, root: roots[0], original, source: source.node, credit};
  });
  const first = contributions[0], last = contributions[1];
  requireProof(first.root !== last.root && first.intent.queryId === last.intent.queryId && first.intent.binId === last.intent.binId,
    'dlmm_deposit_pair_invalid');
  const initial = readDlmmLiquidityState(first.node.before!.state.dataBoc!), pendingState = readDlmmLiquidityState(first.node.after!.state.dataBoc!),
    before = readDlmmLiquidityState(last.node.before!.state.dataBoc!), after = readDlmmLiquidityState(last.node.after!.state.dataBoc!);
  const pendingKey = dlmmPendingLiquidityKey(owner, first.intent.binId!, first.intent.queryId), pending = pendingState.pending.get(pendingKey);
  requireProof(!initial.pending.has(pendingKey) && pending && pendingState.pending.size === initial.pending.size + 1 &&
    before.pending.get(pendingKey)?.recordHash === pending.recordHash && !after.pending.has(pendingKey) && after.pending.size === before.pending.size - 1,
    'dlmm_deposit_pending_identity_invalid');
  const firstT = first.root === binding.tokenT;
  const originalFunding = BigInt(first.notice.forwardTonRaw);
  const refundFunding = (originalFunding > DLMM_ADD_PROCESSING_VALUE ? originalFunding - DLMM_ADD_PROCESSING_VALUE : 0n).toString();
  requireProof(pending.amountTRaw === (firstT ? first.notice.amountRaw : '0') && pending.amountXRaw === (firstT ? '0' : first.notice.amountRaw) &&
    pending.fundingTRaw === (firstT ? refundFunding : '0') && pending.fundingXRaw === (firstT ? '0' : refundFunding) &&
    pending.minSharesRaw === first.intent.minSharesRaw && pending.vaultT === (firstT ? owner : null) && pending.vaultX === (firstT ? null : owner) &&
    pending.notificationHashT === (firstT ? dlmmLiquidityNotificationCommitment(first.node.raw.inMessage) : '0'.repeat(64)) &&
    pending.notificationHashX === (firstT ? '0'.repeat(64) : dlmmLiquidityNotificationCommitment(first.node.raw.inMessage)),
    'dlmm_deposit_pending_contribution_invalid');
  for (const [id, row] of initial.pending) requireProof(pendingState.pending.get(id)?.recordHash === row.recordHash, 'dlmm_deposit_other_pending_changed');
  for (const [id, row] of before.pending) if (id !== pendingKey) requireProof(after.pending.get(id)?.recordHash === row.recordHash, 'dlmm_deposit_other_pending_changed');
  const mapValue = (map: Iterable<[unknown, unknown]>) => JSON.stringify([...map].sort(([a], [b]) => String(a).localeCompare(String(b))),
    (_, value) => typeof value === 'bigint' ? value.toString() : value);
  for (const field of ['bins', 'positions', 'checkpointsT', 'checkpointsX', 'creditsT', 'creditsX', 'lockedShares', 'withdrawals'] as const)
    requireProof(mapValue(initial[field]) === mapValue(pendingState[field]), 'dlmm_deposit_first_contribution_economics_changed');
  for (const field of ['feeGrowthGlobalTRaw', 'feeGrowthGlobalXRaw', 'activeWithdrawalQueryId', 'binLiquidityCapRaw'] as const)
    requireProof(initial[field] === pendingState[field], 'dlmm_deposit_first_contribution_counters_changed');
  for (const field of ['feeClaimedT', 'feeClaimedX', 'guardHash', 'farmingHash', 'nextCampaignId', 'farmEscrowT', 'farmEscrowX',
    'reservedT', 'reservedX', 'reservedNative', 'nextSettlementId', 'activeBinId', 'lastUpdate'] as const)
    requireProof(initial.market[field] === pendingState.market[field], 'dlmm_deposit_first_contribution_market_changed');
  for (const field of ['settlements', 'lanes', 'queues'] as const)
    requireProof(mapValue(initial.market[field]) === mapValue(pendingState.market[field]), 'dlmm_deposit_first_contribution_journal_changed');
  const minSharesRaw = BigInt(first.intent.minSharesRaw!) > BigInt(last.intent.minSharesRaw!) ? first.intent.minSharesRaw! : last.intent.minSharesRaw!;
  const amounts = verifyDlmmLiquidityTransition(before, after, {kind: 'add', owner, binId: first.intent.binId!, minSharesRaw,
    amountTRaw: firstT ? first.notice.amountRaw : last.notice.amountRaw, amountXRaw: firstT ? last.notice.amountRaw : first.notice.amountRaw});
  requireProof(before.market.nextSettlementId === after.market.nextSettlementId && before.market.reservedT === after.market.reservedT &&
    before.market.reservedX === after.market.reservedX && before.market.reservedNative === after.market.reservedNative &&
    mapValue(before.market.settlements) === mapValue(after.market.settlements) && mapValue(before.market.lanes) === mapValue(after.market.lanes) &&
    mapValue(before.market.queues) === mapValue(after.market.queues),
    'dlmm_deposit_unexpected_payout_allocation');
  const prior = graph.nodes.find(node => node.account === binding.pool && node.raw.lt === last.node.raw.prevTransactionLt &&
    marketHash(node.raw.hash) === marketHash(last.node.raw.prevTransactionHash!));
  requireProof(prior, 'dlmm_deposit_prior_transaction_missing');
  const metadata: Omit<DlmmDepositMetadata, 'contributions'> & {
    contributions: Omit<DlmmDepositMetadata['contributions'][number], 'movementId'>[];
  } = {network: binding.network, pool: binding.pool, poolCodeHash: binding.poolCodeHash, walletCodeHash: binding.walletCodeHash,
    owner, binId: first.intent.binId!, queryId: first.intent.queryId,
    sharesBeforeRaw: amounts.beforePosition.sharesRaw, sharesAfterRaw: amounts.afterPosition.sharesRaw,
    mintedSharesRaw: amounts.mintedSharesRaw, minSharesRaw,
    stateBefore: {seqno: last.node.before!.seqno, dataHash: before.market.dataHash, transaction: ref(prior)},
    stateAfter: {seqno: last.node.after!.seqno, dataHash: after.market.dataHash, transaction: ref(last.node)},
    contributions: contributions.map(value => ({tokenSide: value.root === binding.tokenT ? 0 : 1,
      assetId: `${binding.network}:jetton:${value.root}`, master: value.root, amountRaw: value.notice.amountRaw,
      sourceWallet: value.source.account, destinationWallet: value.credit.account,
      transferQueryId: value.notice.queryId, minSharesRaw: value.intent.minSharesRaw!, forwardTonRaw: value.notice.forwardTonRaw,
      requestBodyHash: bodyCell(value.source.raw.inMessage)!.hash().toString('hex'),
      notificationBodyHash: bodyCell(value.node.raw.inMessage)!.hash().toString('hex'),
      origin: ref(value.original), debit: ref(value.source), credit: ref(value.credit), acceptance: ref(value.node),
      boundaries: [value.paid.debitState.evidence, value.paid.creditState.evidence, value.state.evidence]}))};
  return {amounts, before: last.node.before!, after: last.node.after!, beforeDataHash: before.market.dataHash, afterDataHash: after.market.dataHash,
    metadata: ownerLedgerEvidence(metadata),
    evidence: ownerLedgerEvidence(unique(contributions.flatMap(value => [ref(value.original), ref(value.source), ref(value.credit), ref(value.node)])))};
}

/** Exact source evidence, independent of accounting policy. Principal and earned
 * fees partition each physical receipt; they never create additional movements. */
export function projectDlmmLiquidity(binding: DlmmProofBinding, supplied: readonly MarketNode[], owner: string): DlmmLiquidityCandidate[] {
  const candidates = supplied.filter(node => node.account === binding.pool && address(node.raw.inMessage?.source) === owner &&
    [REMOVE, COLLECT, COLLECT_TO].includes(opcode(node.raw.inMessage) ?? node.raw.inMessage?.op ?? -1));
  let graph: ReturnType<typeof createDlmmProofGraph>;
  try { graph = createDlmmProofGraph(binding, supplied); }
  catch (error) {
    return candidates.map(node => ownerLedgerEvidence({ acceptance: ref(node), origin: null, kind: opcode(node.raw.inMessage) === REMOVE ? 'lp_withdraw' : 'lp_fee_collect',
      queryId: withdrawalRequest(node.raw.inMessage)?.queryId ?? null, metadata: null, evidence: [ref(node)], completion: null,
      issues: [error instanceof Error ? error.message : 'dlmm_liquidity_graph_unavailable'] }));
  }
  return candidates.map(acceptance => {
    const op = opcode(acceptance.raw.inMessage), withdrawal = withdrawalRequest(acceptance.raw.inMessage), collection = collectionRequest(acceptance.raw.inMessage);
    const result: DlmmLiquidityCandidate = { acceptance: ref(acceptance), origin: null, kind: op === REMOVE ? 'lp_withdraw' : 'lp_fee_collect',
      // Collections have no business query ID. Never merge their wire query-zero payouts.
      queryId: withdrawal?.queryId ?? null, metadata: null, evidence: [ref(acceptance)], completion: null, issues: [] };
    try {
      const original = graph.origin(acceptance).node;
      requireProof(original.account === owner, 'dlmm_liquidity_request_owner_unverified');
      result.origin = ref(original); result.evidence.push(ref(original));
      const wire = withdrawal ?? collection;
      requireProof(wire && [REMOVE, COLLECT, COLLECT_TO].includes(op!), 'dlmm_liquidity_request_invalid');
      const state = graph.poolAt(acceptance);
      const before = readDlmmLiquidityState(acceptance.before!.state.dataBoc!), after = readDlmmLiquidityState(acceptance.after!.state.dataBoc!);
      const request: DlmmLiquidityRequest = withdrawal ? {kind: 'withdrawal', owner, recipient: wire.recipient, binId: wire.binId, sharesRaw: wire.shares, queryId: withdrawal.queryId} :
        {kind: 'collect-fees', owner, recipient: wire.recipient, binId: wire.binId, sharesRaw: wire.shares};
      const amounts = verifyDlmmLiquidityTransition(before, after, request);
      const records = [...state.after.settlements.values()].filter(record => !state.before.settlements.has(record.settlementId))
        .sort((a, b) => BigInt(a.settlementId) < BigInt(b.settlementId) ? -1 : 1);
      const totals = [amounts.totalTRaw, amounts.totalXRaw], principals = [amounts.principalTRaw, amounts.principalXRaw], fees = [amounts.feeTRaw, amounts.feeXRaw];
      const businessQueryId = withdrawal?.queryId ?? '0', expectedKind = withdrawal ? 5 : 4;
      requireProof(records.length === totals.filter(value => value !== '0').length, 'dlmm_liquidity_allocation_count_invalid');
      let next = BigInt(state.before.nextSettlementId), recordIndex = 0;
      for (const tokenSide of [0, 1] as const) {
        if (totals[tokenSide] === '0') continue;
        const record = records[recordIndex++]; let attempts = 0;
        while ((next === 0n || next.toString() === businessQueryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) && attempts++ < 32) next++;
        const root = tokenSide === 0 ? binding.tokenT : binding.tokenX;
        requireProof(attempts < 32 && next < 0xffffffffffffffffn && record.settlementId === next.toString(), 'dlmm_liquidity_allocation_sequence_invalid'); next++;
        requireProof(record.businessQueryId === businessQueryId && record.kind === expectedKind && record.tokenSide === tokenSide &&
          record.amountRaw === totals[tokenSide] && record.destinationOwner === wire.recipient &&
          record.sourceWallet === perpsWalletAddress(state.after.walletCode, root, binding.pool) &&
          record.destinationWallet === perpsWalletAddress(state.after.walletCode, root, wire.recipient) &&
          record.predecessorId === '0' && record.successorId === '0' && [1, 2].includes(record.status) && record.recordedAt === acceptance.raw.utime &&
          record.forwardTonAmountRaw === '0' && !record.forwardPayload.bits.length && !record.forwardPayload.refs.length,
          'dlmm_liquidity_allocation_record_invalid');
        if (withdrawal) requireProof(after.withdrawals.get(withdrawal.queryId)?.[tokenSide === 0 ? 'settlementTId' : 'settlementXId'] === record.settlementId, 'dlmm_liquidity_withdrawal_nonce_invalid');
      }
      requireProof(next.toString() === state.after.nextSettlementId &&
        BigInt(state.after.reservedT) - BigInt(state.before.reservedT) === BigInt(totals[0]) &&
        BigInt(state.after.reservedX) - BigInt(state.before.reservedX) === BigInt(totals[1]) &&
        [...state.before.settlements].every(([id, record]) => {
          const afterRecord = state.after.settlements.get(id);
          return afterRecord && (afterRecord.recordHash === record.recordHash || record.successorId === '0' && graph.sameRecord(afterRecord, record) &&
            afterRecord.status === record.status && afterRecord.fundedRaw === record.fundedRaw && afterRecord.recordedAt === record.recordedAt &&
            records.some(added => added.settlementId === afterRecord.successorId && added.sourceWallet === record.sourceWallet));
        }), 'dlmm_liquidity_allocation_conservation_failed');
      const reservedForSends = records.reduce((sum, record) => sum + BigInt(record.fundedRaw), 0n);
      requireProof(BigInt(state.after.reservedNative) - BigInt(state.before.reservedNative) === reservedForSends +
        (withdrawal ? BigInt(after.withdrawals.get(withdrawal.queryId)!.completionFundedRaw) : 0n), 'dlmm_liquidity_native_allocation_invalid');
      const prior = graph.nodes.find(node => node.account === binding.pool && node.raw.lt === acceptance.raw.prevTransactionLt && marketHash(node.raw.hash) === marketHash(acceptance.raw.prevTransactionHash!));
      requireProof(prior, 'dlmm_liquidity_prior_transaction_missing');
      const metadata: DlmmLiquidityMetadata = { pool: binding.pool, poolCodeHash: binding.poolCodeHash, walletCodeHash: binding.walletCodeHash,
        owner, recipient: wire.recipient, binId: wire.binId,
        request: {opcode: op!, sharesRaw: wire.shares, bodyHash: bodyCell(acceptance.raw.inMessage)!.hash().toString('hex'), transaction: ref(acceptance)},
        stateBefore: {seqno: acceptance.before!.seqno, dataHash: state.before.dataHash, transaction: ref(prior)},
        stateAfter: {seqno: acceptance.after!.seqno, dataHash: state.after.dataHash, transaction: ref(acceptance)},
        sharesBeforeRaw: amounts.beforePosition.sharesRaw, sharesAfterRaw: amounts.afterPosition.sharesRaw,
        economics: {principalTRaw: amounts.principalTRaw, principalXRaw: amounts.principalXRaw, earnedFeeTRaw: amounts.feeTRaw, earnedFeeXRaw: amounts.feeXRaw, totalTRaw: amounts.totalTRaw, totalXRaw: amounts.totalXRaw}, payouts: [] };
      result.metadata = metadata;
      for (const tokenSide of [0, 1] as const) {
        const root = tokenSide === 0 ? binding.tokenT : binding.tokenX, record = records.find(value => value.tokenSide === tokenSide);
        const payout: DlmmLiquidityMetadata['payouts'][number] = {tokenSide, assetId: `${binding.network}:jetton:${root}`, master: root,
          sourceWallet: perpsWalletAddress(state.after.walletCode, root, binding.pool), destinationOwner: wire.recipient,
          destinationWallet: perpsWalletAddress(state.after.walletCode, root, wire.recipient), settlementId: record?.settlementId ?? null,
          totalRaw: totals[tokenSide], principalRaw: principals[tokenSide], earnedFeeRaw: fees[tokenSide], movementId: null, delivery: null,
          status: record ? 'unresolved' : 'none', finalization: record ? 'unresolved' : 'none'};
        metadata.payouts.push(payout);
        if (!record) continue;
        try {
          const delivery = graph.deliver(acceptance, record, state.after.walletCode);
          payout.settlementId = delivery.record.settlementId;
          payout.status = 'delivered'; payout.delivery = delivery.evidence.credit; payout.deliveryEvidence = delivery.evidence;
          result.evidence.push(delivery.evidence.request, delivery.evidence.debit, delivery.evidence.credit, ...delivery.evidence.boundaries.map(boundary => boundary.transaction));
          // A later acknowledgement/finalizer failure cannot erase a verified
          // physical receipt, its exact components, or its actual credit date.
          const settlement = graph.settle(acceptance, record, state.after.walletCode, delivery);
          payout.finalization = 'confirmed'; payout.settlementEvidence = settlement;
          result.evidence.push(settlement.acknowledged, settlement.walletFinalized, settlement.poolFinalized,
            ...settlement.boundaries.map(boundary => boundary.transaction));
        } catch (error) { result.issues.push(error instanceof Error ? error.message : 'dlmm_liquidity_payout_unverified'); }
      }
      if (withdrawal && metadata.payouts.every(value => value.finalization !== 'unresolved')) {
        // Native completion is separate from token credit; it proves the contract
        // released its completion reserve and closed both withdrawal legs.
        const completions = graph.pools.flatMap(node => node.raw.outMessages.map((message, index) => ({node, message, index, value: withdrawalReceipt(message)})))
          .filter(({node, value}) => BigInt(node.raw.lt) >= BigInt(acceptance.raw.lt) && value?.queryId === withdrawal.queryId);
        requireProof(completions.length === 1, 'dlmm_liquidity_completion_missing_or_repeated');
        const completion = completions[0], value = completion.value!, delivered = graph.edge(completion.node, completion.index);
        requireProof(value.owner === owner && value.recipient === wire.recipient && value.binId === wire.binId && value.shares === wire.shares &&
          value.amountT === totals[0] && value.amountX === totals[1] && delivered.account === owner && completion.message.value === '50000000' &&
          delivered.raw.inMessage?.value === completion.message.value, 'dlmm_liquidity_completion_identity_invalid');
        const terminal = readDlmmLiquidityState(completion.node.after!.state.dataBoc!), row = terminal.withdrawals.get(withdrawal.queryId)!;
        requireProof(row && row.legT === 1 && row.legX === 1 && row.completionFundedRaw === '0' && terminal.activeWithdrawalQueryId === '0' &&
          row.owner === owner && row.recipient === wire.recipient && row.binId === wire.binId && row.sharesRaw === wire.shares && row.totalTRaw === totals[0] && row.totalXRaw === totals[1],
          'dlmm_liquidity_completion_state_invalid');
        const terminalBoundary = graph.poolAt(completion.node);
        requireProof(BigInt(terminalBoundary.before.reservedNative) - BigInt(terminalBoundary.after.reservedNative) === 50000000n ||
          completion.node === acceptance && records.length === 0, 'dlmm_liquidity_completion_reserve_invalid');
        result.completion = ref(delivered); result.evidence.push(ref(completion.node), ref(delivered));
      }
    } catch (error) { result.issues.push(error instanceof Error ? error.message : 'dlmm_liquidity_evidence_unavailable'); }
    result.evidence = unique(result.evidence); result.issues = [...new Set(result.issues)]; return ownerLedgerEvidence(result);
  });
}
