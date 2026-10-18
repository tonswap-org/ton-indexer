tolk 1.5.0

import "@gen/op/testing"

struct HostileParams { issuer: address; transferGas: uint32; gramFloor: coins; provideFloor: coins }
struct HostileWalletState {
    balance: coins
    owner: address
    master: address
    params: Cell<HostileParams>
    outgoingLocked: bool
    incomingLocked: bool
}
struct (0x484a4346) HostileJettonConfig { outgoingLocked: bool; incomingLocked: bool }
struct (0x484a4d54) HostileJettonMint { queryId: uint64; recipient: address; amount: coins; forward: coins; payload: cell }

fun hostileWalletInit(owner: address, master: address, code: cell, params: Cell<HostileParams>): AutoDeployAddress {
    return { workchain: BASECHAIN, stateInit: { code, data: HostileWalletState {
        balance: 0, owner, master, params, outgoingLocked: false, incomingLocked: false
    }.toCell() } };
}
