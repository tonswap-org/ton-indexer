tolk 1.5.0

import "./pool_state_init";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/jetton_quotes";
import "../shared/jetton/jetton_sweep";
import "../shared/oracle/obs_ring";
import "../t3/receipt_tree";

struct PoolBin { t: coins; x: coins; shares: uint256; pq: uint128 }
struct PoolFarmFraction { fraction: uint128 }
struct PoolPosition { shares: uint256; farmId: uint64; accSnap: uint256; rewardCarry: Cell<PoolFarmFraction>? }
struct PoolOwnerPositions { firstBin: int32; first: PoolPosition; more: map<int32, PoolPosition> }
struct PoolPositionBucket { owner: address; positions: PoolOwnerPositions; otherCount: uint2; others: map<address, PoolOwnerPositions> }
struct PoolAmm { reserveT: coins; reserveX: coins; bins: map<int32, PoolBin> }
struct PoolCampaignTerms { binId: int32; side: uint8; sponsor: address; total: coins; start: uint32; duration: uint32 }
struct PoolCampaign { end: uint32; lastTs: uint32; acc: uint256; weight: uint128; paid: coins; terms: Cell<PoolCampaignTerms> }
struct PoolFarming { nextId: uint64; escrowT: coins; escrowX: coins; campaigns: map<uint64, PoolCampaign> }
struct PoolCold {
    factory: address; feeSink: address; treasury: address;
    positions: map<uint128, PoolPositionBucket>; farming: Cell<PoolFarming>;
}
struct PoolCreditRecovery { dispatched: uint256; handled: uint256; pending: coins; tree: Cell<T3ReceiptTree>?; restored: uint256 }
struct PoolCreditClaim { amount: coins; refundTo: address; queryId: uint64; origin: address; notify: bool; claimed: bool }
struct PoolJet { ledger: JettonLedger; sweeps: JettonSweeps; recovery: Cell<PoolCreditRecovery>? }
struct PoolStorage {
    flags: uint8; binSpacing: uint16; feePips: uint32; xDecimals: uint8; activeBin: int32;
    protocolFeesT3: coins; binCount: uint16; positionCount: uint16; campaignCount: uint8;
    jet: Cell<PoolJet>; amm: Cell<PoolAmm>; oracle: cell; cold: Cell<PoolCold>;
}

fun pool_initial_data(factory: address, feeSink: address, treasury: address, t3Master: address, t3WalletGas: uint32, t3WalletGram: coins, t3WalletBudget: Cell<JettonWalletBudget>, id: PoolId): cell {
    var slots: map<uint8, JettonSlot> = [];
    slots.set(0, { master: t3Master, wallet: null, walletGas: t3WalletGas, walletGram: t3WalletGram, optional: false, budget: t3WalletBudget });
    slots.set(1, { master: id.xMaster, wallet: null, walletGas: id.walletGasX, walletGram: id.walletGramX, optional: true, budget: id.walletBudgetX });
    return PoolStorage {
        flags: 0, binSpacing: id.binSpacing, feePips: id.feePips, xDecimals: id.xDecimals, activeBin: 0,
        protocolFeesT3: 0, binCount: 0, positionCount: 0, campaignCount: 0,
        jet: PoolJet { ledger: { slots, owed: [] }, sweeps: { busy: 0, slots: [] },
            recovery: t3WalletBudget.load().creditProtection ? PoolCreditRecovery { handled: 0,pending: 0,tree: null,dispatched: 0,restored: 0 }.toCell() : null }.toCell(),
        amm: PoolAmm { reserveT: 0, reserveX: 0, bins: [] }.toCell(), oracle: obs_ring_empty_cell(),
        cold: PoolCold { factory, feeSink, treasury, positions: [],
            farming: PoolFarming { nextId: 1, escrowT: 0, escrowX: 0, campaigns: [] }.toCell() }.toCell(),
    }.toCell();
}

