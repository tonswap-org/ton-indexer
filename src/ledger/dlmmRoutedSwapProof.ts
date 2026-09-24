import { Address, beginCell, Cell } from '@ton/core';
import { readDlmmLiquidityState } from './dlmmLiquidityState';
import { readDlmmRouterState } from './dlmmRouterState';
import { perpsControl, perpsWalletAddress } from './perpsWire';
import { bodyCell, NOTIFY, opcode, tokenWire, TRANSFER } from './wire';
import { boundary, createDlmmProofGraph, requireProof, address, successful, ref, key } from './dlmmProof';
import { readDlmmRoutedIntent, readDlmmRouterExecute, readDlmmRouterCompletion, readDlmmRouterCompletionAck, ROUTER_POOL_COMPLETED, ROUTER_POOL_COMPLETION_ACK } from './dlmmRoutedWire';
import type { DlmmMarketBinding, MarketNode, MarketRoutingEvidence, MarketSettlementEvidence, RouterSettlementEvidence } from './marketTypes';
const hash = (cell: Cell) => cell.hash().toString('hex');
const one = <T>(values: T[], issue: string): T => { requireProof(values.length === 1, issue); return values[0]; };
/** A routed execution has four independent custody legs: payer -> router,
 * router -> pool, pool -> router and router -> beneficiary. Every intermediate
 * finalizer and both contract journals are qualified against historical state. */
export function verifyDlmmRoutedSwapExecution(binding: DlmmMarketBinding, proof: ReturnType<typeof createDlmmProofGraph>, acceptance: MarketNode) {
    requireProof(binding.router && binding.routerCodeHash, 'market_router_binding_missing');
    const router = binding.router, routerCodeHash = binding.routerCodeHash;
    const { nodes, poolAt, origin, edge, physical, walletAt, settle } = proof;
    const requestCell = bodyCell(acceptance.raw.inMessage);
    requireProof(requestCell && successful(acceptance) && address(acceptance.raw.inMessage?.source) === router, 'market_routed_acceptance_invalid');
    const execute = readDlmmRouterExecute(requestCell), forward = execute.swap, state = poolAt(acceptance);
    requireProof(state.before.router === router && state.after.router === router, 'market_historical_router_identity_invalid');
    const inputSide = forward.zeroForOne === 1 ? 0 : 1, inputRoot = inputSide === 0 ? binding.tokenT : binding.tokenX, outputRoot = inputSide === 0 ? binding.tokenX : binding.tokenT;
    const walletCode = state.after.walletCode;
    requireProof(execute.inputWallet === perpsWalletAddress(walletCode, inputRoot, binding.pool) &&
        execute.routerInputWallet === perpsWalletAddress(walletCode, inputRoot, router) && execute.outputWallet === perpsWalletAddress(walletCode, outputRoot, router) &&
        forward.recipient === execute.outputWallet, 'market_routed_wallet_identity_invalid');
    const routerCache = new Map<string, ReturnType<typeof routerBoundary>>();
    function routerBoundary(node: MarketNode) {
        requireProof(node.account === router && successful(node), 'market_router_transaction_invalid');
        const value = boundary(node, routerCodeHash, readDlmmRouterState);
        requireProof(value.before.walletCodeHash === binding.walletCodeHash && value.after.walletCodeHash === binding.walletCodeHash, 'market_router_wallet_code_invalid');
        for (const state of [value.before, value.after])
            requireProof([...state.settlements.values()].filter(r => ![4, 5].includes(r.status)).reduce((n, r) => n + BigInt(r.amountRaw), 0n) === BigInt(state.reservedTokens), 'market_router_token_reserve_invalid');
        requireProof(['governance', 'enabled', 'withdrawalsOnly', 'riskController', 'riskSourceId', 'moduleKey'].every(k => value.before[k as keyof typeof value.before] === value.after[k as keyof typeof value.after]) && value.before.referralConfig.hash().equals(value.after.referralConfig.hash()), 'market_router_configuration_changed');
        return value;
    }
    const routerAt = (node: MarketNode) => { let value = routerCache.get(key(node)); if (!value) {
        value = routerBoundary(node);
        routerCache.set(key(node), value);
    } return value; };
    type Record = ReturnType<typeof readDlmmRouterState>['settlements'] extends Map<string, infer R> ? R : never;
    const sameRecord = (a: Record | undefined, b: Record) => a &&
        ['settlementId', 'requestHash', 'groupKey', 'amountRaw', 'kind', 'legIndex', 'sourceWallet', 'destinationOwner', 'destinationWallet', 'forwardTonAmountRaw']
            .every(field => a[field as keyof Record] === b[field as keyof Record]) && a.forwardPayload.hash().equals(b.forwardPayload.hash());
    const control = (node: MarketNode, op: number, record: Record) => { const v = perpsControl(node.raw.inMessage, op); return v?.queryId === record.settlementId && v.amountRaw === record.amountRaw && v.destination === record.destinationWallet; };
    const routerNodes = nodes.filter(node => node.account === router);
    function routerSettle(record: Record, root: string, request: MarketNode): RouterSettlementEvidence {
        const sent = routerAt(request), sentRecord = sent.after.settlements.get(record.settlementId);
        requireProof(sameRecord(sentRecord, record) && sentRecord!.status === 2 && sentRecord!.fundedRaw === '0' && sentRecord!.finalizeFundedRaw === '220000000', 'market_router_dispatch_state_invalid');
        requireProof(record.sourceWallet === perpsWalletAddress(walletCode, root, router) && record.destinationWallet === perpsWalletAddress(walletCode, root, record.destinationOwner), 'market_router_settlement_wallet_invalid');
        const outbound = one(request.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => tokenWire(message)?.op === TRANSFER && tokenWire(message)?.queryId === record.settlementId), 'market_router_transfer_missing_or_repeated');
        const wire = tokenWire(outbound.message)!;
        requireProof(bodyCell(outbound.message)?.hash().toString('hex') === record.requestHash && address(outbound.message.destination) === record.sourceWallet &&
            wire.amountRaw === record.amountRaw && wire.owner === record.destinationOwner && wire.response === router && wire.forwardTonRaw === record.forwardTonAmountRaw && wire.forward.hash().equals(record.forwardPayload.hash()) &&
            wire.custom?.bits.length === 32 && !wire.custom.refs.length && wire.custom.beginParse().loadUint(32) === 0x4a535454, 'market_router_transfer_invalid');
        const debit = edge(request, outbound.index), internal = one(debit.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => tokenWire(message)?.op === 0x4a534954), 'market_router_internal_missing');
        const cash = physical(debit, internal.index, root, router, record.destinationOwner, record.amountRaw, true);
        const matchesTransfer = (t: typeof cash.debitState.after.transfer) => t.queryId === record.settlementId && t.amountRaw === record.amountRaw && t.destination === record.destinationWallet;
        requireProof(cash.debitState.before.transfer.status === 0 && cash.debitState.after.transfer.status === 1 && matchesTransfer(cash.debitState.after.transfer), 'market_router_wallet_dispatch_invalid');
        requireProof(sent.after.sourceLanes.get(record.sourceWallet) === record.settlementId && sent.after.sourceQueues.get(record.sourceWallet)?.head === record.settlementId, 'market_router_dispatch_lane_invalid');
        const acknowledged = one(routerNodes.filter(node => BigInt(node.raw.lt) > BigInt(debit.raw.lt) && control(node, 0x4a535543, record) && address(node.raw.inMessage?.source) === record.sourceWallet), 'market_router_ack_missing_or_repeated');
        const ackOrigin = origin(acknowledged), recipientAck = origin(ackOrigin.node);
        const ackTuple = perpsControl(recipientAck.node.raw.outMessages[recipientAck.index], 0x4a534143);
        requireProof(ackOrigin.node.account === record.sourceWallet && recipientAck.node === cash.credit && ackTuple?.queryId === record.settlementId && ackTuple.amountRaw === record.amountRaw && ackTuple.destination === record.destinationWallet, 'market_router_recipient_ack_invalid');
        const walletAck = walletAt(ackOrigin.node, root, router, 0n);
        requireProof(walletAck.before.transfer.status === 1 && walletAck.after.transfer.status === 2 && matchesTransfer(walletAck.before.transfer) && matchesTransfer(walletAck.after.transfer), 'market_router_wallet_ack_invalid');
        const ack = routerAt(acknowledged), beforeAck = ack.before.settlements.get(record.settlementId), afterAck = ack.after.settlements.get(record.settlementId);
        requireProof(sameRecord(beforeAck, record) && sameRecord(afterAck, record) && beforeAck!.status === 2 && afterAck!.status === 3 && beforeAck!.finalizeFundedRaw === '220000000' && afterAck!.finalizeFundedRaw === '0' &&
            BigInt(ack.before.reservedNative) - BigInt(ack.after.reservedNative) === 220000000n && ack.before.reservedTokens === ack.after.reservedTokens, 'market_router_delivery_state_invalid');
        requireProof([ack.before, ack.after].every(s => s.sourceLanes.get(record.sourceWallet) === record.settlementId && s.sourceQueues.get(record.sourceWallet)?.head === record.settlementId), 'market_router_delivery_lane_invalid');
        const finalize = one(acknowledged.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => { const v = perpsControl(message, 0x4a53464e); return v?.queryId === record.settlementId && v.amountRaw === record.amountRaw && v.destination === record.destinationWallet; }), 'market_router_finalize_missing');
        requireProof(address(finalize.message.destination) === record.sourceWallet, 'market_router_finalize_wallet_invalid');
        const walletFinalized = edge(acknowledged, finalize.index), finalWallet = walletAt(walletFinalized, root, router, 0n);
        requireProof(finalWallet.before.transfer.status === 2 && finalWallet.after.transfer.status === 0 && finalWallet.after.transfer.opcode === 0 && [finalWallet.before, finalWallet.after].every(s => s.transfer.queryId === record.settlementId && s.transfer.amountRaw === record.amountRaw && s.transfer.destination === record.destinationWallet), 'market_router_wallet_finalization_invalid');
        const finalMessage = one(walletFinalized.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => { const v = perpsControl(message, 0x4a53464b); return v?.queryId === record.settlementId && v.amountRaw === record.amountRaw && v.destination === record.destinationWallet; }), 'market_router_final_receipt_missing');
        const routerFinalized = edge(walletFinalized, finalMessage.index), final = routerAt(routerFinalized), prior = final.before.settlements.get(record.settlementId), done = final.after.settlements.get(record.settlementId);
        requireProof(sameRecord(prior, record) && sameRecord(done, record) && prior!.status === 3 && done!.status === 5 && done!.fundedRaw === '0' && done!.finalizeFundedRaw === '0' && done!.controlFundedRaw === '0' &&
            BigInt(final.before.reservedTokens) - BigInt(final.after.reservedTokens) === BigInt(record.amountRaw), 'market_router_finalization_invalid');
        requireProof(final.before.sourceLanes.get(record.sourceWallet) === record.settlementId && final.before.sourceQueues.get(record.sourceWallet)?.head === record.settlementId && final.after.sourceLanes.get(record.sourceWallet) !== record.settlementId && final.after.sourceQueues.get(record.sourceWallet)?.head !== record.settlementId, 'market_router_finalized_lane_invalid');
        const beforeGroup = final.before.groups.get(record.groupKey), afterGroup = final.after.groups.get(record.groupKey);
        requireProof(beforeGroup && afterGroup && beforeGroup.kind === afterGroup.kind && beforeGroup.businessId === afterGroup.businessId && beforeGroup.pendingLegs === afterGroup.pendingLegs + 1 && beforeGroup.totalLegs === afterGroup.totalLegs && beforeGroup.completionData.hash().equals(afterGroup.completionData.hash()), 'market_router_group_finality_invalid');
        return { settlementId: record.settlementId, kind: record.kind, amountRaw: record.amountRaw, sourceWallet: record.sourceWallet, destinationWallet: record.destinationWallet, destinationOwner: record.destinationOwner,
            requestBodyHash: record.requestHash, requestBodyBoc: outbound.message.body!, request: ref(request), debit: ref(debit), credit: ref(cash.credit), acknowledged: ref(acknowledged), walletFinalized: ref(walletFinalized), routerFinalized: ref(routerFinalized),
            boundaries: [sent.evidence, cash.debitState.evidence, cash.creditState.evidence, walletAt(ackOrigin.node, root, router, 0n).evidence, ack.evidence, finalWallet.evidence, final.evidence] };
    }
    const dispatched = origin(acceptance).node, dispatchedState = routerAt(dispatched);
    requireProof(perpsControl(dispatched.raw.inMessage, 0x4a53464b), 'market_routed_input_finalizer_invalid');
    const inputRecord = dispatchedState.after.settlements.get(perpsControl(dispatched.raw.inMessage, 0x4a53464b)!.queryId);
    requireProof(inputRecord && inputRecord.kind === 12 && inputRecord.amountRaw === execute.amount.toString() && inputRecord.destinationOwner === binding.pool && inputRecord.status === 5, 'market_routed_input_record_invalid');
    const group = dispatchedState.after.groups.get(inputRecord.groupKey);
    requireProof(group && group.kind === 8 && group.businessId === execute.businessId && group.pendingLegs === 0 && group.finalized === 1 && hash(group.completionData) === hash(requestCell), 'market_routed_input_group_invalid');
    const action = group.nativeActions.beginParse(), actionValue = action.loadCoins(), actionPool = action.loadAddress().toRawString(), actionBody = action.loadRef(), actionTail = action.loadRef();
    requireProof(!action.remainingBits && !action.remainingRefs && !actionTail.bits.length && !actionTail.refs.length && actionPool === binding.pool && hash(actionBody) === hash(requestCell) && acceptance.raw.inMessage?.value === actionValue.toString(), 'market_routed_action_invalid');
    const admission = one(routerNodes.filter(node => { if (opcode(node.raw.inMessage) !== NOTIFY || BigInt(node.raw.lt) >= BigInt(acceptance.raw.lt))
        return false; try {
        return routerAt(node).after.settlements.get(inputRecord.settlementId)?.requestHash === inputRecord.requestHash && !routerAt(node).before.settlements.has(inputRecord.settlementId);
    }
    catch {
        return false;
    } }), 'market_router_admission_missing_or_repeated');
    const admissionState = routerAt(admission), notice = tokenWire(admission.raw.inMessage);
    requireProof(notice?.op === NOTIFY && notice.owner && notice.senderWallet && notice.amountRaw === execute.amount.toString(), 'market_routed_original_notice_invalid');
    const intent = readDlmmRoutedIntent(notice.forward), receiptKey = hash(beginCell().storeUint(0x52535752, 32).storeAddress(Address.parse(notice.owner)).storeUint(BigInt(notice.queryId), 64).endCell());
    const receipt = admissionState.after.swapReceipts.get(receiptKey);
    requireProof(!admissionState.before.swapReceipts.has(receiptKey) && receipt && receipt.firstSettlementId === inputRecord.settlementId && receipt.groupKey === inputRecord.groupKey && hash(receipt.notification) === hash(bodyCell(admission.raw.inMessage)!) &&
        intent.minAmountOut === forward.minAmountOut && intent.refundOwner === notice.owner && execute.trader === notice.owner && execute.referrer === intent.referrer, 'market_router_original_receipt_invalid');
    const paymentCredit = origin(admission).node, paymentSource = origin(paymentCredit), payment = physical(paymentSource.node, paymentSource.index, inputRoot, notice.owner, router, notice.amountRaw, false), original = origin(paymentSource.node);
    requireProof(original.node.account === notice.owner && payment.credit === paymentCredit && paymentSource.node.account === notice.senderWallet && payment.flow.wire.queryId === notice.queryId && payment.flow.wire.forward.hash().equals(notice.forward.hash()), 'market_routed_original_payment_invalid');
    const admittedRecord = admissionState.after.settlements.get(inputRecord.settlementId), admittedGroup = admissionState.after.groups.get(inputRecord.groupKey);
    requireProof(admittedRecord && sameRecord(admittedRecord,inputRecord) && inputRecord.settlementId===admissionState.before.nextSettlementId &&
      BigInt(admissionState.after.nextSettlementId)===BigInt(admissionState.before.nextSettlementId)+1n &&
      [...admissionState.after.settlements.keys()].filter(id=>!admissionState.before.settlements.has(id)).length===1 &&
      BigInt(admissionState.after.reservedTokens)-BigInt(admissionState.before.reservedTokens)===execute.amount &&
      !admissionState.before.groups.has(inputRecord.groupKey) && admittedGroup && admittedGroup.kind===8 && admittedGroup.businessId===execute.businessId && admittedGroup.pendingLegs===1 && admittedGroup.totalLegs===1 && admittedGroup.finalized===0 &&
      admissionState.after.poolGroupsByRequestTag.get(execute.tag)===inputRecord.groupKey,'market_routed_ingress_allocation_invalid');
    const inputSettlement = routerSettle(inputRecord, inputRoot, admission);
    requireProof(inputSettlement.routerFinalized.lt === dispatched.raw.lt && inputSettlement.routerFinalized.hash === ref(dispatched).hash, 'market_routed_input_completion_invalid');
    const operation = state.after.routerOperations.get(execute.businessId);
    requireProof(!state.before.routerOperations.has(execute.businessId) && operation && operation.status === 0 && operation.requestHash === hash(requestCell) && hash(operation.request) === hash(requestCell) && operation.completionFunded === execute.completionValue.toString() &&
        state.before.withdrawalsHash === state.after.withdrawalsHash && state.before.directSwaps.dataHash === state.after.directSwaps.dataHash, 'market_routed_operation_allocation_invalid');
    const records = [...state.after.settlements.values()].filter(record => !state.before.settlements.has(record.settlementId)).sort((a, b) => BigInt(a.settlementId) < BigInt(b.settlementId) ? -1 : 1);
    const terminalRecord = state.after.settlements.get(operation.settlementId), feeRecord = operation.feeSettlementId === '0' ? undefined : state.after.settlements.get(operation.feeSettlementId);
    requireProof(terminalRecord && [1, 2].includes(terminalRecord.kind) && records.length === (feeRecord ? 2 : 1) && records.includes(terminalRecord) && (!feeRecord || records.includes(feeRecord) && feeRecord.kind === 9 && feeRecord.tokenSide === 0 && feeRecord.amountRaw === operation.protocolFeeT3), 'market_routed_allocation_roles_invalid');
    const returned = terminalRecord.kind === 2 ? execute.amount : 0n, consumed = execute.amount - returned, output = terminalRecord.kind === 1 ? BigInt(terminalRecord.amountRaw) : 0n;
    requireProof(terminalRecord.tokenSide === (output > 0n ? 1 - inputSide : inputSide) && (output > 0n ? output >= forward.minAmountOut : terminalRecord.amountRaw === execute.amount.toString() && !feeRecord && operation.grossFeeT3 === '0'), 'market_routed_amount_conservation_invalid');
    let next = BigInt(state.before.nextSettlementId);
    const reserve = [0n, 0n];
    for (const record of records) {
        let attempts = 0;
        while (next === 0n || next === forward.queryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) {
            next++;
            requireProof(++attempts < 32, 'market_routed_allocation_limit');
        }
        requireProof(record.settlementId === (next++).toString() && record.businessQueryId === forward.queryId.toString() && record.destinationOwner === router && record.predecessorId === '0' && [1, 2].includes(record.status) && record.recordedAt === acceptance.raw.utime && record.forwardTonAmountRaw === '0' && !record.forwardPayload.bits.length && !record.forwardPayload.refs.length, 'market_routed_allocation_record_invalid');
        reserve[record.tokenSide] += BigInt(record.amountRaw);
    }
    requireProof(next.toString() === state.after.nextSettlementId && BigInt(state.after.reservedT) - BigInt(state.before.reservedT) === reserve[0] && BigInt(state.after.reservedX) - BigInt(state.before.reservedX) === reserve[1] &&
        BigInt(state.after.reservedNative) - BigInt(state.before.reservedNative) === execute.completionValue + records.reduce((n, r) => n + BigInt(r.fundedRaw), 0n), 'market_routed_reserve_conservation_invalid');
    requireProof([...state.before.routerOperations].every(([id, r]) => { const after = state.after.routerOperations.get(id); return after && JSON.stringify({ ...r, request: hash(r.request), completion: hash(r.completion) }) === JSON.stringify({ ...after, request: hash(after.request), completion: hash(after.completion) }); }) && state.after.routerOperations.size === state.before.routerOperations.size + 1, 'market_routed_other_operation_changed');
    requireProof([...state.before.settlements].every(([id, r]) => { const after = state.after.settlements.get(id); return after && (after.recordHash === r.recordHash || r.successorId === '0' && proof.sameRecord(after, r) && after.status === r.status && after.fundedRaw === r.fundedRaw && after.recordedAt === r.recordedAt && records.some(n => n.settlementId === after.successorId && n.sourceWallet === r.sourceWallet)); }), 'market_routed_other_settlement_changed');
    const poolTerminal = settle(acceptance, terminalRecord, walletCode), protocolFeeSettlement = feeRecord ? settle(acceptance, feeRecord, walletCode) : null;
    const sameOperation = (candidate: typeof operation | undefined) => candidate && ['requestHash','settlementId','feeSettlementId','grossFeeT3','protocolFeeT3'].every(field=>candidate[field as keyof typeof candidate]===operation[field as keyof typeof operation]) && candidate.request.hash().equals(operation.request.hash());
    const completion = one(routerNodes.filter(node => { if (opcode(node.raw.inMessage) !== ROUTER_POOL_COMPLETED)
        return false; try {
        return readDlmmRouterCompletion(bodyCell(node.raw.inMessage)!).businessId === execute.businessId;
    }
    catch {
        return false;
    } }), 'market_routed_completion_missing_or_repeated');
    const completed = readDlmmRouterCompletion(bodyCell(completion.raw.inMessage)!), completionOrigin = origin(completion).node, completedState = poolAt(completionOrigin), completedOperation = completedState.after.routerOperations.get(execute.businessId);
    requireProof(completionOrigin.account === binding.pool && completedState.before.routerOperations.get(execute.businessId)?.status === 0 && completedOperation?.status === 1 && completedOperation.completionFunded === '0' && completedOperation.outputDelivered && completedOperation.feeDelivered &&
        sameOperation(completedOperation) && hash(completedOperation.completion) === hash(bodyCell(completion.raw.inMessage)!) && completed.tag === execute.tag && completed.kind === execute.kind && completed.result === (output > 0n ? 1 : 2) && completed.amount === BigInt(terminalRecord.amountRaw) && completed.outputWallet === terminalRecord.destinationWallet && completed.grossFeeT3 === BigInt(operation.grossFeeT3) && completed.protocolFeeT3 === BigInt(operation.protocolFeeT3) &&
        [poolTerminal, ...(protocolFeeSettlement ? [protocolFeeSettlement] : [])].every(s => BigInt(s.poolFinalized.lt) <= BigInt(completionOrigin.raw.lt)), 'market_routed_pool_completion_invalid');
    const completionState = routerAt(completion), completionKey = hash(beginCell().storeAddress(Address.parse(binding.pool)).storeUint(BigInt(execute.businessId), 64).storeUint(execute.kind, 8).storeUint(BigInt('0x' + execute.tag), 256).endCell());
    requireProof(!completionState.before.completions.has(completionKey) && completionState.after.completions.get(completionKey) === hash(bodyCell(completion.raw.inMessage)!) && completionState.before.groups.get(inputRecord.groupKey)?.finalized === 1 && completionState.after.groups.get(inputRecord.groupKey)?.finalized === 2, 'market_routed_router_completion_invalid');
    const ackMessage = one(completion.raw.outMessages.map((message, index) => ({ message, index })).filter(({ message }) => opcode(message) === ROUTER_POOL_COMPLETION_ACK), 'market_routed_completion_ack_missing');
    const acknowledged = edge(completion, ackMessage.index), ack = readDlmmRouterCompletionAck(bodyCell(acknowledged.raw.inMessage)!), ackState = poolAt(acknowledged);
    requireProof(acknowledged.account === binding.pool && ack.businessId === execute.businessId && ack.tag === execute.tag && ack.requestHash === hash(requestCell) && ack.completionHash === hash(bodyCell(completion.raw.inMessage)!) && ack.result === completed.result && ack.amount === completed.amount && ack.outputWallet === completed.outputWallet && ack.pool === binding.pool &&
        ackState.before.routerOperations.get(execute.businessId)?.status === 1 && ackState.after.routerOperations.get(execute.businessId)?.status === 2, 'market_routed_completion_ack_invalid');
    const beforeAckOperation=ackState.before.routerOperations.get(execute.businessId),afterAckOperation=ackState.after.routerOperations.get(execute.businessId);
    requireProof(sameOperation(beforeAckOperation) && sameOperation(afterAckOperation) && hash(beforeAckOperation!.completion)===hash(bodyCell(completion.raw.inMessage)!) && hash(afterAckOperation!.completion)===hash(bodyCell(completion.raw.inMessage)!) &&
      afterAckOperation!.outputDelivered && afterAckOperation!.feeDelivered && afterAckOperation!.completionFunded==='0' &&
      ['reservedT','reservedX','reservedNative','nextSettlementId','binsHash','observationsHash','withdrawalsHash'].every(k=>ackState.before[k as keyof typeof ackState.before]===ackState.after[k as keyof typeof ackState.after]) &&
      ackState.before.settlements.size===ackState.after.settlements.size && [...ackState.before.settlements].every(([id,r])=>ackState.after.settlements.get(id)?.recordHash===r.recordHash),'market_routed_ack_mutated_cash');
    const terminalKey = hash(beginCell().storeUint(0x52535452, 32).storeUint(BigInt(execute.businessId), 64).endCell()), terminalIndex = completionState.after.completions.get(terminalKey);
    const routerTerminal = terminalIndex ? completionState.after.settlements.get(BigInt('0x' + terminalIndex).toString()) : undefined;
    requireProof(!completionState.before.completions.has(terminalKey) && routerTerminal && routerTerminal.kind === (output > 0n ? 8 : 7) && routerTerminal.amountRaw === terminalRecord.amountRaw && routerTerminal.destinationOwner === (output > 0n ? intent.recipient : intent.refundOwner), 'market_routed_terminal_identity_invalid');
    const terminalGroup=completionState.after.groups.get(routerTerminal.groupKey);
    requireProof(!completionState.before.settlements.has(routerTerminal.settlementId) && [...completionState.after.settlements.keys()].filter(id=>!completionState.before.settlements.has(id)).length===1 &&
      BigInt(completionState.after.reservedTokens)-BigInt(completionState.before.reservedTokens)===BigInt(routerTerminal.amountRaw) && terminalGroup && terminalGroup.kind===4 && terminalGroup.businessId===execute.businessId && terminalGroup.finalized===0,
      'market_routed_terminal_allocation_invalid');
    const terminalSettlement = routerSettle(routerTerminal, output > 0n ? outputRoot : inputRoot, completion);
    if (output > 0n) {
        const before = readDlmmLiquidityState(acceptance.before!.state.dataBoc!), after = readDlmmLiquidityState(acceptance.after!.state.dataBoc!);
        const sum = (bins: typeof before.bins, side: 'reserveTRaw' | 'reserveXRaw') => [...bins.values()].reduce((n, bin) => n + BigInt(bin[side]), 0n);
        requireProof(sum(after.bins, 'reserveTRaw') - sum(before.bins, 'reserveTRaw') === (inputSide === 0 ? consumed : -output) - completed.protocolFeeT3 && sum(after.bins, 'reserveXRaw') - sum(before.bins, 'reserveXRaw') === (inputSide === 0 ? -output : consumed), 'market_routed_fee_economics_invalid');
    }
    else
        requireProof(state.before.binsHash === state.after.binsHash && state.before.observationsHash === state.after.observationsHash, 'market_routed_refund_price_changed');
    const settlements: MarketSettlementEvidence[] = [{ ...poolTerminal, kind: output > 0n ? 'swap_output' : 'unused_input_refund' }];
    const routing: MarketRoutingEvidence = { router, businessId: execute.businessId, requestHash: hash(requestCell), completionHash: hash(bodyCell(completion.raw.inMessage)!), routerAcceptance: ref(admission), completion: ref(completion), completionAcknowledged: ref(acknowledged), inputSettlement, terminalSettlement, protocolFeeSettlement, boundaries: [admissionState.evidence, dispatchedState.evidence, completedState.evidence, completionState.evidence, ackState.evidence] };
    return { forward: { ...forward, recipient: intent.recipient }, notice: { ...notice, owner: notice.owner, senderWallet: notice.senderWallet }, inputRoot, outputRoot, inputSide, paid: execute.amount, returned, consumed, output, state, original, paymentSource, paymentCredit, payment, settlements, routing };
}
