tolk 1.5.0

import "../generated/op/t3";

// The payload cell retains the entire original Either encoding, including its tag.
struct WalletDetails { queryId: uint64; response: address?; forwardValue: coins; forwardPayload: cell; customPayload: cell? }
struct WalletTerms { owner: address; recipient: address; burn: bool; amount: coins; details: Cell<WalletDetails> }
struct WalletAttempt { id: uint64; originLt: uint64; attempt: uint64; terms: Cell<WalletTerms> }
struct WalletRecord { failed: bool; cancelled: bool; attempt: Cell<WalletAttempt> }
struct WalletEvidence { wallet: address; attempt: Cell<WalletAttempt> }
struct T3WalletJournal { count: uint64; root: uint256; frontier: map<uint8,uint256> }
struct WalletConfig { owner: address; master: address; proofCodeHash: uint256 }
struct T3WalletState { config: Cell<WalletConfig>; balance: coins; nextId: uint65; root: uint256; journal: Cell<T3WalletJournal>; frontier: map<uint8,uint256>; protectedCredits: uint256; acceptedTransfers: uint256 }

// Sparse depth-64 tree of empty leaves: H_0=hash(uint8(0)); H_n=hash(uint8(4),H_(n-1),H_(n-1)).
const T3_WALLET_EMPTY_ROOT = 80355962451499150200844324337340404487209003436766272097586724178421748362113;
fun t3_wallet_initial_state(owner: address, master: address, proofCodeHash: uint256): Cell<T3WalletState> {
    val config: WalletConfig = { owner, master, proofCodeHash };
    val journal: T3WalletJournal = { count: 0, root: 0, frontier: createEmptyMap() };
    return T3WalletState { config: config.toCell(), balance: 0, nextId: 0, root: T3_WALLET_EMPTY_ROOT,
        journal: journal.toCell(), frontier: createEmptyMap(), protectedCredits: 0,acceptedTransfers: 0 }.toCell();
}
fun t3_wallet_init(owner: address, master: address, proofCodeHash: uint256, code: cell): AutoDeployAddress {
    return { workchain: 0, stateInit: { code, data: t3_wallet_initial_state(owner, master, proofCodeHash) } };
}
fun t3_wallet_attempt_body(attempt: Cell<WalletAttempt>): cell {
    return beginCell().storeUint(attempt.load().terms.load().burn ? OP_T3_WALLET_BURN : OP_T3_WALLET_DELIVERY, 32)
        .storeRef(attempt).endCell();
}
fun t3_wallet_mint_body(queryId: uint64, amount: coins, mintIdentity: cell, response: address?): cell {
    return beginCell().storeUint(OP_T3_WALLET_MINT, 32).storeUint(queryId, 64).storeCoins(amount)
        .storeRef(mintIdentity).storeAddressOpt(response).endCell();
}
