tolk 1.5.0

import "@stdlib/gas-payments";
import "@stdlib/exotic-cells";
import "../shared/utils/error_codes";
import "@gen/op/referral";

const REFERRAL_MAX_LINKS = 24576;
const REFERRAL_LINK_PRICE = 50000000;
const REFERRAL_LINK_GAS = 260000;
const REFERRAL_QUERY_GAS = 140000;

struct ReferralRegistryStorage {
    instance: uint64;
    linkCount: uint32;
    links: map<address, address>;
}
struct (0x52524c4b) ReferralLink { queryId: uint64; sponsor: address }
struct (0x52525551) ReferralUplineQuery { queryId: uint64; user: address; echo: cell }
struct ReferralAncestors { l1: address?; l2: address?; l3: address? }
struct (0x52525552) ReferralUpline { queryId: uint64; user: address; upline: Cell<ReferralAncestors>; echo: cell }

fun ReferralRegistryStorage.load(): ReferralRegistryStorage { return ReferralRegistryStorage.fromCell(contract.getData()); }
fun ReferralRegistryStorage.sponsor(self, owner: address?): address? {
    if (owner == null) { return null; }
    val found = self.links.get(owner!); return found.isFound ? found.loadValue() : null;
}
fun ReferralRegistryStorage.upline(self, owner: address): ReferralAncestors {
    val l1 = self.sponsor(owner); val l2 = self.sponsor(l1);
    return { l1, l2, l3: self.sponsor(l2) };
}
fun referral_min_value(op: int): coins {
    assert (op == OP_REFERRAL_LINK || op == OP_REFERRAL_UPLINE_QUERY) throw ERR_REFERRAL_UNKNOWN;
    if (op == OP_REFERRAL_LINK) {
        return REFERRAL_LINK_PRICE + calculateGasFee(BASECHAIN, REFERRAL_LINK_GAS) + calculateForwardFee(BASECHAIN, 700, 1);
    }
    return calculateGasFee(BASECHAIN, REFERRAL_QUERY_GAS) + calculateForwardFee(BASECHAIN, 3100, 4);
}
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    val op = in.body.preloadUint(32);
    assert (in.senderAddress.getWorkchain() == BASECHAIN && in.valueCoins >= referral_min_value(op)) throw ERR_REFERRAL_VALUE;
    var st = ReferralRegistryStorage.load();
    if (op == OP_REFERRAL_LINK) {
        val msg = ReferralLink.fromSlice(in.body);
        assert (msg.sponsor.getWorkchain() == BASECHAIN && msg.sponsor != in.senderAddress) throw ERR_REFERRAL_CYCLE;
        assert (st.linkCount < REFERRAL_MAX_LINKS) throw ERR_REFERRAL_FUNDS;
        val parent = st.sponsor(msg.sponsor);
        val grandparent = st.sponsor(parent);
        assert ((parent == null || parent! != in.senderAddress) && (grandparent == null || grandparent! != in.senderAddress)) throw ERR_REFERRAL_CYCLE;
        assert (st.links.addIfNotExists(in.senderAddress, msg.sponsor)) throw ERR_REFERRAL_ALREADY_SET;
        st.linkCount += 1; contract.setData(st.toCell());
        reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0) + REFERRAL_LINK_PRICE,
            RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
        createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0 })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    val msg = ReferralUplineQuery.fromSlice(in.body);
    val (echo, exotic) = msg.echo.beginParseSpecial();
    assert (msg.user.getWorkchain() == BASECHAIN && !exotic && echo.remainingRefsCount() == 0) throw ERR_REFERRAL_UNKNOWN;
    createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0,
        body: ReferralUpline { queryId: msg.queryId, user: msg.user, upline: st.upline(msg.user).toCell(), echo: msg.echo } })
        .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}
fun onBouncedMessage(in: InMessageBounced) {}
get fun get_sponsor(user: address): address? { return ReferralRegistryStorage.load().sponsor(user); }
get fun get_upline(user: address): (address?, address?, address?) {
    val a = ReferralRegistryStorage.load().upline(user); return (a.l1, a.l2, a.l3);
}
get fun get_link_count(): (int, int) { return (ReferralRegistryStorage.load().linkCount, REFERRAL_MAX_LINKS); }
get fun get_min_value(op: uint32): coins { return referral_min_value(op); }
