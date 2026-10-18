tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "genesis_types"
import "../shared/jetton/vendor_minter"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"
import "@gen/op/jetton"
import "@gen/op/restricted_jetton_claim_admin"

const RM_MINT_GAS = 40000
const RM_BURN_GAS = 20000
const RM_RATE_GAS = 12000
const RM_TAIL_GAS = 14000
const RM_MINTER_MINT_GAS = 8000
const RM_MINTER_RESERVE = 10000000
const RM_WALLET_DEPLOY_BITS = 7025
const RM_WALLET_DEPLOY_CELLS = 13
const RM_RENT_SECONDS = 172800

struct (0x524d4459) RemintDay { queryId: uint64 }
struct (0x524d4252) RemintBurn { queryId: uint64; amount: coins }
struct (0x524d434c) RemintClaimAdmin { queryId: uint64 }
struct (0x524d5254) RemintRate { queryId: uint64; mode: uint8; rateBps: uint16 }
struct (0x524d4556) RemintEvent { kind: uint8; day: uint32; amount: coins; rateBps: uint16 }

fun RemintStorage.load(): RemintStorage { return RemintStorage.fromCell(contract.getData()); }
fun RemintStorage.save(self) { contract.setData(self.toCell()); }
fun remint_bucket(): int {
    val config = blockchain.configParam(19);
    if (config != null) {
        var body = config!.beginParse();
        if (body.remainingBitsCount() == 32 && body.remainingRefsCount() == 0 && body.loadInt(32) == -3) { return 600; }
    }
    return 86400;
}
fun RemintStorage.roll(mutate self) {
    val today = blockchain.now() / remint_bucket();
    if (today > self.day) {
        self.burnedYesterday = today == self.day + 1 ? self.burnedToday : 0;
        self.burnedToday = 0; self.minted = false; self.day = today as uint32;
    }
}
fun remint_keep(): coins { return calculateStorageFee(BASECHAIN, RM_RENT_SECONDS, 65536, 128); }
fun remint_minter_keep(): coins {
    // Covers even the largest valid account; no metadata-size oracle is assumed.
    return calculateStorageFee(BASECHAIN, RM_RENT_SECONDS, 65536 * 1023, 65536);
}
fun remint_burn_value(): coins {
    return 2 * calculateForwardFee(BASECHAIN, 754, 1) + calculateGasFee(BASECHAIN, 4254)
        + calculateGasFee(BASECHAIN, 4071) + 1;
}
fun remint_mint_leg(): coins { return jetton_leg_value(JETTON_V21_WALLET_GAS, 0, jetton_standard_budget(JETTON_V21_WALLET_GAS).load(), jetton_notify_value(), 512, 1, 0); }
fun remint_mint_value(): coins {
    return remint_keep() + calculateGasFee(BASECHAIN, RM_MINT_GAS) + calculateForwardFee(BASECHAIN, 1400, 2)
        + calculateForwardFee(BASECHAIN, 400, 1) + calculateGasFee(BASECHAIN, RM_MINTER_MINT_GAS)
        + calculateForwardFee(BASECHAIN, RM_WALLET_DEPLOY_BITS, RM_WALLET_DEPLOY_CELLS)
        + RM_MINTER_RESERVE + remint_minter_keep() + remint_mint_leg();
}
fun remint_rate_value(): coins {
    return calculateGasFee(BASECHAIN, RM_RATE_GAS) + calculateForwardFee(BASECHAIN, 400, 1);
}
fun RemintStorage.log(self, kind: uint8, amount: coins) {
    createExternalLogMessage({ dest: createAddressNone(), body: RemintEvent { kind, day: self.day, amount, rateBps: self.rateBps } })
        .send(SEND_MODE_IGNORE_ERRORS);
}
fun remint_reserve(value: coins, keep: coins) {
    reserveGramsOnBalance(contract.getOriginalBalance() - value + keep,
        RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = RemintStorage.load();
    if (in.senderAddress != st.jetton.load().slots.mustGet(0).master) { return; }
    val mint = jetton_v21_try_parse_bounced_mint(in.bouncedBody);
    if (mint == null || mint.recipient != st.cfg.load().emissionsSplitter) { return; }
    st.roll();
    if (mint.queryId + 1 == st.day && st.minted) {
        st.minted = false; st.save(); st.log(3, mint.amount);
        jetton_bounce_excess(mint.responseTo, mint.queryId, in.valueCoins, 0);
    } else { st.save(); }
}

fun on_take(sender: address, body: slice) {
    var st = RemintStorage.load();
    var ledger = st.jetton.load();
    val take = ledger.checkTake(sender, body);
    if (take == null) { return; }
    val cfg = st.cfg.load();
    if (take.wallet == cfg.governance || take.wallet == cfg.emissionsSplitter) { return; }
    ledger.commitTake(take); st.jetton = ledger.toCell(); st.save(); return;
}

fun on_credit(sender: address, value: coins, body: slice) {
    var st = RemintStorage.load();
    val ledger = st.jetton.load();
    val credit = ledger.onNotification(sender, body);
    if (credit == null) { return; }
    st.roll(); st.burnedToday += credit.amount; st.save();
    val need = calculateGasFee(BASECHAIN, getGasConsumedAtTheMoment() + RM_TAIL_GAS)
        + calculateForwardFee(BASECHAIN, 400, 1) + remint_keep() + remint_burn_value();
    val burnNow = value >= need;
    reserveGramsOnBalance(max(contract.getOriginalBalance() - value, 0) + (burnNow ? remint_keep() : 0 as coins), RESERVE_MODE_AT_MOST);
    st.log(1, credit.amount);
    if (burnNow) {
        ledger.sendBurn(0, 0, credit.amount, null, 0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
    }
    return;
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    assert (in.body.remainingBitsCount() >= 32) throw ERR_GOVERNANCE_CONFIG;
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { on_take(in.senderAddress, in.body); return; }
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit(in.senderAddress, in.valueCoins, in.body); return; }
    var st = RemintStorage.load();
    var ledger = st.jetton.load();
    if (op == OP_REMINT_CLAIM_ADMIN) {
        val msg = RemintClaimAdmin.fromSlice(in.body);
        createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: ledger.slots.mustGet(0).master, value: 0,
            body: beginCell().storeUint(OP_JETTON_CLAIM_ADMIN, 32).storeUint(msg.queryId, 64).endCell() })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    if (op == OP_REMINT_RATE) {
        val msg = RemintRate.fromSlice(in.body);
        assert (in.senderAddress == st.cfg.load().governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
        assert (in.valueCoins >= remint_rate_value()) throw ERR_JETTON_VALUE;
        assert (msg.mode == 0 && msg.rateBps <= st.rateBps && st.rateBps <= 9000) throw ERR_GOVERNANCE_CONFIG;
        st.rateBps = msg.rateBps; st.save(); st.log(4, 0); return;
    }
    if (op == OP_REMINT_BURN) {
        val msg = RemintBurn.fromSlice(in.body);
        assert (ledger.coreReady() && msg.amount > 0) throw ERR_GOVERNANCE_CONFIG;
        assert (in.valueCoins >= calculateGasFee(BASECHAIN, RM_BURN_GAS) + remint_burn_value()) throw ERR_JETTON_VALUE;
        ledger.sendBurn(0, msg.queryId, msg.amount, in.senderAddress, 0,
            SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    if (op == OP_REMINT_DAY) {
        val msg = RemintDay.fromSlice(in.body);
        val need = remint_mint_value();
        assert (in.valueCoins >= need) throw ERR_JETTON_VALUE;
        st.roll();
        val amount = st.burnedYesterday * st.rateBps / 10000;
        assert (!st.minted && amount > 0) throw ERR_GOVERNANCE_CONFIG;
        st.minted = true; st.save(); st.log(2, amount);
        remint_reserve(in.valueCoins, remint_keep());
        val master = ledger.slots.mustGet(0).master;
        createMessage({ bounce: BounceMode.RichBounce, dest: master, value: 0,
            body: jetton_v21_mint_body(st.day - 1, st.cfg.load().emissionsSplitter, remint_mint_leg() + in.valueCoins - need,
                amount, in.senderAddress, jetton_notify_value()) })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body);
        assert (in.valueCoins >= ledger.minDiscover()) throw ERR_JETTON_VALUE;
        ledger.discover(); remint_reserve(in.valueCoins, 0);
        createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0, body: createEmptyCell() })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    throw ERR_GOVERNANCE_CONFIG;
}

get fun get_remint(): (cell, cell, int, int, int, int, bool) {
    val st = RemintStorage.load();
    return (st.jetton, st.cfg, st.rateBps, st.day, st.burnedToday, st.burnedYesterday, st.minted);
}
get fun get_min_forward(): coins {
    return calculateGasFee(BASECHAIN, RM_BURN_GAS + RM_TAIL_GAS) + calculateForwardFee(BASECHAIN, 400, 1)
        + remint_keep() + remint_burn_value();
}
get fun get_mint_value(): coins { return remint_mint_value(); }
get fun get_min_value(op: uint32): coins {
    assert (op == OP_REMINT_RATE) throw ERR_GOVERNANCE_CONFIG;
    return remint_rate_value();
}
get fun get_burn_value(): coins { return calculateGasFee(BASECHAIN, RM_BURN_GAS) + remint_burn_value(); }
get fun get_params(): int { return remint_bucket(); }
get fun get_jetton_slots(): map<uint8, JettonSlot> { return RemintStorage.load().jetton.load().slots; }
get fun get_jetton_liabilities(slot: uint8): coins { return 0; }
get fun get_min_discover(): coins { return RemintStorage.load().jetton.load().minDiscover(); }
get fun get_keep(): (coins, coins) { return (remint_keep(), remint_minter_keep()); }
