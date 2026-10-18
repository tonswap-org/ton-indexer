tolk 1.5.0

// Runtime fee quotes shared by ledger holders and the order intake path.
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"

const JETTON_V21_WALLET_GAS = 14000
const JETTON_DEFAULT_WALLET_GAS = 30000
// Includes scans of all 16 ready slots, including optional-slot discovery retries.
const JETTON_DSCW_GAS = 100000
const JETTON_OWED_CAP = 1024
const JETTON_NOTIFY_GAS = 45000
// The master forwards its remainder to a full-ledger checkTake/commitTake reply.
const JETTON_PROVIDE_GAS = 100000
// Payable recipients can construct every address-prefix fork without a key search.
const JETTON_CLAIM_GAS = 250000
const JETTON_REFUND_TAIL_GAS = 350000
const JETTON_ARCHIVE_CLAIM_GAS = 200000
const JETTON_WALLET_RENT_SECONDS = 157680000
// Immutable measurements of one wallet implementation, supplied by its deployment profile.
struct JettonWalletBudget {
    senderGas: uint32;
    walletBounceGas: uint32;
    burnWalletGas: uint32;
    smallPayloadCells: uint16;
    largeWalletGas: uint32;
    largeSenderGas: uint32;
    rentSeconds: uint32;
    rentBits: uint32;
    rentCells: uint16;
    initBits: uint32;
    initCells: uint16;
    initCopies: uint8;
    transferBits: uint16;
    transferCells: uint8;
    transferCopies: uint8;
    creditProtection: bool;
}

fun jetton_standard_budget(senderGas: int): Cell<JettonWalletBudget> {
    return JettonWalletBudget { senderGas: senderGas as uint32, walletBounceGas: 0, burnWalletGas: senderGas as uint32, smallPayloadCells: 65535,
        largeWalletGas: senderGas as uint32, largeSenderGas: senderGas as uint32,
        rentSeconds: JETTON_WALLET_RENT_SECONDS, rentBits: 1100, rentCells: 3,
        initBits: 8500, initCells: 18, initCopies: 1,
        transferBits: 880, transferCells: 1, transferCopies: 3, creditProtection: false }.toCell();
}

fun jetton_budget_try_parse(c: cell): JettonWalletBudget? {
    val (s, exotic) = c.beginParseSpecial();
    if (exotic || s.remainingBitsCount() != 345 || s.remainingRefsCount() != 0) { return null; }
    return JettonWalletBudget.fromSlice(s);
}

fun jetton_budget_valid(p: JettonWalletBudget, walletGas: int): bool {
    return p.senderGas >= 10000 && p.senderGas <= walletGas
        && p.smallPayloadCells > 0
        && p.largeSenderGas >= p.senderGas && p.largeWalletGas >= walletGas
        && p.largeSenderGas <= p.largeWalletGas && p.largeWalletGas <= 2000000 && p.walletBounceGas <= 500000 && p.burnWalletGas >= p.senderGas && p.burnWalletGas <= 2000000 && p.rentSeconds > 0
        && p.rentBits > 0 && p.rentCells > 0 && p.initBits > 0 && p.initCells > 0
        && p.initCopies > 0 && p.initCopies <= 4 && p.transferBits >= 880
        && p.transferCells > 0 && p.transferCopies >= 3 && p.transferCopies <= 8;
}

@inline_ref
fun jetton_wallet_gas(totalGas: int, senderGas: int): coins {
    // Each transaction has its own flat price, including a conservatively zero
    // remainder when a standard profile allocates all gas to the source.
    return calculateGasFee(BASECHAIN, senderGas) + calculateGasFee(BASECHAIN, totalGas - senderGas);
}

fun jetton_leg_bounds(walletGas: int, walletGram: coins, p: JettonWalletBudget,
    payloadBits: int, payloadCells: int, bounceGas: int): (coins, coins) {
    val fwd = calculateForwardFee(BASECHAIN, p.transferBits + payloadBits, p.transferCells + payloadCells);
    val large = payloadCells > p.smallPayloadCells;
    val own = jetton_wallet_gas(large ? p.largeWalletGas : walletGas, large ? p.largeSenderGas : p.senderGas)
        + calculateStorageFee(BASECHAIN, p.rentSeconds, p.rentBits, p.rentCells);
    val accepted = p.transferCopies * fwd
        + p.initCopies * calculateForwardFeeWithoutLumpPrice(BASECHAIN, p.initBits, p.initCells)
        + max(own, walletGram) + 1;
    // Recipient failure cannot commit its forwarded value. It can instead fund
    // the source wallet's authenticated failure journal.
    val downstream: coins = p.walletBounceGas == 0 ? 0 : accepted + calculateGasFee(BASECHAIN, p.walletBounceGas);
    if (bounceGas == 0) { return (accepted, downstream); }
    // Own-wallet refusal and accepted downstream delivery are exclusive. A refusal
    // returns the unused forward value; budget its source compute and full rich body.
    // Four envelopes cover the command, rich refusal, holder log and excess.
    val refused = calculateGasFee(BASECHAIN, large ? p.largeSenderGas : p.senderGas) + calculateGasFee(BASECHAIN, bounceGas)
        + jetton_recovery_rent() + 4 * calculateForwardFee(BASECHAIN, 1238 + payloadBits, 3 + payloadCells) + 1;
    return (accepted, max(refused, downstream));
}

fun jetton_leg_value(walletGas: int, walletGram: coins, p: JettonWalletBudget,
    forwardGram: coins, payloadBits: int, payloadCells: int, bounceGas: int): coins {
    val (accepted, refused) = jetton_leg_bounds(walletGas, walletGram, p, payloadBits, payloadCells, bounceGas);
    return max(forwardGram + accepted, refused);
}

fun jetton_owed_rent(): coins {
    return calculateStorageFee(BASECHAIN, JETTON_WALLET_RENT_SECONDS, 600, 2);
}

// Covers the initial archive cell plus its first frontier node. Later growth is smaller.
fun jetton_recovery_rent(): coins {
    return calculateStorageFee(BASECHAIN, JETTON_WALLET_RENT_SECONDS, 1100, 3);
}

fun jetton_notify_value(): coins {
    return calculateGasFee(BASECHAIN, JETTON_NOTIFY_GAS);
}

fun jetton_discover_value(walletGram: coins): coins {
    return max(calculateGasFee(BASECHAIN, JETTON_PROVIDE_GAS), walletGram)
        + 2 * calculateForwardFee(BASECHAIN, 1000, 2);
}

fun jetton_min_discover(sends: int): coins {
    return sends * jetton_discover_value(0) + calculateGasFee(BASECHAIN, JETTON_DSCW_GAS);
}

fun jetton_owed_floor(handlerGas: int, spent: coins): coins {
    return spent + calculateGasFee(BASECHAIN, handlerGas) + jetton_recovery_rent();
}

