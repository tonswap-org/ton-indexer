tolk 1.5.0

import "@gen/op/dlmm";
import "../shared/jetton/jetton_quotes";

struct PoolId {
    xMaster: address;
    binSpacing: uint16;
    feePips: uint32;
    xDecimals: uint8;
    walletGasX: uint32;
    walletGramX: coins;
    walletBudgetX: Cell<JettonWalletBudget>;
}
struct LiqAddRow { binId: int32; amount: coins; minShares: uint256; next: cell? }
struct LiqRemoveRow { binId: int32; shares: uint256; next: cell? }
struct LiqResultRow { binId: int32; shares: uint256; next: cell? }
struct (0x4c514133) LiqAdd { owner: address; notify: bool; count: uint3; rows: cell }
struct (0x4c514f33) LiqOutcome {
    queryId: uint64; status: uint8; reason: uint8; side: uint8; count: uint3; amount: coins; rows: cell;
}
struct (0x4c515233) LiqRemove {
    queryId: uint64; recipient: address; deadline: uint32; minT3: coins; minX: coins; count: uint3; rows: cell;
}
struct (0x4c515633) LiqEvict { queryId: uint64; owner: address; binId: int32 }
struct (0x50504f33) PoolPayout { kind: uint8; queryId: uint64; reason: uint8 }
struct (0x464d4333) FarmCreate { binId: int32; duration: uint32 }
struct (0x464d4133) FarmAction { queryId: uint64; action: uint8; farmId: uint64; owner: address }
struct (0x50535750) PoolFeeSweep { queryId: uint64 }
struct (0x50494e49) PoolInit { notifyTo: address? }
struct (0x50524459) PoolReady { id: Cell<PoolId>; notifyTo: address? }
struct (0x50505333) PoolPause { paused: bool }
struct (0x50435233) PoolCreate { id: Cell<PoolId>; notify: bool }
struct (0x50434e33) PoolCreated { pool: address; id: Cell<PoolId> }
struct (0x50505355) FactoryPause { pool: address; paused: bool }
struct PoolAmounts { amountT3: coins; amountX: coins }
struct (0x4c514533) LiqEvent {
    kind: uint8; queryId: uint64; owner: address; binId: int32; shares: uint256;
    amounts: Cell<PoolAmounts>; activeBin: int32;
}
struct (0x464d4533) FarmEvent {
    kind: uint8; queryId: uint64; farmId: uint64; owner: address; amount: coins; weight: uint128;
}
struct (0x50455633) PoolEvent { kind: uint8; a: coins; b: coins }
struct (0x504c5333) PoolListed { pool: address; id: Cell<PoolId> }

struct PoolFactoryPeers { governance: address; feeSink: address; treasury: address }
struct PoolFactoryStorage {
    cfg: Cell<PoolFactoryPeers>; t3Master: address; blockedX: address?;
    poolCodeBits: uint32; poolCodeCells: uint16; poolCode: cell;
    t3WalletGas: uint32; t3WalletGram: coins; t3WalletBudget: Cell<JettonWalletBudget>;
}

struct (0x46534133) FactorySweepAllow { pool: address; queryId: uint64; slot: uint8; amount: coins }
