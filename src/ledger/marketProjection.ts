import { resolveHistoricalJettonPrecision } from './jettonPrecision';
import { Address, Cell, beginCell } from '@ton/core';
import { createHash } from 'node:crypto';
import type { RawMessage } from '../data/dataSource';
import { parseDlmmSwapForward } from '../utils/dlmmSettlementEvidence';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { readDlmmMarketState, type DlmmSettlementRecord } from './dlmmState';
import { matchPhysicalJettonFlow } from './jettonFlow';
import { perpsControl, perpsWalletAddress } from './perpsWire';
import { readT3RecoveryWallet } from './t3RecoveryState';
import { bodyCell, messageKey, NOTIFY, opcode, SWAP, tokenWire, TRANSFER, uint } from './wire';
import type { LedgerAsset, LedgerEvidenceRef } from './types';
import type { DlmmMarketBinding, MarketBoundaryEvidence, MarketDependency, MarketNode, MarketObservation, MarketProjection, MarketSettlementEvidence } from './marketTypes';

const requireProof: (value: unknown, issue: string) => asserts value = (value, issue) => { if (!value) throw new Error(issue); };
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
const successful = (node: MarketNode) => node.raw.success && (!node.raw.status || node.raw.status === 'success') && !node.raw.inMessage?.bounced;
const marketHash = (value: string) => Buffer.from(canonicalLedgerHash(value), 'base64').toString('hex');
const ref = (node: MarketNode): LedgerEvidenceRef => ({ account: node.account, lt: node.raw.lt, hash: marketHash(node.raw.hash), utime: node.raw.utime });
const key = (node: MarketNode) => `${node.account}:${node.raw.lt}:${marketHash(node.raw.hash)}`;
const cellHash = (boc: string) => Cell.fromBase64(boc).hash().toString('hex');
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
const positiveLt = (value: unknown): value is string => uint(value) && BigInt(value) > 0n && BigInt(value) <= 0xffffffffffffffffn;
type PoolState = ReturnType<typeof readDlmmMarketState>;

function boundary<T extends { dataHash: string }>(node: MarketNode, codeHash: string, parse: (boc: string) => T) {
  const { before, after } = node;
  requireProof(before && after && node.raw.prevTransactionLt && node.raw.prevTransactionHash, 'market_archive_missing');
  for (const [snapshot, lt, hash] of [[before, node.raw.prevTransactionLt, node.raw.prevTransactionHash], [after, node.raw.lt, node.raw.hash]] as const) {
    requireProof(snapshot.state.accountState === 'active' && snapshot.state.dataBoc && snapshot.state.codeBoc &&
      snapshot.state.lastTxLt === lt && snapshot.state.lastTxHash && canonicalLedgerHash(snapshot.state.lastTxHash) === canonicalLedgerHash(hash) &&
      cellHash(snapshot.state.codeBoc) === codeHash && Number.isSafeInteger(snapshot.seqno) && snapshot.seqno >= 0, 'market_archive_identity_or_code_unverified');
  }
  requireProof(before.seqno <= after.seqno, 'market_archive_order_invalid');
  const a = parse(before.state.dataBoc!), b = parse(after.state.dataBoc!);
  return { before: a, after: b, evidence: { transaction: ref(node), beforeSeqno: before.seqno, afterSeqno: after.seqno,
    beforeDataHash: a.dataHash, beforeAccountState: 'active' as const, afterDataHash: b.dataHash, codeHash } satisfies MarketBoundaryEvidence };
}

/** Exact executions from physical messages and transaction-bound historical state.
 * No current getter, chart candle, selected owner, decimal default or currency peg participates. */
export function projectDlmmMarket(binding: DlmmMarketBinding, supplied: readonly MarketNode[], dependencies: MarketDependency[]): MarketProjection {
  requireProof(['mainnet', 'testnet', 'localnet'].includes(binding.network) &&
    [binding.pool, binding.tokenT, binding.tokenX].every(value => address(value) === value) && binding.tokenT !== binding.tokenX &&
    [binding.poolCodeHash, binding.walletCodeHash, binding.tokenTCodeHash, binding.tokenXCodeHash].every(value => /^[a-f0-9]{64}$/.test(value)), 'market_binding_invalid');
  const result: MarketProjection = { schema: 'dlmm-market-ledger-v1', binding, dependencies: [...dependencies].sort((a, b) => a.account.localeCompare(b.account)),
    observations: [], candidates: [], issues: [], historyComplete: false };
  const nodes: MarketNode[] = [], identities = new Set<string>(), accountLts = new Set<string>();
  for (const node of supplied) {
    try {
      requireProof(address(node.account) === node.account && positiveLt(node.raw.lt) && Number.isSafeInteger(node.raw.utime) && node.raw.utime >= 0 &&
        Array.isArray(node.raw.outMessages), 'market_transaction_identity_invalid');
      const identity = key(node), accountLt = `${node.account}:${node.raw.lt}`;
      requireProof(!identities.has(identity) && !accountLts.has(accountLt), 'market_duplicate_or_conflicting_transaction');
      identities.add(identity); accountLts.add(accountLt); nodes.push(node);
    } catch (error) { result.issues.push((error as Error).message); }
  }
  // Duplicated or conflicting physical identities invalidate the supplied graph.
  if (result.issues.length) { result.issues = [...new Set(result.issues)].sort(); return result; }
  nodes.sort((a, b) => BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : BigInt(a.raw.lt) > BigInt(b.raw.lt) ? 1 : key(a).localeCompare(key(b)));
  const outgoing = new Map<string, { node: MarketNode; index: number }[]>(), incoming = new Map<string, MarketNode[]>();
  for (const node of nodes) {
    const inKey = messageKey(node.raw.inMessage); if (inKey) incoming.set(inKey, [...incoming.get(inKey) ?? [], node]);
    node.raw.outMessages.forEach((message, index) => { const k = messageKey(message); if (k) outgoing.set(k, [...outgoing.get(k) ?? [], { node, index }]); });
  }
  const edge = (source: MarketNode, index: number) => {
    const message = source.raw.outMessages[index], k = messageKey(message), receipts = k ? incoming.get(k) ?? [] : [];
    requireProof(k && outgoing.get(k)?.length === 1 && receipts.length === 1, 'market_message_delivery_unresolved');
    const receipt = receipts[0];
    requireProof(address(message.source) === source.account && address(message.destination) === receipt.account &&
      positiveLt(message.createdLt) && BigInt(message.createdLt) >= BigInt(source.raw.lt) && BigInt(message.createdLt) < BigInt(receipt.raw.lt) &&
      source.raw.utime <= receipt.raw.utime && successful(source) && successful(receipt) && !message.bounced, 'market_message_delivery_unverified');
    return receipt;
  };
  const origin = (receipt: MarketNode) => {
    const k = messageKey(receipt.raw.inMessage), matches = k ? outgoing.get(k) ?? [] : [];
    requireProof(matches.length === 1 && edge(matches[0].node, matches[0].index) === receipt, 'market_original_message_unresolved'); return matches[0];
  };
  const pools = nodes.filter(node => node.account === binding.pool), poolCache = new Map<string, ReturnType<typeof poolBoundary>>();
  function poolBoundary(node: MarketNode) {
    const data = boundary(node, binding.poolCodeHash, readDlmmMarketState);
    for (const state of [data.before, data.after]) {
      requireProof(state.tokenT === binding.tokenT && state.tokenX === binding.tokenX && state.walletCodeHash === binding.walletCodeHash, 'market_historical_pool_identity_invalid');
      const reserved = [0n, 0n];
      for (const record of state.settlements.values()) reserved[record.tokenSide] += BigInt(record.amountRaw);
      requireProof(reserved[0] === BigInt(state.reservedT) && reserved[1] === BigInt(state.reservedX), 'market_token_reserve_conservation_failed');
    }
    requireProof(['tokenT', 'tokenX', 'treasury', 'poolKind', 'binSpacing', 'feePips', 'impactCapBps', 'governance', 'controlSeqno', 'walletCodeHash', 'provenanceHash']
      .every(field => data.before[field as keyof PoolState] === data.after[field as keyof PoolState]), 'market_configuration_changed');
    return data;
  }
  const poolAt = (node: MarketNode) => { let value = poolCache.get(key(node)); if (!value) { value = poolBoundary(node); poolCache.set(key(node), value); } return value; };
  function walletAt(node: MarketNode, root: string, owner: string, delta?: bigint) {
    if (node.before?.state.accountState === 'uninitialized') {
      const { before, after } = node;
      requireProof(delta !== undefined && delta > 0n && !before.state.codeBoc && !before.state.dataBoc &&
        uint(node.raw.prevTransactionLt) && before.state.lastTxLt === node.raw.prevTransactionLt && node.raw.prevTransactionHash && before.state.lastTxHash &&
        marketHash(node.raw.prevTransactionHash) === marketHash(before.state.lastTxHash) &&
        after?.state.accountState === 'active' && after.state.codeBoc && after.state.dataBoc && after.state.lastTxLt === node.raw.lt && after.state.lastTxHash &&
        marketHash(after.state.lastTxHash) === marketHash(node.raw.hash) && cellHash(after.state.codeBoc) === binding.walletCodeHash &&
        Number.isSafeInteger(before.seqno) && before.seqno >= 0 && Number.isSafeInteger(after.seqno) && before.seqno <= after.seqno, 'market_wallet_deployment_unverified');
      const value = readT3RecoveryWallet(after.state.dataBoc);
      requireProof(value.owner === owner && value.root === root && BigInt(value.balanceRaw) === delta &&
        perpsWalletAddress(Cell.fromBase64(after.state.codeBoc), root, owner) === node.account, 'market_initial_wallet_credit_unverified');
      // An authenticated uninitialized account has no jetton balance. This is a
      // deployment credit, explicitly distinguished from a parsed prior data cell.
      return { before: { ...value, balanceRaw: '0' }, after: value,
        evidence: { transaction: ref(node), beforeSeqno: before.seqno, afterSeqno: after.seqno, beforeDataHash: null,
          beforeAccountState: 'uninitialized' as const, afterDataHash: value.dataHash, codeHash: binding.walletCodeHash } satisfies MarketBoundaryEvidence };
    }
    const data = boundary(node, binding.walletCodeHash, readT3RecoveryWallet);
    const walletCode = Cell.fromBase64(node.after!.state.codeBoc!);
    requireProof(perpsWalletAddress(walletCode, root, owner) === node.account && [data.before, data.after].every(state => state.root === root && state.owner === owner), 'market_wallet_identity_invalid');
    if (delta !== undefined) requireProof(BigInt(data.after.balanceRaw) - BigInt(data.before.balanceRaw) === delta, 'market_wallet_balance_delta_invalid');
    return data;
  }
  function physical(debit: MarketNode, index: number, root: string, payer: string, recipientOwner: string, amount: string, typed: boolean) {
    const credit = edge(debit, index), wallets = new Map<string, LedgerAsset>([
      [debit.account, { kind: 'jetton', id: `${binding.network}:${root}`, master: root, owner: payer, wallet: debit.account }],
      [credit.account, { kind: 'jetton', id: `${binding.network}:${root}`, master: root, owner: recipientOwner, wallet: credit.account }],
    ]);
    const flow = matchPhysicalJettonFlow(debit, index, wallets, credit);
    requireProof(flow.kind === 'matched' && flow.typed === typed && flow.wire.amountRaw === amount, 'market_physical_token_flow_unverified');
    const debitState = walletAt(debit, root, payer, -BigInt(amount)), creditState = walletAt(credit, root, recipientOwner, BigInt(amount));
    return { credit, flow, debitState, creditState };
  }
  const control = (message: RawMessage | undefined, op: number, record: DlmmSettlementRecord) => {
    const value = perpsControl(message, op); return value?.queryId === record.settlementId && value.amountRaw === record.amountRaw && value.destination === record.destinationWallet;
  };
  const sameRecord = (a: DlmmSettlementRecord | undefined, b: DlmmSettlementRecord) => a &&
    ['settlementId', 'requestHash', 'businessQueryId', 'predecessorId', 'kind', 'tokenSide', 'amountRaw', 'forwardTonAmountRaw', 'sourceWallet', 'destinationOwner', 'destinationWallet']
      .every(field => a[field as keyof DlmmSettlementRecord] === b[field as keyof DlmmSettlementRecord]) && a.forwardPayload.hash().equals(b.forwardPayload.hash());
  function laneHead(state: PoolState, record: DlmmSettlementRecord) {
    const k = BigInt('0x' + beginCell().storeAddress(Address.parse(record.sourceWallet)).endCell().hash().toString('hex'));
    const queue = state.queues.get(k)?.beginParse();
    requireProof(queue && queue.remainingBits === 128 && !queue.remainingRefs && queue.loadUintBig(64).toString() === record.settlementId &&
      state.lanes.get(k)?.toString() === record.settlementId, 'market_settlement_lane_unverified');
  }
  function settle(acceptance: MarketNode, record: DlmmSettlementRecord, walletCode: Cell): MarketSettlementEvidence {
    const root = record.tokenSide === 0 ? binding.tokenT : binding.tokenX;
    requireProof(record.sourceWallet === perpsWalletAddress(walletCode, root, binding.pool) &&
      record.destinationWallet === perpsWalletAddress(walletCode, root, record.destinationOwner), 'market_settlement_wallet_identity_invalid');
    const requests = pools.flatMap(node => node.raw.outMessages.map((message, index) => ({ node, message, index })))
      .filter(({ node, message }) => BigInt(node.raw.lt) >= BigInt(acceptance.raw.lt) && tokenWire(message)?.op === TRANSFER && tokenWire(message)?.queryId === record.settlementId);
    requireProof(requests.length === 1, 'market_settlement_request_missing_or_repeated');
    const request = requests[0], wire = tokenWire(request.message)!;
    requireProof(address(request.message.destination) === record.sourceWallet && wire.amountRaw === record.amountRaw && wire.owner === record.destinationOwner &&
      wire.response === binding.pool && wire.forwardTonRaw === record.forwardTonAmountRaw && wire.forward.hash().equals(record.forwardPayload.hash()) &&
      bodyCell(request.message)?.hash().toString('hex') === record.requestHash && wire.custom?.bits.length === 32 && !wire.custom.refs.length && wire.custom.beginParse().loadUint(32) === 0x4a535454,
      'market_settlement_request_invalid');
    const requestState = poolAt(request.node), sentRecord = requestState.after.settlements.get(record.settlementId);
    requireProof(sameRecord(sentRecord, record) && sentRecord!.status === 2 && sentRecord!.fundedRaw === '40000000', 'market_settlement_send_state_unverified');
    laneHead(requestState.after, sentRecord!);
    if (request.node !== acceptance) {
      const prior = requestState.before.settlements.get(record.settlementId);
      requireProof(sameRecord(prior, record) && prior!.status === 1 && requestState.before.nextSettlementId === requestState.after.nextSettlementId, 'market_ready_dispatch_unverified');
      if (opcode(request.node.raw.inMessage) === 0x44535259) {
        requireProof(requestState.before.reservedT === requestState.after.reservedT && requestState.before.reservedX === requestState.after.reservedX, 'market_ready_retry_unverified');
      } else {
        // Qualified JSFK cleanup may automatically send the next queued head.
        const tuple = perpsControl(request.node.raw.inMessage, 0x4a53464b), previous = tuple && requestState.before.settlements.get(tuple.queryId);
        requireProof(previous && previous.sourceWallet === record.sourceWallet && previous.successorId === record.settlementId && previous.status === 3 && previous.fundedRaw === '0' &&
          control(request.node.raw.inMessage, 0x4a53464b, previous) && !requestState.after.settlements.has(previous.settlementId) &&
          BigInt(requestState.before.reservedT) - BigInt(requestState.after.reservedT) === (previous.tokenSide === 0 ? BigInt(previous.amountRaw) : 0n) &&
          BigInt(requestState.before.reservedX) - BigInt(requestState.after.reservedX) === (previous.tokenSide === 1 ? BigInt(previous.amountRaw) : 0n), 'market_queue_advance_unverified');
        laneHead(requestState.before, previous);
        const previousFinalizer = origin(request.node).node, previousWallet = walletAt(previousFinalizer, root, binding.pool, 0n);
        requireProof(previousFinalizer.account === record.sourceWallet && previousWallet.before.transfer.status === 2 && previousWallet.after.transfer.status === 0 &&
          previousWallet.after.transfer.opcode === 0 && [previousWallet.before, previousWallet.after].every(state => state.transfer.queryId === previous.settlementId &&
            state.transfer.amountRaw === previous.amountRaw && state.transfer.destination === previous.destinationWallet), 'market_queue_predecessor_finalization_unverified');
      }
    }
    const debit = edge(request.node, request.index);
    const internals = debit.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => tokenWire(message)?.op === 0x4a534954);
    requireProof(internals.length === 1, 'market_settlement_internal_unresolved');
    const transfer = physical(debit, internals[0].index, root, binding.pool, record.destinationOwner, record.amountRaw, true);
    const acknowledgements = pools.filter(node => BigInt(node.raw.lt) > BigInt(debit.raw.lt) && control(node.raw.inMessage, 0x4a535543, record) && address(node.raw.inMessage?.source) === record.sourceWallet);
    requireProof(acknowledgements.length === 1, 'market_settlement_acknowledgement_unresolved');
    const acknowledged = acknowledgements[0], ackOrigin = origin(acknowledged), recipientAck = origin(ackOrigin.node);
    requireProof(ackOrigin.node.account === record.sourceWallet && recipientAck.node === transfer.credit &&
      control(recipientAck.node.raw.outMessages[recipientAck.index], 0x4a534143, record), 'market_recipient_acknowledgement_unverified');
    const ackState = poolAt(acknowledged), beforeAck = ackState.before.settlements.get(record.settlementId), afterAck = ackState.after.settlements.get(record.settlementId);
    requireProof(sameRecord(beforeAck, record) && sameRecord(afterAck, record) && beforeAck!.status === 2 && afterAck!.status === 3 &&
      beforeAck!.fundedRaw === '40000000' && afterAck!.fundedRaw === '0' && BigInt(ackState.before.reservedNative) - BigInt(ackState.after.reservedNative) === 40000000n &&
      ackState.before.reservedT === ackState.after.reservedT && ackState.before.reservedX === ackState.after.reservedX, 'market_pool_delivery_state_unverified');
    laneHead(ackState.before, beforeAck!); laneHead(ackState.after, afterAck!);
    const finalizers = acknowledged.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => control(message, 0x4a53464e, record));
    requireProof(finalizers.length === 1 && address(finalizers[0].message.destination) === record.sourceWallet, 'market_finalize_request_unresolved');
    const walletFinalized = edge(acknowledged, finalizers[0].index), walletState = walletAt(walletFinalized, root, binding.pool, 0n);
    requireProof(walletState.before.transfer.status === 2 && walletState.after.transfer.status === 0 && walletState.after.transfer.opcode === 0 &&
      [walletState.before, walletState.after].every(state => state.transfer.queryId === record.settlementId && state.transfer.amountRaw === record.amountRaw &&
        state.transfer.destination === record.destinationWallet), 'market_wallet_finalization_unverified');
    const finals = walletFinalized.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => control(message, 0x4a53464b, record));
    requireProof(finals.length === 1, 'market_finalized_receipt_unresolved');
    const poolFinalized = edge(walletFinalized, finals[0].index);
    requireProof(poolFinalized.account === binding.pool, 'market_finalized_pool_invalid');
    const finalState = poolAt(poolFinalized), finalBefore = finalState.before.settlements.get(record.settlementId);
    requireProof(sameRecord(finalBefore, record) && finalBefore!.status === 3 && finalBefore!.fundedRaw === '0' && !finalState.after.settlements.has(record.settlementId) &&
      finalState.before.nextSettlementId === finalState.after.nextSettlementId &&
      BigInt(finalState.before.reservedT) - BigInt(finalState.after.reservedT) === (record.tokenSide === 0 ? BigInt(record.amountRaw) : 0n) &&
      BigInt(finalState.before.reservedX) - BigInt(finalState.after.reservedX) === (record.tokenSide === 1 ? BigInt(record.amountRaw) : 0n), 'market_pool_finalization_unverified');
    laneHead(finalState.before, finalBefore!);
    return { settlementId: record.settlementId, kind: record.kind === 1 ? 'swap_output' : 'unused_input_refund', amountRaw: record.amountRaw,
      sourceWallet: record.sourceWallet, destinationWallet: record.destinationWallet, destinationOwner: record.destinationOwner,
      requestBodyHash: record.requestHash, requestBodyBoc: request.message.body!, request: ref(request.node), debit: ref(debit), credit: ref(transfer.credit),
      acknowledged: ref(acknowledged), walletFinalized: ref(walletFinalized), poolFinalized: ref(poolFinalized),
      boundaries: [requestState.evidence, transfer.debitState.evidence, transfer.creditState.evidence,
        walletAt(ackOrigin.node, root, binding.pool, 0n).evidence, ackState.evidence, walletState.evidence, finalState.evidence] };
  }
  for (const acceptance of pools) {
    if (successful(acceptance) && !bodyCell(acceptance.raw.inMessage)) {
      result.issues.push('market_pool_input_undecodable');
    }
    const notice = tokenWire(acceptance.raw.inMessage);
    if ((acceptance.raw.inMessage?.op === NOTIFY || opcode(acceptance.raw.inMessage) === NOTIFY) &&
      (!notice || notice.forward.bits.length < 32)) {
      result.issues.push('market_pool_notification_undecodable');
      continue;
    }
    if (notice?.op !== NOTIFY || notice.forward.bits.length < 32 || notice.forward.beginParse().preloadUint(32) !== SWAP) continue;
    const candidateId = createHash('sha256').update(`dlmm-market-v1:${binding.network}:${key(acceptance)}`).digest('hex');
    const candidate: MarketProjection['candidates'][number] = { id: candidateId, acceptance: ref(acceptance), status: 'unresolved', issues: [], observationId: null };
    result.candidates.push(candidate);
    try {
      const forward = parseDlmmSwapForward(notice.forward);
      requireProof(successful(acceptance) && forward && notice.owner && notice.senderWallet && BigInt(notice.amountRaw) > 0n, 'market_swap_acceptance_invalid');
      const inputSide = forward.zeroForOne === 1 ? 0 : 1, inputRoot = inputSide === 0 ? binding.tokenT : binding.tokenX, outputRoot = inputSide === 0 ? binding.tokenX : binding.tokenT;
      const state = poolAt(acceptance), paymentCredit = origin(acceptance).node, paymentSource = origin(paymentCredit), payment = physical(paymentSource.node, paymentSource.index, inputRoot, notice.owner, binding.pool, notice.amountRaw, false);
      const original = origin(paymentSource.node);
      requireProof(original.node.account === notice.owner && payment.credit === paymentCredit && paymentCredit.account === address(acceptance.raw.inMessage?.source) &&
        paymentSource.node.account === notice.senderWallet && payment.flow.wire.queryId === notice.queryId && payment.flow.wire.forward.hash().equals(notice.forward.hash()), 'market_original_funding_unverified');
      const records = [...state.after.settlements.values()].filter(record => !state.before.settlements.has(record.settlementId))
        .sort((a, b) => BigInt(a.settlementId) < BigInt(b.settlementId) ? -1 : 1);
      requireProof(records.length >= 1 && records.length <= 2 && state.before.withdrawalsHash === state.after.withdrawalsHash, 'market_allocation_count_invalid');
      let next = BigInt(state.before.nextSettlementId);
      for (const record of records) {
        let attempts = 0;
        while ((next === 0n || next === forward.queryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) && attempts < 32) { next++; attempts++; }
        requireProof(attempts < 32 && next < 0xffffffffffffffffn && record.settlementId === next.toString(), 'market_allocation_sequence_invalid');
        next++;
        requireProof(record.businessQueryId === forward.queryId.toString() &&
          record.predecessorId === '0' && record.successorId === '0' && [1, 2].includes(record.status) && [1, 2].includes(record.kind) &&
          record.recordedAt === acceptance.raw.utime && record.forwardTonAmountRaw === '0' && !record.forwardPayload.bits.length && !record.forwardPayload.refs.length, 'market_allocation_record_invalid');
      }
      requireProof(next.toString() === state.after.nextSettlementId, 'market_allocation_counter_invalid');
      const outputs = records.filter(record => record.kind === 1), refunds = records.filter(record => record.kind === 2);
      requireProof(outputs.length <= 1 && refunds.length <= 1 && (!outputs.length || outputs[0].tokenSide !== inputSide && outputs[0].destinationOwner === forward.recipient) &&
        (!refunds.length || refunds[0].tokenSide === inputSide && refunds[0].destinationOwner === notice.owner) &&
        (records.length !== 2 || records[0].kind === 2 && records[1].kind === 1), 'market_allocation_roles_invalid');
      const returned = BigInt(refunds[0]?.amountRaw ?? '0'), paid = BigInt(notice.amountRaw), consumed = paid - returned;
      requireProof(returned <= paid && (outputs.length ? consumed > 0n && BigInt(outputs[0].amountRaw) >= forward.minAmountOut : returned === paid), 'market_input_conservation_failed');
      const added = [0n, 0n]; for (const record of records) added[record.tokenSide] += BigInt(record.amountRaw);
      requireProof(BigInt(state.after.reservedT) - BigInt(state.before.reservedT) === added[0] && BigInt(state.after.reservedX) - BigInt(state.before.reservedX) === added[1] &&
        [...state.before.settlements].every(([id, record]) => {
          const after = state.after.settlements.get(id);
          return after && (after.recordHash === record.recordHash || record.successorId === '0' && sameRecord(after, record) &&
            after.status === record.status && after.fundedRaw === record.fundedRaw && after.recordedAt === record.recordedAt &&
            records.some(added => added.settlementId === after.successorId && added.sourceWallet === record.sourceWallet));
        }), 'market_allocation_reserve_delta_invalid');
      const settlements = records.map(record => settle(acceptance, record, state.after.walletCode));
      if (!outputs.length) {
        requireProof(state.before.binsHash === state.after.binsHash && state.before.observationsHash === state.after.observationsHash, 'market_refunded_price_state_changed');
        candidate.status = 'refunded'; continue;
      }
      const output = BigInt(outputs[0].amountRaw), divisor = gcd(output, consumed);
      const evidenceRefs = new Map<string, LedgerEvidenceRef>();
      for (const transaction of [ref(original.node), ref(paymentSource.node), ref(paymentCredit), ref(acceptance), ...settlements.flatMap(value =>
        [value.request, value.debit, value.credit, value.acknowledged, value.walletFinalized, value.poolFinalized, ...value.boundaries.map(boundary => boundary.transaction)])])
        evidenceRefs.set(`${transaction.account}:${transaction.lt}:${transaction.hash}`, transaction);
      const observation: MarketObservation = { id: candidateId, network: binding.network, pool: binding.pool, kind: 'settled_dlmm_execution', acceptance: ref(acceptance),
        executionUtime: acceptance.raw.utime, deliveredUtime: Math.max(...settlements.map(value => value.credit.utime)), finalizedUtime: Math.max(...settlements.map(value => value.poolFinalized.utime)),
        payer: notice.owner, recipient: forward.recipient, businessQueryId: forward.queryId.toString(), inputAsset: `${binding.network}:jetton:${inputRoot}`, outputAsset: `${binding.network}:jetton:${outputRoot}`,
        assetPrecision: acceptance.assetPrecision ?? {input: resolveHistoricalJettonPrecision({network:binding.network,root:inputRoot,rootCodeHash:inputSide===0?binding.tokenTCodeHash:binding.tokenXCodeHash,walletCodeHash:binding.walletCodeHash},ref(acceptance),null),output: resolveHistoricalJettonPrecision({network:binding.network,root:outputRoot,rootCodeHash:inputSide===0?binding.tokenXCodeHash:binding.tokenTCodeHash,walletCodeHash:binding.walletCodeHash},ref(acceptance),null)},
        paidInputRaw: paid.toString(), returnedInputRaw: returned.toString(), consumedInputRaw: consumed.toString(), outputRaw: output.toString(),
        ratio: { numerator: (output / divisor).toString(), denominator: (consumed / divisor).toString(), unit: 'output_atomic_per_input_atomic', includesTradingFees: true },
        input: { request: ref(original.node), debit: ref(paymentSource.node), credit: ref(paymentCredit), boundaries: [payment.debitState.evidence, payment.creditState.evidence] },
        allocation: state.evidence, settlements,
        fees: [...evidenceRefs.values()].map(transaction => ({ transaction, nativeAmountRaw: nodes.find(node => key(node) === `${transaction.account}:${transaction.lt}:${transaction.hash}`)?.raw.totalFeesRaw ?? null })) };
      result.observations.push(observation); candidate.status = 'settled'; candidate.observationId = observation.id;
    } catch (error) { candidate.issues.push(error instanceof Error ? error.message : 'market_evidence_unavailable'); }
  }
  const covered = new Set(dependencies.filter(dependency => dependency.historyComplete && positiveLt(dependency.headLt) &&
    /^[a-f0-9]{64}$/.test(dependency.headHash) && Number.isFinite(Date.parse(dependency.checkedThrough)) && nodes.filter(node => node.account === dependency.account).every(node =>
      BigInt(node.raw.lt) <= BigInt(dependency.headLt) && (node.raw.lt !== dependency.headLt || marketHash(node.raw.hash) === dependency.headHash) &&
      node.raw.utime * 1000 <= Date.parse(dependency.checkedThrough))).map(dependency => dependency.account));
  result.historyComplete = !result.issues.length && nodes.length > 0 && covered.has(binding.pool) && nodes.every(node => covered.has(node.account)) && result.candidates.every(candidate => candidate.status !== 'unresolved');
  if (!result.historyComplete) result.issues.push('market_history_or_settlement_incomplete');
  result.issues = [...new Set(result.issues)].sort();
  return result;
}
