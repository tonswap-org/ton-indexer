tolk 1.5.0

import "../shared/jetton/jetton_quotes";

import "@stdlib/exotic-cells";
import "@gen/op/dlmm";
import "./constants";
import "./pool_state_init";
import "../shared/jetton/tep74_codec";

// This is also used on credited notifications: no decoder is allowed to throw.
fun pool_open(c: cell): slice? {
    val (s, exotic) = c.beginParseSpecial();
    return exotic ? null : s;
}

// Both row kinds have a fixed tail, making the declared length unambiguous.
fun pool_rows_valid(head: cell, count: int, adding: bool, credited: coins): bool {
    if (count < 1 || count > (adding ? MAX_LIQ_ADD_BINS : MAX_LIQ_REMOVE_BINS)) { return false; }
    var next = head;
    var previous = -2147483649;
    var remaining: int = credited;
    var left = count;
    while (left > 0) {
        val opened = pool_open(next);
        if (opened == null) { return false; }
        var s = opened;
        if (s.remainingBitsCount() < 32) { return false; }
        val binId = s.loadInt(32);
        if (binId <= previous) { return false; }
        previous = binId;
        if (adding) {
            val amount = s.tryLoadCoins();
            if (amount == null || amount <= 0 || amount > remaining) { return false; }
            remaining -= amount;
        }
        if (s.remainingBitsCount() != 257) { return false; }
        s.skipBits(256);
        val linked = s.loadBool();
        left -= 1;
        if (linked != (left > 0) || s.remainingRefsCount() != (linked ? 1 : 0)) { return false; }
        if (linked) { next = s.loadRef(); }
    }
    return !adding || remaining == 0;
}

fun pool_add_try_parse(payload: slice, credited: coins): LiqAdd? {
    var s = payload;
    if (s.remainingBitsCount() < 32 || s.loadUint(32) != OP_LIQ_ADD) { return null; }
    val owner = s.tryLoadStdAddress();
    if (owner == null || s.remainingBitsCount() != 4 || s.remainingRefsCount() != 1) { return null; }
    val notify = s.loadBool();
    val count = s.loadUint(3);
    val rows = s.loadRef();
    if (!pool_rows_valid(rows, count, true, credited)) { return null; }
    return { owner, notify, count, rows };
}

fun pool_remove_try_parse(payload: slice): LiqRemove? {
    var s = payload;
    if (s.remainingBitsCount() < 96 || s.loadUint(32) != OP_LIQ_REMOVE) { return null; }
    val queryId = s.loadUint(64);
    val recipient = s.tryLoadStdAddress();
    if (recipient == null || s.remainingBitsCount() < 32) { return null; }
    val deadline = s.loadUint(32);
    val minT3 = s.tryLoadCoins(); val minX = s.tryLoadCoins();
    if (minT3 == null || minX == null || s.remainingBitsCount() != 3 || s.remainingRefsCount() != 1) { return null; }
    val count = s.loadUint(3); val rows = s.loadRef();
    if (!pool_rows_valid(rows, count, false, 0)) { return null; }
    return { queryId, recipient, deadline, minT3, minX, count, rows };
}

fun pool_farm_try_parse(payload: slice): FarmCreate? {
    var s = payload;
    if (s.remainingBitsCount() != 96 || s.remainingRefsCount() != 0 || s.loadUint(32) != OP_FARM_CREATE) { return null; }
    return { binId: s.loadInt(32), duration: s.loadUint(32) };
}

fun pool_id_try_parse(c: cell): PoolId? {
    val opened = pool_open(c);
    if (opened == null) { return null; }
    var s = opened;
    val xMaster = s.tryLoadStdAddress();
    if (xMaster == null || s.remainingBitsCount() < 88) { return null; }
    val binSpacing = s.loadUint(16); val feePips = s.loadUint(32);
    val xDecimals = s.loadUint(8); val walletGasX = s.loadUint(32);
    val walletGramX = s.tryLoadCoins();
    if (walletGramX == null || s.remainingBitsCount() != 0 || s.remainingRefsCount() != 1 || binSpacing < 1 || binSpacing > 10000 || feePips > 100000
        || xDecimals > 18 || walletGasX < 10000 || walletGasX > 500000 || walletGramX > 500000000) { return null; }
    val walletBudgetX = s.loadRef() as Cell<JettonWalletBudget>;
    val budget = jetton_budget_try_parse(walletBudgetX);
    if (budget == null || !jetton_budget_valid(budget, walletGasX)) { return null; }
    return { xMaster, binSpacing, feePips, xDecimals, walletGasX, walletGramX, walletBudgetX };
}
