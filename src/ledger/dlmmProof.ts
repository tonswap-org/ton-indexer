import { Address, Cell, beginCell } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { readDlmmMarketState, type DlmmSettlementRecord } from './dlmmState';
import { matchPhysicalJettonFlow } from './jettonFlow';
import { perpsControl, perpsWalletAddress } from './perpsWire';
import { readT3RecoveryWallet } from './t3RecoveryState';
import { bodyCell, messageKey, opcode, tokenWire, TRANSFER, uint, withdrawalReceipt } from './wire';
import type { LedgerAsset, LedgerEvidenceRef } from './types';
import type { DlmmMarketBinding, MarketBoundaryEvidence, MarketNode } from './marketTypes';

export type DlmmDeliveryEvidence = {
  settlementId: string; kind: number;
  amountRaw: string; sourceWallet: string; destinationWallet: string; destinationOwner: string;
  requestBodyHash: string; requestBodyBoc: string;
  request: LedgerEvidenceRef; debit: LedgerEvidenceRef; credit: LedgerEvidenceRef;
  boundaries: MarketBoundaryEvidence[];
};
export type DlmmSettlementEvidence = DlmmDeliveryEvidence & {
  acknowledged: LedgerEvidenceRef; walletFinalized: LedgerEvidenceRef; poolFinalized: LedgerEvidenceRef;
};
export type DlmmProofBinding = Pick<DlmmMarketBinding, 'network' | 'pool' | 'poolCodeHash' | 'walletCodeHash' | 'tokenT' | 'tokenX'>;
const requireProof: (value: unknown, issue: string) => asserts value = (value, issue) => { if (!value) throw new Error(issue); };
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
const successful = (node: MarketNode) => node.raw.success && (!node.raw.status || node.raw.status === 'success') && !node.raw.inMessage?.bounced;
const marketHash = (value: string) => Buffer.from(canonicalLedgerHash(value), 'base64').toString('hex');
const ref = (node: MarketNode): LedgerEvidenceRef => ({ account: node.account, lt: node.raw.lt, hash: marketHash(node.raw.hash), utime: node.raw.utime });
const key = (node: MarketNode) => `${node.account}:${node.raw.lt}:${marketHash(node.raw.hash)}`;
const cellHash = (boc: string) => Cell.fromBase64(boc).hash().toString('hex');
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

/** One qualified message/state verifier for current DLMM typed payouts.
 * Successful requests, pool acknowledgements and wallet credits remain distinct;
 * all identities, exact states, queue reserves and finalizers must agree. */
export function createDlmmProofGraph(binding: DlmmProofBinding, supplied: readonly MarketNode[]) {
  requireProof(['mainnet', 'testnet', 'localnet'].includes(binding.network) &&
    [binding.pool, binding.tokenT, binding.tokenX].every(value => address(value) === value) && binding.tokenT !== binding.tokenX &&
    [binding.poolCodeHash, binding.walletCodeHash].every(value => /^[a-f0-9]{64}$/.test(value)), 'market_binding_invalid');
  const nodes: MarketNode[] = [], identities = new Set<string>(), accountLts = new Set<string>();
  for (const node of supplied) {
      requireProof(address(node.account) === node.account && positiveLt(node.raw.lt) && Number.isSafeInteger(node.raw.utime) && node.raw.utime >= 0 &&
        Array.isArray(node.raw.outMessages), 'market_transaction_identity_invalid');
      const identity = key(node), accountLt = `${node.account}:${node.raw.lt}`;
      requireProof(!identities.has(identity) && !accountLts.has(accountLt), 'market_duplicate_or_conflicting_transaction');
      identities.add(identity); accountLts.add(accountLt); nodes.push(node);
  }
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
      const poolWallets = [binding.tokenT, binding.tokenX].map(root => perpsWalletAddress(state.walletCode, root, binding.pool));
      for (const receipt of state.directSwaps.receipts.values()) {
        const receiptKey = beginCell().storeUint(0x444c5246, 32).storeAddress(Address.parse(binding.pool))
          .storeAddress(Address.parse(receipt.notificationSender)).storeUint(BigInt(receipt.notificationCreatedLt), 64)
          .storeUint(BigInt('0x' + receipt.notificationBodyHash), 256).endCell().hash().toString('hex');
        requireProof(receipt.key === receiptKey && poolWallets.includes(receipt.notificationSender), 'market_direct_swap_receipt_identity_invalid');
        for (const [leg, side] of [[receipt.refund, poolWallets.indexOf(receipt.notificationSender)], [receipt.output, 1 - poolWallets.indexOf(receipt.notificationSender)]] as const) {
          for (const wire of leg.wires.values()) requireProof(wire.response === binding.pool, 'market_direct_swap_receipt_response_invalid');
          if (!leg.done) requireProof(state.settlements.get(leg.currentId)?.sourceWallet === poolWallets[side], 'market_direct_swap_receipt_root_invalid');
        }
      }
    }
    requireProof(['tokenT', 'tokenX', 'treasury', 'router', 'stableAmp', 'poolKind', 'binSpacing', 'feePips', 'impactCapBps', 'governance', 'controlSeqno', 'walletCodeHash']
      .every(field => data.before[field as keyof PoolState] === data.after[field as keyof PoolState]), 'market_configuration_changed');
    requireProof(data.before.provenanceHash === data.after.provenanceHash ||
      data.before.storageForm === 'constructor' && data.before.provenanceHash === null && data.after.storageForm === 'persisted' && data.after.provenanceIsDefault,
      'market_provenance_changed');
    return data;
  }
  const poolAt = (node: MarketNode) => { let value = poolCache.get(key(node)); if (!value) { value = poolBoundary(node); poolCache.set(key(node), value); } return value; };
  function walletAt(node: MarketNode, root: string, owner: string, delta?: bigint) {
    if (node.before?.state.accountState === 'uninitialized') {
      const { before, after } = node;
      requireProof(delta !== undefined && (delta > 0n || delta === 0n && !node.raw.success) && !before.state.codeBoc && !before.state.dataBoc &&
        uint(node.raw.prevTransactionLt) && before.state.lastTxLt === node.raw.prevTransactionLt && node.raw.prevTransactionHash && before.state.lastTxHash &&
        marketHash(node.raw.prevTransactionHash) === marketHash(before.state.lastTxHash) &&
        after?.state.accountState === 'active' && after.state.codeBoc && after.state.dataBoc && after.state.lastTxLt === node.raw.lt && after.state.lastTxHash &&
        marketHash(after.state.lastTxHash) === marketHash(node.raw.hash) && cellHash(after.state.codeBoc) === binding.walletCodeHash &&
        Number.isSafeInteger(before.seqno) && before.seqno >= 0 && Number.isSafeInteger(after.seqno) && before.seqno <= after.seqno, 'market_wallet_deployment_unverified');
      const value = readT3RecoveryWallet(after.state.dataBoc);
      requireProof(value.owner === owner && value.root === root && BigInt(value.balanceRaw) === delta &&
        perpsWalletAddress(Cell.fromBase64(after.state.codeBoc), root, owner) === node.account, 'market_initial_wallet_credit_unverified');
      // An authenticated uninitialized account has no jetton balance. This is a
      // deployment credit, or a failed first delivery with exactly zero credit,
      // explicitly distinguished from a parsed prior data cell.
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
  function readyRotation(node: MarketNode, fresh: DlmmSettlementRecord) {
    const state = poolAt(node), prior = state.before.settlements.get(fresh.predecessorId);
    requireProof(successful(node) && prior && prior.status === 1 && !state.after.settlements.has(prior.settlementId) &&
      !state.before.settlements.has(fresh.settlementId) && fresh.status === 2 && fresh.fundedRaw === '40000000' &&
      fresh.recordedAt === node.raw.utime && fresh.successorId === prior.successorId &&
      BigInt(prior.settlementId) < BigInt(state.before.nextSettlementId) - 1n,
      'market_ready_rotation_state_invalid');
    let forward = prior.forwardPayload;
    if (prior.kind === 3) {
      const s = forward.beginParse(), prefix = s.loadBits(352); s.skip(64);
      forward = beginCell().storeBits(prefix).storeUint(BigInt(prior.settlementId), 64).storeSlice(s).endCell();
    }
    requireProof(sameRecord({...fresh, settlementId: prior.settlementId, requestHash: prior.requestHash,
      predecessorId: prior.predecessorId, forwardPayload: prior.forwardPayload}, prior) && fresh.forwardPayload.hash().equals(forward.hash()),
      'market_ready_rotation_identity_invalid');
    let next = BigInt(state.before.nextSettlementId), attempts = 0;
    while ((next.toString() === prior.businessQueryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) && attempts++ < 32) next++;
    requireProof(attempts < 32 && fresh.settlementId === next.toString() && state.after.nextSettlementId === (next + 1n).toString(), 'market_ready_rotation_sequence_invalid');
    const root = prior.tokenSide === 0 ? binding.tokenT : binding.tokenX;
    let previous: DlmmSettlementRecord | undefined;
    if (opcode(node.raw.inMessage) === 0x44535259) {
      const request = bodyCell(node.raw.inMessage)!.beginParse();
      requireProof(request.remainingBits === 96 && request.remainingRefs === 0, 'market_ready_rotation_retry_invalid');
      request.skip(32); requireProof(request.loadUintBig(64).toString() === prior.settlementId, 'market_ready_rotation_retry_invalid');
      const required = (prior.forwardTonAmountRaw !== '0' || prior.forwardPayload.bits.length || prior.forwardPayload.refs.length ? 160000000n : 140000000n) + BigInt(prior.forwardTonAmountRaw) + 40000000n;
      requireProof(BigInt(node.raw.inMessage!.value ?? '0') >= required - BigInt(prior.fundedRaw) + 20000000n, 'market_ready_rotation_funding_invalid');
    } else {
      const tuple = perpsControl(node.raw.inMessage, 0x4a53464b);
      previous = tuple ? state.before.settlements.get(tuple.queryId) : undefined;
      requireProof(previous && previous.sourceWallet === prior.sourceWallet && previous.successorId === prior.settlementId &&
        previous.status === 3 && previous.fundedRaw === '0' && control(node.raw.inMessage, 0x4a53464b, previous) &&
        address(node.raw.inMessage?.source) === previous.sourceWallet && !state.after.settlements.has(previous.settlementId), 'market_ready_rotation_trigger_invalid');
      laneHead(state.before, previous);
      const finalizer = origin(node).node, wallet = walletAt(finalizer, root, binding.pool, 0n);
      requireProof(finalizer.account === previous.sourceWallet && wallet.before.transfer.status === 2 && wallet.after.transfer.status === 0 &&
        [wallet.before, wallet.after].every(s => s.transfer.queryId === previous!.settlementId && s.transfer.amountRaw === previous!.amountRaw && s.transfer.destination === previous!.destinationWallet),
        'market_ready_rotation_predecessor_finality_invalid');
    }
    requireProof([...state.after.settlements].filter(([id]) => !state.before.settlements.has(id)).length === 1 &&
      [...state.before.settlements].every(([id, value]) => id === prior.settlementId || id === previous?.settlementId || state.after.settlements.get(id)?.recordHash === value.recordHash),
      'market_ready_rotation_other_records_changed');
    requireProof(BigInt(state.before.reservedT) - BigInt(state.after.reservedT) === (previous?.tokenSide === 0 ? BigInt(previous.amountRaw) : 0n) &&
      BigInt(state.before.reservedX) - BigInt(state.after.reservedX) === (previous?.tokenSide === 1 ? BigInt(previous.amountRaw) : 0n), 'market_ready_rotation_token_reserve_invalid');
    const completions = node.raw.outMessages.filter(message => withdrawalReceipt(message));
    requireProof(completions.length <= 1 && completions.every(message => message.value === '50000000') &&
      BigInt(state.after.reservedNative) - BigInt(state.before.reservedNative) === BigInt(fresh.fundedRaw) - BigInt(prior.fundedRaw) - BigInt(completions.length) * 50000000n,
      'market_ready_rotation_native_reserve_invalid');
    laneHead(state.after, fresh);
    return {prior, state, evidence: [state.evidence]};
  }
  function negativeReplacement(node: MarketNode, fresh: DlmmSettlementRecord) {
    const state = poolAt(node), prior = state.before.settlements.get(fresh.predecessorId);
    requireProof(successful(node) && prior && prior.status === 4 && prior.fundedRaw === '0' &&
      !state.after.settlements.has(prior.settlementId) && fresh.status === 1 && fresh.fundedRaw === '0' && fresh.successorId === '0' &&
      fresh.recordedAt === node.raw.utime && control(node.raw.inMessage, 0x4a53464b, prior) && address(node.raw.inMessage?.source) === prior.sourceWallet,
      'market_negative_replacement_state_invalid');
    let forward = prior.forwardPayload;
    if (prior.kind === 3) {const s = forward.beginParse(), prefix = s.loadBits(352); s.skip(64); forward = beginCell().storeBits(prefix).storeUint(BigInt(prior.settlementId), 64).storeSlice(s).endCell();}
    requireProof(sameRecord({...fresh, settlementId: prior.settlementId, requestHash: prior.requestHash, predecessorId: prior.predecessorId, forwardPayload: prior.forwardPayload}, prior) &&
      fresh.forwardPayload.hash().equals(forward.hash()), 'market_negative_replacement_identity_invalid');
    let next = BigInt(state.before.nextSettlementId), attempts = 0;
    while ((next.toString() === prior.businessQueryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) && attempts++ < 32) next++;
    requireProof(attempts < 32 && fresh.settlementId === next.toString() && state.after.nextSettlementId === (next + 1n).toString() &&
      [...state.after.settlements].filter(([id]) => !state.before.settlements.has(id)).length === 1,
      'market_negative_replacement_sequence_invalid');
    requireProof(state.before.reservedT === state.after.reservedT && state.before.reservedX === state.after.reservedX &&
      state.before.reservedNative === state.after.reservedNative &&
      [...state.before.settlements].every(([id, value]) => id === prior.settlementId || state.after.settlements.get(id)?.recordHash === value.recordHash),
      'market_negative_replacement_reserve_invalid');
    laneHead(state.before, prior);
    const root = prior.tokenSide === 0 ? binding.tokenT : binding.tokenX, finalizer = origin(node).node, wallet = walletAt(finalizer, root, binding.pool, 0n);
    requireProof(finalizer.account === prior.sourceWallet && wallet.before.transfer.status === 3 && wallet.after.transfer.status === 0 && wallet.after.transfer.opcode === 0 &&
      [wallet.before, wallet.after].every(s => s.transfer.queryId === prior.settlementId && s.transfer.amountRaw === prior.amountRaw && s.transfer.destination === prior.destinationWallet),
      'market_negative_wallet_finality_invalid');
    const finalizeOrigin = origin(finalizer), acknowledged = finalizeOrigin.node, ack = poolAt(acknowledged), sent = ack.before.settlements.get(prior.settlementId), failed = ack.after.settlements.get(prior.settlementId);
    requireProof(acknowledged.account === binding.pool && control(acknowledged.raw.outMessages[finalizeOrigin.index], 0x4a53464e, prior) &&
      control(acknowledged.raw.inMessage, 0x4a544246, prior) && address(acknowledged.raw.inMessage?.source) === prior.sourceWallet &&
      sameRecord(sent, prior) && sent!.status === 2 && sent!.fundedRaw === '40000000' && sameRecord(failed, prior) && failed!.status === 4 && failed!.fundedRaw === '0' &&
      ack.before.reservedT === ack.after.reservedT && ack.before.reservedX === ack.after.reservedX &&
      BigInt(ack.before.reservedNative) - BigInt(ack.after.reservedNative) === 40000000n,
      'market_negative_acknowledgement_invalid');
    laneHead(ack.before, sent!); laneHead(ack.after, failed!);
    const link = (receipt: MarketNode) => {
      const k = messageKey(receipt.raw.inMessage), matches = k ? outgoing.get(k) ?? [] : [];
      requireProof(k && matches.length === 1 && incoming.get(k)?.length === 1, 'market_negative_message_unresolved');
      const match = matches[0], message = match.node.raw.outMessages[match.index];
      requireProof(address(message.source) === match.node.account && address(message.destination) === receipt.account && positiveLt(message.createdLt) &&
        BigInt(message.createdLt) >= BigInt(match.node.raw.lt) && BigInt(message.createdLt) < BigInt(receipt.raw.lt) && match.node.raw.utime <= receipt.raw.utime,
        'market_negative_message_identity_invalid');
      return {...match, message};
    };
    const restoreOrigin = link(acknowledged), restored = restoreOrigin.node, restoredState = walletAt(restored, root, binding.pool, BigInt(prior.amountRaw));
    requireProof(restored.account === prior.sourceWallet && restored.raw.success && restored.raw.inMessage?.bounced &&
      restoredState.before.transfer.status === 1 && restoredState.after.transfer.status === 3 &&
      [restoredState.before, restoredState.after].every(s => s.transfer.queryId === prior.settlementId && s.transfer.amountRaw === prior.amountRaw && s.transfer.destination === prior.destinationWallet),
      'market_negative_restore_invalid');
    const bounce = link(restored), rejected = bounce.node;
    requireProof(!rejected.raw.success && rejected.account === prior.destinationWallet && bounce.message.bounced === true && rejected.raw.inMessage?.bounced !== true,
      'market_negative_recipient_failure_invalid');
    const failedWallet = walletAt(rejected, root, prior.destinationOwner, 0n);
    const sentInternal = link(rejected), debit = sentInternal.node, wire = tokenWire(sentInternal.message), debitState = walletAt(debit, root, binding.pool, -BigInt(prior.amountRaw));
    requireProof(successful(debit) && debit.account === prior.sourceWallet && wire?.op === 0x4a534954 && wire.queryId === prior.settlementId && wire.amountRaw === prior.amountRaw &&
      wire.owner === binding.pool && wire.forward.hash().equals(prior.forwardPayload.hash()) && debitState.before.transfer.status === 0 && debitState.after.transfer.status === 1 &&
      debitState.after.transfer.queryId === prior.settlementId && debitState.after.transfer.amountRaw === prior.amountRaw && debitState.after.transfer.destination === prior.destinationWallet,
      'market_negative_original_debit_invalid');
    const bounceBody = bodyCell(restored.raw.inMessage)?.beginParse(), internalBody = bodyCell(sentInternal.message)!;
    requireProof(bounceBody && bounceBody.loadUint(32) === 0xffffffff && bounceBody.remainingBits > 96 && !bounceBody.remainingRefs &&
      bounceBody.loadBits(bounceBody.remainingBits).equals(internalBody.beginParse().loadBits(Math.min(256, internalBody.bits.length))), 'market_negative_bounce_body_invalid');
    const request = origin(debit), requestWire = tokenWire(request.node.raw.outMessages[request.index]);
    const requestMessage = request.node.raw.outMessages[request.index], requestState = poolAt(request.node);
    requireProof(request.node.account === binding.pool && bodyCell(requestMessage)?.hash().toString('hex') === prior.requestHash && requestWire?.op === TRANSFER &&
      requestWire.queryId === prior.settlementId && sameRecord(requestState.after.settlements.get(prior.settlementId), prior), 'market_negative_original_request_invalid');
    return {prior, state, evidence: [requestState.evidence, debitState.evidence, failedWallet.evidence, restoredState.evidence, ack.evidence, wallet.evidence, state.evidence]};
  }
  let rotationCandidates: Map<string, {node: MarketNode; child: DlmmSettlementRecord}[]> | undefined;
  const rotationsAfter = (settlementId: string, acceptance: MarketNode) => {
    if (!rotationCandidates) {
      rotationCandidates = new Map();
      for (const node of pools) {
        if (!node.after?.state.dataBoc) continue;
        let after: PoolState, before: PoolState; try {after = readDlmmMarketState(node.after.state.dataBoc); before = readDlmmMarketState(node.before!.state.dataBoc!);} catch {continue;}
        for (const child of after.settlements.values()) {
          if (child.predecessorId === '0' || ![1, 2].includes(child.status) || before.settlements.has(child.settlementId) || !before.settlements.has(child.predecessorId)) continue;
          rotationCandidates.set(child.predecessorId, [...rotationCandidates.get(child.predecessorId) ?? [], {node, child}]);
        }
      }
    }
    // Cached cells only locate candidates. Every selected transition still
    // passes the complete historical state and message qualification above.
    return (rotationCandidates.get(settlementId) ?? []).filter(({node}) => BigInt(node.raw.lt) >= BigInt(acceptance.raw.lt));
  };
  function deliver(acceptance: MarketNode, record: DlmmSettlementRecord, walletCode: Cell) {
    const rotations: MarketBoundaryEvidence[] = [];
    for (let round = 0; round < 32; round++) {
      const candidates = rotationsAfter(record.settlementId, acceptance);
      requireProof(candidates.length <= 1, 'market_ready_rotation_ambiguous');
      if (!candidates.length) break;
      const {node, child} = candidates[0], rotated = child.status === 1 ? negativeReplacement(node, child) : readyRotation(node, child);
      requireProof(sameRecord(rotated.prior, record), 'market_ready_rotation_original_invalid');
      rotations.push(...rotated.evidence); record = child;
      requireProof(round < 31, 'market_ready_rotation_limit');
    }
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
    if (request.node !== acceptance && !rotations.some(r => r.transaction.hash === ref(request.node).hash)) {
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
    const evidence: DlmmDeliveryEvidence = {settlementId: record.settlementId, kind: record.kind, amountRaw: record.amountRaw,
      sourceWallet: record.sourceWallet, destinationWallet: record.destinationWallet, destinationOwner: record.destinationOwner,
      requestBodyHash: record.requestHash, requestBodyBoc: request.message.body!, request: ref(request.node), debit: ref(debit), credit: ref(transfer.credit),
      boundaries: [...rotations, requestState.evidence, transfer.debitState.evidence, transfer.creditState.evidence]};
    return {root, debit, transfer, evidence, record};
  }
  function settle(acceptance: MarketNode, record: DlmmSettlementRecord, walletCode: Cell, delivery = deliver(acceptance, record, walletCode)): DlmmSettlementEvidence {
    record = delivery.record;
    const {root, debit, transfer, evidence} = delivery;
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
    if (finalState.before.nextSettlementId !== finalState.after.nextSettlementId) {
      const created = [...finalState.after.settlements.values()].filter(value => !finalState.before.settlements.has(value.settlementId));
      requireProof(created.length === 1, 'market_finalization_rotation_count_invalid'); readyRotation(poolFinalized, created[0]);
    }
    requireProof(sameRecord(finalBefore, record) && finalBefore!.status === 3 && finalBefore!.fundedRaw === '0' && !finalState.after.settlements.has(record.settlementId) &&
      BigInt(finalState.before.reservedT) - BigInt(finalState.after.reservedT) === (record.tokenSide === 0 ? BigInt(record.amountRaw) : 0n) &&
      BigInt(finalState.before.reservedX) - BigInt(finalState.after.reservedX) === (record.tokenSide === 1 ? BigInt(record.amountRaw) : 0n), 'market_pool_finalization_unverified');
    laneHead(finalState.before, finalBefore!);
    return { ...evidence, acknowledged: ref(acknowledged), walletFinalized: ref(walletFinalized), poolFinalized: ref(poolFinalized),
      boundaries: [...evidence.boundaries,
        walletAt(ackOrigin.node, root, binding.pool, 0n).evidence, ackState.evidence, walletState.evidence, finalState.evidence] };
  }
  return { nodes, pools, edge, origin, poolAt, walletAt, physical, deliver, settle, sameRecord };
}
export { requireProof, address, successful, marketHash, ref, key, cellHash, positiveLt, boundary };
