tolk 1.5.0

// Shared wallet discovery, authenticated credits, direct owed books and durable archive claims.
import "@gen/op/tep";
import "@stdlib/gas-payments"
import "@stdlib/exotic-cells"
import "tep74_codec"
import "jetton_quotes"
import "owed_archive"
import "tep89_codec"
import "../utils/rich_bounce"
import "../utils/error_codes"
import "@gen/op/jetton"
import "@gen/op/restricted_owed_claim_receipt"

const JETTON_MAX_COINS = (1 << 120) - 1

struct (0x44534357) DiscoverWallets { queryId: uint64 }
struct (0x434c4d4a) ClaimOwed { queryId: uint64; slot: uint8; owner: address }
struct (0x434c4d41) ClaimArchived { queryId: uint64; slot: uint8; id: uint64; owner: address; amount: coins; proof: cell }
struct (0x4a415243) OwedArchived { slot: uint8; id: uint64; owner: address; amount: coins }
struct (0x4a434c52) OwedClaimReceipt {}
struct (0x4a4f5743) OwedCredited { slot: uint8; owner: address; amount: coins; reason: uint8 }


struct JettonSlot {
    master: address
    wallet: address?
    walletGas: uint32
    walletGram: coins      // a floor in GRAM for wallets that do not price themselves in gas (0 = none)
    optional: bool
    budget: Cell<JettonWalletBudget>
}

struct OwedBook {
    total: coins              // direct entries plus archive liabilities
    count: uint16             // direct owners only
    entries: map<address, coins>
    archive: Cell<OwedArchive>?
}

struct JettonLedger {
    slots: map<uint8, JettonSlot>
    owed: map<uint8, OwedBook>
}

struct JettonTake {
    idx: uint8
    wallet: address
}

struct JettonCredit {
    slot: uint8
    queryId: uint64
    amount: coins
    from: address
    payloadOk: bool
    claimReceipt: bool
    payload: slice
}

struct JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    excessTo: address
    forwardGram: coins
    forwardPayload: cell?
}

struct JettonBounce {
    kind: uint8           // 0 NONE, 1 TRANSFER, 2 BURN
    slot: uint8
    queryId: uint64
    amount: coins
    destination: address?
    excessTo: address?
    claimReceipt: bool
    payloadTag: uint32
    payload: cell?
    exitCode: int32
    bouncedByPhase: uint8
    originalLt: uint64
}

struct JettonRefund {
    forwardGram: coins
    payload: cell?
    payloadBits: uint16
    payloadCells: uint8
    plain: bool           // allow a refund without forward GRAM and payload when the full one is not affordable
    keep: coins           // GRAM that stays in the holder (tips)
    spent: coins          // GRAM the holder commits to optional +2 sends in this transaction
    bounceGas: uint32
    tailGas: uint32       // gas still to be used after the plan is computed
    owedCap: uint16
}

struct JettonRefundPlan {
    result: uint8         // 0 NOTHING, 1 REFUND, 2 REFUND_PLAIN, 3 OWED
    dst: address?
}

// ---- value quotes (run-time priced) ----

fun JettonLedger.jetton_min_claim(self, slot: uint8, bounceGas: int): coins {
    return calculateGasFee(BASECHAIN, JETTON_CLAIM_GAS)
        + self.legValue(slot, jetton_notify_value(), 32, 1, bounceGas);
}

// prefixGas bounds work before refundPlan reads the counter; tailGas is additional.
fun JettonLedger.jetton_min_archive_claim(self, slot: uint8, bounceGas: int): coins {
    return calculateGasFee(BASECHAIN, JETTON_ARCHIVE_CLAIM_GAS)
        + self.legValue(slot, jetton_notify_value(), 32, 1, bounceGas);
}

fun JettonLedger.refundFloor(self, slot: uint8, r: JettonRefund, prefixGas: int): coins {
    return r.keep + r.spent + calculateGasFee(BASECHAIN, prefixGas + r.tailGas)
        + self.legValue(slot, r.forwardGram, r.payloadBits, r.payloadCells, r.bounceGas);
}

// ---- slots ----

// returns (slot index or -1, every non-optional slot READY)
fun JettonLedger.lookup(self, sender: address): (int, bool) {
    var found = -1;
    var all = true;
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.wallet == null) { if (!s.optional) { all = false; } }
        else if (s.wallet == sender) { found = e.getKey(); }
        e = self.slots.iterateNext(e);
    }
    return (found, all);
}

fun JettonLedger.pendingCount(self): int {
    var n = 0;
    var e = self.slots.findFirst();
    while (e.isFound) {
        if (e.loadValue().wallet == null) { n += 1; }
        e = self.slots.iterateNext(e);
    }
    return n;
}

// std wc0, not this contract, not one of its slot wallets or masters
fun JettonLedger.canPay(self, a: address): bool {
    if (a.getWorkchain() != BASECHAIN || a == contract.getAddress()) { return false; }
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.master == a) { return false; }
        if (s.wallet != null && s.wallet == a) { return false; }
        e = self.slots.iterateNext(e);
    }
    return true;
}

// Validate a swap's recipient and refund destination in one slot walk.
fun JettonLedger.canPayPair(self, a: address, b: address): bool {
    if (a.getWorkchain() != BASECHAIN || b.getWorkchain() != BASECHAIN
        || a == contract.getAddress() || b == contract.getAddress()) { return false; }
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.master == a || s.master == b) { return false; }
        if (s.wallet != null && (s.wallet == a || s.wallet == b)) { return false; }
        e = self.slots.iterateNext(e);
    }
    return true;
}

fun JettonLedger.coreReady(self): bool {
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.wallet == null && !s.optional) { return false; }
        e = self.slots.iterateNext(e);
    }
    return true;
}

fun JettonLedger.legValue(self, slot: uint8, forwardGram: coins, payloadBits: int, payloadCells: int, bounceGas: int): coins {
    val s = self.slots.mustGet(slot, ERR_JETTON_SLOT);
    return jetton_leg_value(s.walletGas, s.walletGram, s.budget.load(), forwardGram, payloadBits, payloadCells, bounceGas);
}

fun JettonLedger.discover(self) {
    val coreReady = self.coreReady();
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.wallet == null && (!s.optional || coreReady)) {
            val body = tep89_provide_body(e.getKey() as uint64, contract.getAddress());
            createMessage({ bounce: BounceMode.Only256BitsOfBody, value: jetton_discover_value(s.walletGram), dest: s.master, body: body })
                .send(SEND_MODE_REGULAR);
        }
        e = self.slots.iterateNext(e);
    }
}

fun JettonLedger.checkTake(self, sender: address, body: slice): JettonTake? {
    val t = tep89_try_parse_take(body);
    if (t == null || t.queryId > 255 || t.owner != contract.getAddress()) { return null; }
    val r = self.slots.get(t.queryId as uint8);
    if (!r.isFound) { return null; }
    val s = r.loadValue();
    if (s.master != sender || s.wallet != null || (s.optional && !self.coreReady()) || !self.canPay(t.wallet)) { return null; }
    return { idx: t.queryId as uint8, wallet: t.wallet };
}

fun JettonLedger.commitTake(mutate self, t: JettonTake) {
    val r = self.slots.get(t.idx);
    if (!r.isFound) { return; }
    var s = r.loadValue();
    // Only an immediately checked take reaches this mutation. Repeating the
    // full-slot peer/core scans would charge the same authenticated reply twice.
    if (s.wallet != null) { return; }
    s.wallet = t.wallet;
    self.slots.set(t.idx, s);
}

// ---- notifications ----

fun jetton_parse_notification(slot: uint8, body: slice): JettonCredit? {
    val n = tep74_try_parse_notification(body);
    if (n == null) { return null; }
    val receipt = n.payloadOk && n.payload.remainingBitsCount() == 32 && n.payload.remainingRefsCount() == 0
        && n.payload.preloadUint(32) == OP_OWED_CLAIM_RECEIPT;
    return { slot, queryId: n.queryId, amount: n.amount, from: n.from,
        payloadOk: n.payloadOk, claimReceipt: receipt, payload: n.payload };
}

fun JettonLedger.onNotification(self, sender: address, body: slice): JettonCredit? {
    val (slot, all) = self.lookup(sender);
    if (slot < 0 || !all) { return null; }
    val n = jetton_parse_notification(slot as uint8, body);
    if (n == null) { return null; }
    if (n.from == contract.getAddress() || n.amount == 0) { return null; }
    return n;
}

// ---- sends ----

fun tep74_transfer_body(t: JettonTransfer): builder {
    return tep74_transfer_body_from(t.queryId, t.amount, t.destination, t.excessTo, t.forwardGram, t.forwardPayload);
}

// private to jetton_slots.tolk and jetton_sweep.tolk (static gate)
fun jetton_send_raw(wallet: address, t: JettonTransfer, value: coins, mode: int) {
    createMessage({ bounce: BounceMode.RichBounce, value: value, dest: wallet, body: tep74_transfer_body(t) }).send(mode);
}

fun JettonLedger.sendTransfer(self, slot: uint8, t: JettonTransfer, value: coins, mode: int) {
    assert (self.canPay(t.destination) && jetton_is_payable(t.excessTo)) throw ERR_JETTON_DEST;
    val s = self.slots.mustGet(slot, ERR_JETTON_SLOT);
    assert (s.wallet != null) throw ERR_JETTON_SLOT;
    jetton_send_raw(s.wallet!, t, value, mode);
}

fun jetton_log_owed(slot: uint8, owner: address, amount: coins, reason: uint8) {
    createExternalLogMessage({ dest: createAddressNone(),
        body: beginCell().storeUint(OP_OWED_CREDITED, 32).storeUint(slot, 8).storeAddress(owner).storeCoins(amount).storeUint(reason, 8) })
        .send(SEND_MODE_IGNORE_ERRORS);
}

// ---- bounces ----

fun jetton_bounce_none(): JettonBounce {
    return { kind: 0, slot: 0, queryId: 0, amount: 0, destination: null, excessTo: null, claimReceipt: false, payloadTag: 0, payload: null, exitCode: 0, bouncedByPhase: 0, originalLt: 0 };
}

fun JettonLedger.onBounce(self, sender: address, bouncedBody: slice): JettonBounce {
    val (slot, _) = self.lookup(sender);
    if (slot < 0 || !rich_bounce_is_canonical(bouncedBody)) { return jetton_bounce_none(); }
    val rich = RichBounceBody.fromSlice(bouncedBody);
    var (c, exotic) = rich.originalBody.beginParseSpecial();
    if (exotic || c.remainingBitsCount() < 96) { return jetton_bounce_none(); }
    val op = c.loadUint(32);
    val queryId = c.loadUint(64) as uint64;
    val amount = c.tryLoadCoins();
    if (amount == null) { return jetton_bounce_none(); }
    if (op == OP_TEP74_BURN) {
        var excessTo: address? = null;
        if (c.remainingBitsCount() >= 2 && c.preloadUint(2) == 0) { c.skipBits(2); }
        else {
            excessTo = c.tryLoadStdAddress();
            if (excessTo == null) { return jetton_bounce_none(); }
        }
        if (c.remainingBitsCount() != 1 || c.remainingRefsCount() != 0 || c.loadBool()) { return jetton_bounce_none(); }
        return { kind: 2, slot: slot as uint8, queryId, amount, destination: null, excessTo,
            claimReceipt: false, payloadTag: 0, payload: null, exitCode: rich.exitCode, bouncedByPhase: rich.bouncedByPhase, originalLt: rich_bounce_original_lt(rich.originalInfo) };
    }
    if (op != OP_TEP74_TRANSFER) { return jetton_bounce_none(); }
    val destination = c.tryLoadStdAddress();
    val excessTo = c.tryLoadStdAddress();
    if (destination == null || excessTo == null || !self.canPay(destination)
        || c.remainingBitsCount() < 1 || c.loadBool()) { return jetton_bounce_none(); }
    val forwardGram = c.tryLoadCoins();
    if (forwardGram == null || c.remainingBitsCount() < 1) { return jetton_bounce_none(); }
    var tag = 0;
    var receipt = false;
    var payload: cell? = null;
    if (c.loadBool()) {
        if (c.remainingBitsCount() != 0 || c.remainingRefsCount() != 1) { return jetton_bounce_none(); }
        payload = c.loadRef();
        val (ps, exoticPayload) = payload!.beginParseSpecial();
        if (exoticPayload) { return jetton_bounce_none(); }
        if (ps.remainingBitsCount() >= 32) { tag = ps.preloadUint(32); }
        receipt = tag == OP_OWED_CLAIM_RECEIPT && ps.remainingBitsCount() == 32 && ps.remainingRefsCount() == 0;
    } else {
        if (c.remainingBitsCount() >= 32) { tag = c.preloadUint(32); }
        receipt = tag == OP_OWED_CLAIM_RECEIPT && c.remainingBitsCount() == 32 && c.remainingRefsCount() == 0;
    }
    return { kind: 1, slot: slot as uint8, queryId, amount, destination, excessTo,
        claimReceipt: receipt, payloadTag: tag as uint32, payload,
        exitCode: rich.exitCode, bouncedByPhase: rich.bouncedByPhase, originalLt: rich_bounce_original_lt(rich.originalInfo) };
}

// ---- owed ----

fun JettonLedger.book(self, slot: uint8): OwedBook {
    val br = self.owed.get(slot);
    if (br.isFound) { return br.loadValue(); }
    return { total: 0, count: 0, entries: [], archive: null };
}
fun OwedBook.archiveRoom(self): bool {
    return self.archive == null || self.archive!.load().count < OWED_ARCHIVE_LIMIT;
}
fun JettonLedger.owedCanCredit(self, slot: uint8, amount: coins, cap: int): bool {
    if (amount <= 0 || cap <= 0 || cap > 32767 || !self.slots.exists(slot)) { return false; }
    val book = self.book(slot);
    return book.total <= JETTON_MAX_COINS - amount && (book.count < cap || book.archiveRoom());
}

// 0 refused, 1 direct update, 2 new direct owner, 3 archived; second result is retained storage funding.
// At the direct cap skip the address trie entirely, including for an existing direct owner.
fun JettonLedger.owedCredit(mutate self, slot: uint8, owner: address, amount: coins, cap: int): (int, coins) {
    if (!self.canPay(owner) || !self.owedCanCredit(slot, amount, cap)) { return (0, 0); }
    var book = self.book(slot); var result = 1; var keep: coins = 0;
    if (book.count < cap) {
        val er = book.entries.get(owner); val prev: coins = er.isFound ? er.loadValue() : 0;
        if (!er.isFound) { book.count += 1; result = 2; keep = jetton_owed_rent(); }
        book.entries.set(owner, prev + amount);
    } else {
        var archive = book.archive != null ? book.archive!.load() : OwedArchive { count: 0, root: 0, total: 0, frontier: [] };
        if (archive.count == 0) { keep = jetton_recovery_rent(); }
        else {
            val next = archive.count + 1;
            if (next < OWED_ARCHIVE_LIMIT && (next & (next - 1)) == 0) { keep = jetton_owed_rent(); }
        }
        val id = archive.append(slot, owner, amount); book.archive = archive.toCell(); result = 3;
        createExternalLogMessage({ dest: createAddressNone(), body: OwedArchived { slot, id, owner, amount } }).send(SEND_MODE_IGNORE_ERRORS);
    }
    book.total += amount; self.owed.set(slot, book); return (result, keep);
}
fun JettonLedger.owedOf(self, slot: uint8, owner: address): coins {
    val br = self.owed.get(slot); if (!br.isFound) { return 0; }
    val er = br.loadValue().entries.get(owner); return er.isFound ? er.loadValue() : 0;
}
fun JettonLedger.owedTotal(self, slot: uint8): coins { return self.book(slot).total; }
fun JettonLedger.owedCount(self, slot: uint8): int { return self.book(slot).count; }
fun JettonLedger.owedArchive(self, slot: uint8): (uint65, uint256, coins) {
    val book = self.book(slot);
    if (book.archive == null) { return (0, owed_archive_empty_root(), 0); }
    val archive = book.archive!.load(); return (archive.count, archive.root, archive.total);
}
// Conservative unique-cell bounds, including all admitted slots and full archive frontiers.
fun JettonLedger.owedStorageBounds(self): (int, int) {
    var bits = 0; var cells = 0;
    var item = self.owed.findFirst();
    while (item.isFound) {
        val book = item.loadValue(); bits += 600 * book.count; cells += 2 * book.count;
        if (book.archive != null) { bits += 18000; cells += 130; }
        item = self.owed.iterateNext(item);
    }
    return (bits, cells);
}

fun JettonLedger.owedTake(mutate self, slot: uint8, owner: address): coins {
    val br = self.owed.get(slot); if (!br.isFound) { return 0; }
    var book = br.loadValue(); val er = book.entries.get(owner); if (!er.isFound) { return 0; }
    val amount = er.loadValue(); book.entries.delete(owner); book.total -= amount; book.count -= 1;
    self.owed.set(slot, book); return amount;
}

fun jetton_claim_receipt(): cell { return beginCell().storeUint(OP_OWED_CLAIM_RECEIPT, 32).endCell(); }

// Plain operation: throws (and bounces) when nothing can be paid. Pays the stored owner; GRAM excess returns to the claimer.
fun JettonLedger.claim(mutate self, slot: uint8, owner: address, queryId: uint64, sender: address, inValue: coins, ownerOnly: bool, bounceGas: int, keep: coins) {
    val s = self.slots.mustGet(slot, ERR_JETTON_SLOT);
    assert (s.wallet != null) throw ERR_JETTON_SLOT;
    assert (jetton_is_payable(sender)) throw ERR_JETTON_DEST;
    assert (!ownerOnly || sender == owner) throw ERR_JETTON_NOT_OWNER;
    assert (inValue >= self.jetton_min_claim(slot, bounceGas) + keep) throw ERR_JETTON_VALUE;
    val amount = self.owedTake(slot, owner);
    assert (amount > 0) throw ERR_JETTON_NOTHING_OWED;
    val receipt = jetton_claim_receipt();
    reserveGramsOnBalance(max(contract.getOriginalBalance() - inValue, 0) + keep, RESERVE_MODE_AT_MOST);
    jetton_send_raw(s.wallet!, { queryId, amount, destination: owner, excessTo: sender,
        forwardGram: sender == owner ? 0 : jetton_notify_value(), forwardPayload: receipt }, 0,
        SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// The proof changes no authority: the exact committed owner is the only payout destination.
fun JettonLedger.claimArchived(mutate self, msg: ClaimArchived, sender: address, inValue: coins, ownerOnly: bool, bounceGas: int, keep: coins) {
    val slot = self.slots.mustGet(msg.slot, ERR_JETTON_SLOT);
    assert (slot.wallet != null && self.canPay(msg.owner) && jetton_is_payable(sender)) throw ERR_JETTON_DEST;
    assert (!ownerOnly || sender == msg.owner) throw ERR_JETTON_NOT_OWNER;
    assert (inValue >= self.jetton_min_archive_claim(msg.slot, bounceGas) + keep) throw ERR_JETTON_VALUE;
    var book = self.book(msg.slot); assert (book.archive != null) throw ERR_JETTON_NOTHING_OWED;
    var archive = book.archive!.load(); archive.consume(msg.slot, msg.id, msg.owner, msg.amount, msg.proof);
    book.archive = archive.toCell(); book.total -= msg.amount; self.owed.set(msg.slot, book);
    reserveGramsOnBalance(max(contract.getOriginalBalance() - inValue, 0) + keep, RESERVE_MODE_AT_MOST);
    jetton_send_raw(slot.wallet!, { queryId: msg.queryId, amount: msg.amount, destination: msg.owner, excessTo: sender,
        forwardGram: sender == msg.owner ? 0 : jetton_notify_value(), forwardPayload: jetton_claim_receipt() }, 0,
        SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// The returned GRAM of a bounce goes on to excessTo; `keep` stays (never more than the bounce returned).
fun jetton_bounce_excess(excessTo: address?, queryId: uint64, inValue: coins, keep: coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance() - inValue, 0) + min(keep, inValue), RESERVE_MODE_AT_MOST);
    if (excessTo != null && excessTo! != contract.getAddress()) {
        createMessage({ bounce: BounceMode.NoBounce, value: 0, dest: excessTo!, body: beginCell().storeUint(OP_TEP74_EXCESSES, 32).storeUint(queryId, 64) })
            .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
    }
}

// Canonical own-wallet refusal creates exact debt; the owner cap never discards it.
// Finite numeric exhaustion and a missing or underfunded bounce remain explicit limits.
fun JettonLedger.bounceToOwed(mutate self, b: JettonBounce, beneficiary: address, inValue: coins, owedCap: int): int {
    if (b.kind != 1 || b.destination == null) { return 0; }
    val who = b.claimReceipt ? b.destination! : beneficiary;
    val (res, keep) = self.owedCredit(b.slot, who, b.amount, owedCap);
    jetton_log_owed(b.slot, who, b.amount, res == 0 ? 255 : 3);
    jetton_bounce_excess(b.excessTo, b.queryId, inValue, keep);
    return res;
}

// ---- refund or owe ----

// Pure. The holder may send its own optional (+2) messages between plan and apply; their cost is r.spent.
fun JettonLedger.refundPlan(self, c: JettonCredit, to: address, inValue: coins, r: JettonRefund): JettonRefundPlan {
    if (c.claimReceipt) { return { result: 0, dst: null }; }
    var dst = to;
    if (!self.canPay(dst)) { dst = c.from; }
    if (!self.canPay(dst)) { return { result: 0, dst: null }; }
    val sr = self.slots.get(c.slot);
    if (!sr.isFound) { return { result: 0, dst: null }; }
    val s = sr.loadValue();
    if (s.wallet == null) { return { result: 0, dst: null }; }
    val g = calculateGasFee(BASECHAIN, getGasConsumedAtTheMoment() + r.tailGas);
    val base = r.keep + r.spent + g;
    if (inValue >= base + jetton_leg_value(s.walletGas, s.walletGram, s.budget.load(), r.forwardGram, r.payloadBits, r.payloadCells, r.bounceGas)) { return { result: 1, dst }; }
    if (r.plain && inValue >= base + jetton_leg_value(s.walletGas, s.walletGram, s.budget.load(), 0, 0, 0, r.bounceGas)) { return { result: 2, dst }; }
    if (self.owedCanCredit(c.slot, c.amount, r.owedCap) && inValue >= r.spent + g + jetton_recovery_rent()) { return { result: 3, dst }; }
    return { result: 0, dst: null };
}

fun JettonLedger.refundApply(mutate self, c: JettonCredit, p: JettonRefundPlan, inValue: coins, r: JettonRefund, reason: uint8) {
    if (p.dst == null || !self.canPay(p.dst!)) { return; }
    val sr = self.slots.get(c.slot);
    if (!sr.isFound || sr.loadValue().wallet == null) { return; }
    if (p.result == 1 || p.result == 2) {
        reserveGramsOnBalance(max(contract.getOriginalBalance() - inValue, 0) + r.keep, RESERVE_MODE_AT_MOST);
        self.sendTransfer(c.slot, { queryId: c.queryId, amount: c.amount, destination: p.dst!, excessTo: p.dst!,
            forwardGram: p.result == 1 ? r.forwardGram : 0, forwardPayload: p.result == 1 ? r.payload : null }, 0, SEND_MODE_CARRY_ALL_BALANCE);
        return;
    }
    if (p.result == 3) {
        self.owedCredit(c.slot, p.dst!, c.amount, r.owedCap);
        jetton_log_owed(c.slot, p.dst!, c.amount, reason);
    }
}

fun JettonLedger.refundOrOwe(mutate self, c: JettonCredit, to: address, inValue: coins, r: JettonRefund, reason: uint8): uint8 {
    val p = self.refundPlan(c, to, inValue, r);
    self.refundApply(c, p, inValue, r, reason);
    return p.result;
}

fun JettonLedger.slotAdd(mutate self, i: uint8, master: address, walletGas: uint32, walletGram: coins, optional: bool, budget: Cell<JettonWalletBudget>) {
    assert (!self.slots.exists(i) && self.canPay(master) && walletGas >= 10000 && walletGas <= 500000
        && walletGram <= grams("0.5") && jetton_budget_valid(budget.load(), walletGas)) throw ERR_JETTON_SLOT;
    var count = 0;
    var pendingOptional = false;
    var e = self.slots.findFirst();
    while (e.isFound) {
        count += 1;
        val s = e.loadValue();
        if (s.optional && s.wallet == null) { pendingOptional = true; }
        e = self.slots.iterateNext(e);
    }
    assert (count < 16 && (optional || count == 0 || !self.coreReady())
        && (!optional || !pendingOptional)) throw ERR_JETTON_SLOT;
    self.slots.set(i, { master, wallet: null, walletGas, walletGram, optional, budget });
}

fun JettonLedger.minDiscover(self): coins {
    var value = calculateGasFee(BASECHAIN, JETTON_DSCW_GAS);
    val coreReady = self.coreReady();
    var e = self.slots.findFirst();
    while (e.isFound) {
        val s = e.loadValue();
        if (s.wallet == null && (!s.optional || coreReady)) { value += jetton_discover_value(s.walletGram); }
        e = self.slots.iterateNext(e);
    }
    return value;
}

fun JettonLedger.burnValue(self, slot: uint8, hubValue: coins, bounceGas: int): coins {
    val s = self.slots.mustGet(slot, ERR_JETTON_SLOT); val p = s.budget.load();
    // hubValue includes its own compute, rent and payouts. Count the profile's
    // baseline hub compute once; failed hub actions cannot commit those payouts.
    val extra = max(hubValue - calculateGasFee(BASECHAIN, p.burnWalletGas - p.senderGas), 0);
    return jetton_leg_value(p.burnWalletGas, s.walletGram, p, extra, 0, 0, bounceGas);
}

fun JettonLedger.sendBurn(self, slot: uint8, queryId: uint64, amount: coins, responseTo: address?, value: coins, mode: int) {
    assert (responseTo == null || jetton_is_payable(responseTo!)) throw ERR_JETTON_DEST;
    val s = self.slots.mustGet(slot, ERR_JETTON_SLOT);
    assert (s.wallet != null) throw ERR_JETTON_SLOT;
    createMessage({ bounce: BounceMode.RichBounce, value, dest: s.wallet!, body: tep74_burn_body(queryId, amount, responseTo) }).send(mode);
}
