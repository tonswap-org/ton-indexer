import { Cell, Slice } from '@ton/core';
import { parseDlmmSwapForward } from '../utils/dlmmSettlementEvidence';
export const ROUTED_SWAP_INTENT = 0x52535749;
export const ROUTER_POOL_EXECUTE = 0x52505358;
export const ROUTER_POOL_COMPLETED = 0x52505343;
export const ROUTER_POOL_COMPLETION_ACK = 0x52504341;
const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs)
    throw Error('routed_wire_tail'); };
const raw = (s: Slice) => s.loadAddress().toRawString();
const hex = (s: Slice) => s.loadUintBig(256).toString(16).padStart(64, '0');
const ordinary = (c: Cell) => { if (c.isExotic)
    throw Error('routed_wire_exotic'); return c.beginParse(); };
/** Only the current single-pool ordinary swap is qualified. Other route products
 * stay explicit unsupported candidates; no route or version inference is used. */
export function readDlmmRoutedIntent(cell: Cell) {
    const s = ordinary(cell);
    if (s.loadUint(32) !== ROUTED_SWAP_INTENT || s.loadUint(8) !== 1)
        throw Error('routed_intent_version');
    const marketId = s.loadUint(32), hubSell = s.loadUint(32), hubBuy = s.loadUint(32), minAmountOut = s.loadCoins();
    const recipient = raw(s), refundOwner = raw(s), quotedAmountOut = s.loadCoins(), quotedFees = s.loadCoins();
    const unsupported = [hubSell, hubBuy, s.loadCoins(), s.loadCoins(), s.loadCoins(), s.loadCoins()];
    const hook = s.loadRef(), referral = ordinary(s.loadRef()), referrer = referral.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    end(referral);
    if (!marketId || unsupported.some(v => v !== 0 && v !== 0n) || hook.isExotic || hook.bits.length || hook.refs.length)
        throw Error('routed_intent_product_unsupported');
    return { marketId, minAmountOut, recipient, refundOwner, quotedAmountOut, quotedFees, referrer };
}
export function readDlmmRouterExecute(cell: Cell) {
    const s = ordinary(cell);
    if (s.loadUint(32) !== ROUTER_POOL_EXECUTE)
        throw Error('routed_execute_opcode');
    const businessId = s.loadUintBig(64).toString(), kind = s.loadUint(8), tag = hex(s), amount = s.loadCoins(), completionValue = s.loadCoins();
    const wallets = ordinary(s.loadRef()), inputWallet = raw(wallets), routerInputWallet = raw(wallets), outputWallet = raw(wallets), payload = s.loadRef();
    end(wallets);
    end(s);
    const swap = parseDlmmSwapForward(payload);
    if (businessId === '0' || kind !== 8 || amount <= 0n || !swap)
        throw Error('routed_execute_product_unsupported');
    const details = ordinary(payload);
    details.skip(96);
    details.loadAddress();
    details.loadCoins();
    details.loadUint(8);
    const callback = details.loadMaybeAddress(), hook = details.loadRef(), donationT = details.loadCoins(), donationX = details.loadCoins(), traderInfo = ordinary(details.loadRef());
    const trader = raw(traderInfo), referrer = traderInfo.loadMaybeAddress()?.toRawString() ?? null;
    end(traderInfo);
    end(details);
    if (swap.queryId.toString() !== businessId || callback || hook.isExotic || hook.bits.length || hook.refs.length || donationT !== 0n || donationX !== 0n)
        throw Error('routed_execute_extension_unsupported');
    return { businessId, kind, tag, amount, completionValue, inputWallet, routerInputWallet, outputWallet, payload, swap, trader, referrer };
}
export function readDlmmRouterCompletion(cell: Cell) {
    const s = ordinary(cell);
    if (s.loadUint(32) !== ROUTER_POOL_COMPLETED)
        throw Error('routed_completion_opcode');
    const businessId = s.loadUintBig(64).toString(), kind = s.loadUint(8), result = s.loadUint(8), tag = hex(s), amount = s.loadCoins(), outputWallet = raw(s);
    const fees = ordinary(s.loadRef()), grossFeeT3 = fees.loadCoins(), protocolFeeT3 = fees.loadCoins();
    end(fees);
    end(s);
    if (kind !== 8 || ![1, 2].includes(result) || amount <= 0n || protocolFeeT3 > grossFeeT3)
        throw Error('routed_completion_invalid');
    return { businessId, kind, result, tag, amount, outputWallet, grossFeeT3, protocolFeeT3 };
}
export function readDlmmRouterCompletionAck(cell: Cell) {
    const s = ordinary(cell);
    if (s.loadUint(32) !== ROUTER_POOL_COMPLETION_ACK)
        throw Error('routed_completion_ack_opcode');
    const businessId = s.loadUintBig(64).toString(), kind = s.loadUint(8), tag = hex(s), requestHash = hex(s), completionHash = hex(s);
    const outcome = ordinary(s.loadRef()), result = outcome.loadUint(8), amount = outcome.loadCoins(), outputWallet = raw(outcome), pool = raw(outcome);
    end(outcome);
    end(s);
    if (kind !== 8 || ![1, 2].includes(result) || amount <= 0n)
        throw Error('routed_completion_ack_invalid');
    return { businessId, kind, tag, requestHash, completionHash, result, amount, outputWallet, pool };
}
