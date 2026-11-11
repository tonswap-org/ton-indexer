tolk 1.5.0

import "@stdlib/gas-payments";
import "../dlmm/pool_book";
import "../dlmm/constants";
import "../dlmm/pool_state_init";
import "../dlmm/pool_storage";
import "../dlmm/farming";

struct BookHarness {
    spacing: uint16; decimals: uint8; feePips: uint32;
    lastStatus: uint8; lastT: coins; lastX: coins; lastGas: uint32;
    book: Cell<BookState>; campaigns: map<uint64, PoolCampaign>;
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    var s = BookHarness.fromCell(contract.getData());
    var body = in.body;
    val kind = body.loadUint(32);
    var book = s.book.load();
    val before = getGasConsumedAtTheMoment();
    if (kind == 1) {
        val side = body.loadUint(8);
        val request = LiqAdd.fromCell(body.loadRef());
        body.assertEnd();
        val result = add_compute(book, side, request.owner, request.count, request.rows, s.spacing, s.decimals, s.feePips, s.campaigns);
        s.lastStatus = result.status; s.lastT = result.entryFee; s.lastX = 0;
        if (result.status == 0) { book = result.state; }
    } else if (kind == 2) {
        val side = body.loadUint(8); val amount = body.loadCoins(); body.assertEnd();
        val result = swap_compute(book, side, amount, s.feePips, -1, 0, false);
        s.lastStatus = result.status; s.lastT = result.amountOut; s.lastX = result.protocolFeeT3;
        if (result.status == 0) {
            book.amm = result.amm; book.activeBin = result.lastBin; book.protocolFeesT3 += result.protocolFeeT3;
        }
    } else {
        assert (kind == 3 || kind == 4) throw 40;
        val owner = body.loadAddress();
        val request = LiqRemove.fromCell(body.loadRef()); body.assertEnd();
        val result = remove_compute(book, owner, request.count, request.rows, request.minT3, request.minX, s.spacing, s.decimals, s.campaigns, kind == 4);
        s.lastStatus = result.status; s.lastT = result.amountT3; s.lastX = result.amountX;
        if (result.status == 0) { book = result.state; }
    }
    s.lastGas = getGasConsumedAtTheMoment() - before;
    s.book = book.toCell(); contract.setData(s.toCell());
}
get fun book(): cell { return BookHarness.fromCell(contract.getData()).book; }
get fun result(): (int, int, int, int) {
    val s = BookHarness.fromCell(contract.getData());
    return (s.lastStatus, s.lastT, s.lastX, s.lastGas);
}
get fun quote(side: int, amount: coins): (int, int, int, int, int) {
    val s = BookHarness.fromCell(contract.getData());
    val r = swap_compute(s.book.load(), side, amount, s.feePips, -1, 0, false);
    return (r.status, r.amountOut, r.protocolFeeT3, r.lastBin, r.loaded);
}

get fun guard_quote(side: int, amount: coins, budget: coins): (int, int, int) {
    val s = BookHarness.fromCell(contract.getData());
    val r = swap_compute(s.book.load(), side, amount, s.feePips, budget, 0, true);
    return (r.status, r.amountOut, r.loaded);
}
get fun guard_floor(loaded: int): coins {
    return calculateGasFee(BASECHAIN, min(SWAP_GAS_MAX, SWAP_PREWALK_GAS_MAX + loaded * STEP_GAS_MAX + APPLY_TAIL_GAS_MAX));
}

get fun capacity(t: coins, pq: int, feePips: int): int { return pool_x_capacity(t, pq, feePips); }
get fun measured_quote(side: int, amount: coins): (int, int, int) {
    val s = BookHarness.fromCell(contract.getData());
    val book = s.book.load();
    val before = getGasConsumedAtTheMoment();
    val r = swap_compute(book, side, amount, s.feePips, (1 << 120) - 1, 0, false);
    return (r.status, r.loaded, getGasConsumedAtTheMoment() - before);
}

// Batch the production math to qualify a day of one-second claims without 86400 wallet round trips.
get fun farm_batch(positionCell: cell, binCell: cell, campaignCell: cell, steps: int): (cell, cell) {
    assert (steps >= 1 && steps <= 1024) throw 40;
    var position = PoolPosition.fromCell(positionCell);
    val bin = PoolBin.fromCell(binCell);
    var campaign = PoolCampaign.fromCell(campaignCell); val terms = campaign.terms.load();
    repeat (steps) {
        campaign = pool_farm_update(campaign, terms, campaign.lastTs + 1);
        campaign.paid += pool_farm_claim(mutate position, bin, campaign);
        assert (campaign.paid <= mulDivFloor(terms.total, campaign.lastTs - terms.start, terms.duration)) throw 41;
    }
    return (position.toCell(), campaign.toCell());
}
