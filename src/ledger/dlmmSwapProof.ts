import { Address, Cell, beginCell } from '@ton/core';
import { perpsWalletAddress } from './perpsWire';
import { readDlmmLiquidityState } from './dlmmLiquidityState';
import { parseDlmmSwapForward } from '../utils/dlmmSettlementEvidence';
import { tokenWire, NOTIFY, dlmmLiquidityNotificationCommitment } from './wire';
import { createDlmmProofGraph, requireProof, address, successful, type DlmmProofBinding } from './dlmmProof';
import type { MarketNode, MarketSettlementEvidence } from './marketTypes';

/** Shared exact current swap allocation, cash conservation and physical finalization proof. */
export function verifyDlmmSwapExecution(binding: DlmmProofBinding, proof: ReturnType<typeof createDlmmProofGraph>, acceptance: MarketNode) {
  const { poolAt, origin, physical, settle, sameRecord } = proof;
  const notice = tokenWire(acceptance.raw.inMessage);
  requireProof(notice?.op === NOTIFY, 'market_swap_acceptance_invalid');
      const forward = parseDlmmSwapForward(notice.forward);
      requireProof(successful(acceptance) && forward && notice.owner && notice.senderWallet && BigInt(notice.amountRaw) > 0n, 'market_swap_acceptance_invalid');
      const inputSide = forward.zeroForOne === 1 ? 0 : 1, inputRoot = inputSide === 0 ? binding.tokenT : binding.tokenX, outputRoot = inputSide === 0 ? binding.tokenX : binding.tokenT;
      const state = poolAt(acceptance), paymentCredit = origin(acceptance).node, paymentSource = origin(paymentCredit), payment = physical(paymentSource.node, paymentSource.index, inputRoot, notice.owner, binding.pool, notice.amountRaw, false);
      const original = origin(paymentSource.node);
      requireProof(original.node.account === notice.owner && payment.credit === paymentCredit && paymentCredit.account === address(acceptance.raw.inMessage?.source) &&
        paymentSource.node.account === notice.senderWallet && payment.flow.wire.queryId === notice.queryId && payment.flow.wire.forward.hash().equals(notice.forward.hash()), 'market_original_funding_unverified');
      const records = [...state.after.settlements.values()].filter(record => !state.before.settlements.has(record.settlementId))
        .sort((a, b) => BigInt(a.settlementId) < BigInt(b.settlementId) ? -1 : 1);
      requireProof(records.length >= 1 && records.length <= 3 && state.before.withdrawalsHash === state.after.withdrawalsHash && state.before.routerOperationsHash === state.after.routerOperationsHash, 'market_allocation_count_invalid');
      let next = BigInt(state.before.nextSettlementId);
      for (const record of records) {
        let attempts = 0;
        while ((next === 0n || next === forward.queryId || state.before.settlements.has(next.toString()) || state.before.withdrawalIds.has(next.toString())) && attempts < 32) { next++; attempts++; }
        requireProof(attempts < 32 && next < 0xffffffffffffffffn && record.settlementId === next.toString(), 'market_allocation_sequence_invalid');
        next++;
        requireProof(record.businessQueryId === forward.queryId.toString() &&
          record.predecessorId === '0' && [1, 2].includes(record.status) && [1, 2, 9].includes(record.kind) &&
          record.recordedAt === acceptance.raw.utime && record.forwardTonAmountRaw === '0' && !record.forwardPayload.bits.length && !record.forwardPayload.refs.length, 'market_allocation_record_invalid');
      }
      requireProof(next.toString() === state.after.nextSettlementId, 'market_allocation_counter_invalid');
      const outputs = records.filter(record => record.kind === 1), refunds = records.filter(record => record.kind === 2), fees = records.filter(record => record.kind === 9);
      const receiptKey = dlmmLiquidityNotificationCommitment(acceptance.raw.inMessage), receipt = receiptKey && state.after.directSwaps.receipts.get(receiptKey);
      requireProof(receiptKey && receipt && !state.before.directSwaps.receipts.has(receiptKey) &&
        state.after.directSwaps.receipts.size === state.before.directSwaps.receipts.size + 1 &&
        receipt.refund.initialId === (refunds[0]?.settlementId ?? '0') && receipt.output.initialId === (outputs[0]?.settlementId ?? '0') &&
        receipt.refund.amountRaw === (refunds[0]?.amountRaw ?? '0') && receipt.output.amountRaw === (outputs[0]?.amountRaw ?? '0'), 'market_direct_swap_allocation_receipt_invalid');
      requireProof(outputs.length <= 1 && refunds.length <= 1 && fees.length <= 1 && (!outputs.length || outputs[0].tokenSide !== inputSide && outputs[0].destinationOwner === forward.recipient) &&
        (!refunds.length || refunds[0].tokenSide === inputSide && refunds[0].destinationOwner === notice.owner) &&
        records.map(record => record.kind).join(',') === [...refunds, ...outputs, ...fees].map(record => record.kind).join(',') &&
        (!fees.length || outputs.length === 1 && fees[0].tokenSide === 0 && state.after.treasury !== null && fees[0].destinationOwner === state.after.treasury), 'market_allocation_roles_invalid');
      for (const record of records) {
        const runnable = (value: typeof record) => value.status === 2 || value.status === 1 && value.fundedRaw === '180000000';
        const later = runnable(record) ? records.find(candidate => BigInt(candidate.settlementId) > BigInt(record.settlementId) && candidate.sourceWallet === record.sourceWallet && runnable(candidate)) : undefined;
        requireProof(record.successorId === (later?.settlementId ?? '0'), 'market_allocation_successor_invalid');
      }
      const fee = fees[0];
      if (fee) {
        requireProof(fee.sourceWallet === perpsWalletAddress(state.after.walletCode, binding.tokenT, binding.pool) &&
          fee.destinationWallet === perpsWalletAddress(state.after.walletCode, binding.tokenT, state.after.treasury!) &&
          (fee.status === 1 ? BigInt(fee.fundedRaw) <= 180000000n : fee.fundedRaw === '40000000'), 'market_protocol_fee_wallet_identity_invalid');
        const request = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(BigInt(fee.settlementId), 64).storeCoins(BigInt(fee.amountRaw))
          .storeAddress(Address.parse(fee.destinationOwner)).storeAddress(Address.parse(binding.pool))
          .storeRef(beginCell().storeUint(0x4a535454, 32).endCell()).storeCoins(0).storeRef(Cell.EMPTY).endCell();
        requireProof(request.hash().toString('hex') === fee.requestHash, 'market_protocol_fee_request_invalid');
      }
      const returned = BigInt(refunds[0]?.amountRaw ?? '0'), paid = BigInt(notice.amountRaw), consumed = paid - returned;
      requireProof(returned <= paid && (outputs.length ? consumed > 0n && BigInt(outputs[0].amountRaw) >= forward.minAmountOut : returned === paid), 'market_input_conservation_failed');
      const added = [0n, 0n]; for (const record of records) added[record.tokenSide] += BigInt(record.amountRaw);
      requireProof(BigInt(state.after.reservedT) - BigInt(state.before.reservedT) === added[0] && BigInt(state.after.reservedX) - BigInt(state.before.reservedX) === added[1] &&
        BigInt(state.after.reservedNative) - BigInt(state.before.reservedNative) === records.reduce((total, record) => total + BigInt(record.fundedRaw), 0n) &&
        [...state.before.settlements].every(([id, record]) => {
          const after = state.after.settlements.get(id);
          return after && (after.recordHash === record.recordHash || record.successorId === '0' && sameRecord(after, record) &&
            after.status === record.status && after.fundedRaw === record.fundedRaw && after.recordedAt === record.recordedAt &&
            records.some(added => added.settlementId === after.successorId && added.sourceWallet === record.sourceWallet));
        }), 'market_allocation_reserve_delta_invalid');
      const settlements: MarketSettlementEvidence[] = [...refunds, ...outputs].map(record => ({ ...settle(acceptance, record, state.after.walletCode), kind: record.kind === 1 ? 'swap_output' : 'unused_input_refund' }));
      // The fee is a separate treasury liability. Its allocation leaves the
      // traded T3 reserves and never changes payer refund/output identities.
      if (fee) {
        const before = readDlmmLiquidityState(acceptance.before!.state.dataBoc!), after = readDlmmLiquidityState(acceptance.after!.state.dataBoc!);
        const sum = (bins: typeof before.bins, side: 'reserveTRaw' | 'reserveXRaw') => [...bins.values()].reduce((value, bin) => value + BigInt(bin[side]), 0n);
        const deltaT = sum(after.bins, 'reserveTRaw') - sum(before.bins, 'reserveTRaw'), deltaX = sum(after.bins, 'reserveXRaw') - sum(before.bins, 'reserveXRaw');
        const output = BigInt(outputs[0].amountRaw), protocol = BigInt(fee.amountRaw);
        requireProof(deltaT === (inputSide === 0 ? consumed : -output) - protocol && deltaX === (inputSide === 0 ? -output : consumed), 'market_protocol_fee_reserve_economics_invalid');
      }
      if (!outputs.length) requireProof(state.before.binsHash === state.after.binsHash && state.before.observationsHash === state.after.observationsHash, 'market_refunded_price_state_changed');
      return { forward, notice: {...notice, owner: notice.owner!, senderWallet: notice.senderWallet!}, inputRoot, outputRoot, inputSide, paid, returned, consumed,
        output: BigInt(outputs[0]?.amountRaw ?? '0'), protocolFeeAllocation: fee ? {settlementId: fee.settlementId, root: binding.tokenT, amountRaw: fee.amountRaw, sourceWallet: fee.sourceWallet, destinationOwner: fee.destinationOwner, destinationWallet: fee.destinationWallet, requestHash: fee.requestHash} : null, state, original, paymentSource, paymentCredit, payment, settlements };
}
