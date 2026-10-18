tolk 1.5.0

import "engine_types"
import "../shared/governance/module_gate"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/holder_recovery"
import "../shared/jetton/jetton_sweep"
import "../shared/risk/settle"

const PX_PENDING_CAP = 512;
const PX_SETTLE_ADMISSION_CAP = 512;
const PX_PREFIX_PENDING_CAP = 16;
const PX_PREFIX_SETTLE_ADMISSION_CAP = 32;
// Partial exits leave at least 0.75 T3 of entry notional; all four markets share the 22.5 T3 ceiling.
const PX_POSITION_CAP = 30;

struct PxPeers { feeSink: address; riskVault: address; treasury: address; riskBucketId: uint16 }
struct PxMarketTotals { longOi: coins; shortOi: coins; pending: coins }
struct PxMarket { pool: address; params: Cell<PxParams>; totals: Cell<PxMarketTotals>; funding: Cell<PxFunding> }
struct PxTerms { gen: uint64; deadline: uint32; size: int128; limit: coins; leverage: uint32 }
struct PxReservation {
    servedAt: uint64;
    oraclePrice: coins;
    notional: coins;
    basisNotional: coins;
    basisReserved: coins;
    targetNotional: coins;
    targetReserved: coins;
}
struct PxPending {
    owner: address;
    marketId: uint32;
    queryId: uint64;
    nonce: uint64;
    requestedAt: uint32;
    kind: uint8;
    deposit: coins;
    kept: coins;
    terms: Cell<PxTerms>;
    reservation: Cell<PxReservation>?;
}
struct PxSettlement { marketId: uint32; queryId: uint64; gen: uint64; body: Cell<RvSettle> }
struct PxMarkets { markets: map<uint32, Cell<PxMarket>>; prefixes: map<uint8, uint32> }
struct PxBook {
    nextNonce: uint64;
    feeBps: uint16;
    pendingCount: uint16;
    settleCount: uint16;
    positionCount: uint8;
    marginLiability: coins;
    pendingDeposits: coins;
    feesAccrued: coins;
    lossPending: coins;
    collectedLossHeld: coins;
    nativeKept: coins;
    venues: Cell<PxMarkets>;
    positions: map<uint256, Cell<PxPosition>>;
    pendings: map<uint256, Cell<PxPending>>;
    settlements: map<uint256, Cell<PxSettlement>>;
}
struct PxStorage {
    gate: ModuleGate;
    peers: Cell<PxPeers>;
    jetton: Cell<JettonManagedLedger>;
    sweeps: Cell<JettonSweeps>;
    book: Cell<PxBook>;
}
fun PxStorage.load(): PxStorage { return PxStorage.fromCell(contract.getData()); }
fun PxStorage.save(self) { contract.setData(self.toCell()); }
fun px_position_key(owner: address, marketId: uint32): uint256 {
    return beginCell().storeAddress(owner).storeUint(marketId, 32).hash();
}
fun PxBook.position(self, key: uint256): PxPosition {
    val item = self.positions.get(key);
    return item.isFound ? item.loadValue().load() : px_empty_position();
}
fun PxBook.market(self, id: uint32): PxMarket { return self.venues.load().markets.mustGet(id, 9021).load(); }
fun PxBook.put_market(mutate self, id: uint32, market: PxMarket) {
    var venues = self.venues.load(); venues.markets.set(id, market.toCell()); self.venues = venues.toCell();
}
fun PxBook.prefix_counts(self, key: uint256): (int, int) {
    val e = self.venues.load().prefixes.get((key >> 248) as uint8);
    val packed: int = e.isFound ? e.loadValue() as int : 0;
    return (packed >> 16, packed & 65535);
}
fun PxBook.prefix_delta(mutate self, key: uint256, pending: int, settled: int) {
    var venues = self.venues.load(); val prefix = (key >> 248) as uint8;
    val old = venues.prefixes.get(prefix); val packed: int = old.isFound ? old.loadValue() as int : 0;
    val next = (((packed >> 16) + pending) << 16) | ((packed & 65535) + settled);
    if (next == 0) { venues.prefixes.delete(prefix); } else { venues.prefixes.set(prefix, next as uint32); }
    self.venues = venues.toCell();
}
fun PxBook.has_admission_space(self, key: uint256): bool {
    val (pending, settled) = self.prefix_counts(key);
    return self.pendingCount < PX_PENDING_CAP && self.settleCount < PX_SETTLE_ADMISSION_CAP
        && pending < PX_PREFIX_PENDING_CAP && settled < PX_PREFIX_SETTLE_ADMISSION_CAP;
}
fun PxBook.has_commit_space(self, key: uint256): bool {
    val (_, settled) = self.prefix_counts(key);
    return self.settleCount < PX_SETTLE_ADMISSION_CAP && settled < PX_PREFIX_SETTLE_ADMISSION_CAP;
}
fun PxBook.add_pending(mutate self, key: uint256, p: PxPending) {
    self.pendings.set(key, p.toCell()); self.pendingCount += 1; self.pendingDeposits += p.deposit; self.nativeKept += p.kept;
    self.prefix_delta(key, 1, 0);
}
fun PxBook.add_settlement(mutate self, key: uint256, value: PxSettlement) {
    self.settlements.set(key, value.toCell()); self.settleCount += 1; self.prefix_delta(key, 0, 1);
}
fun PxBook.drop_settlement(mutate self, key: uint256) {
    self.settlements.delete(key); self.settleCount -= 1; self.prefix_delta(key, 0, -1);
}
fun PxBook.fresh_nonce(mutate self): uint64 {
    assert (self.nextNonce != (1 << 64) - 1) throw 9020;
    self.nextNonce += 1; return self.nextNonce;
}
fun PxBook.drop_pending(mutate self, key: uint256, p: PxPending) {
    self.pendings.delete(key); self.pendingCount -= 1; self.pendingDeposits -= p.deposit; self.nativeKept -= p.kept;
    self.prefix_delta(key, -1, 0);
    if (p.reservation != null) {
        var market = self.market(p.marketId);
        var totals = market.totals.load();
        totals.pending -= p.reservation!.load().notional;
        market.totals = totals.toCell(); self.put_market(p.marketId, market);
    }
}
fun PxBook.apply_plan(mutate self, key: uint256, old: PxPosition, plan: PxPlan, marketId: uint32) {
    var market = self.market(marketId);
    var totals = market.totals.load();
    val side = old.size == 0 ? plan.position.size : old.size;
    if (side > 0) { totals.longOi += plan.notionalDelta as coins; }
    else { totals.shortOi += plan.notionalDelta as coins; }
    market.totals = totals.toCell(); self.put_market(marketId, market);
    self.marginLiability += plan.position.margin - old.margin;
    self.feesAccrued += plan.fee;
    self.lossPending += plan.loss;
    self.collectedLossHeld += plan.position.counterparty.load().collectedLoss - old.counterparty.load().collectedLoss;
    if (plan.position.size == 0) {
        if (old.size != 0) { self.positionCount -= 1; }
        self.positions.delete(key);
    } else {
        if (old.size == 0) { self.positionCount += 1; }
        self.positions.set(key, plan.position.toCell());
    }
}
fun PxStorage.liabilities(self): coins {
    val b = self.book.load();
    return b.marginLiability + b.pendingDeposits + b.feesAccrued + b.lossPending + b.collectedLossHeld + self.ledger().owedTotal(0) + self.jetton.load().recovery.pending(0);
}

fun PxStorage.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun PxStorage.setLedger(mutate self, ledger: JettonLedger) {
    var managed = self.jetton.load(); managed.ledger = ledger; self.jetton = managed.toCell();
}
fun PxStorage.dispatch(mutate self, amount: coins) {
    var managed = self.jetton.load(); managed.recovery.dispatch(0, amount); self.jetton = managed.toCell();
}
fun PxStorage.handled(mutate self, amount: coins) {
    var managed = self.jetton.load(); managed.recovery.handled(0, amount); self.jetton = managed.toCell();
}
fun PxStorage.restored(mutate self, amount: coins) {
    var managed = self.jetton.load(); managed.recovery.restored(0, amount); self.jetton = managed.toCell();
}
