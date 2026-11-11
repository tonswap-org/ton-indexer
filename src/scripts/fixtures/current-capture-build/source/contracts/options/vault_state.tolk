tolk 1.5.0
import "../shared/governance/module_gate"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/holder_recovery"
import "../shared/jetton/jetton_sweep"

const OV_MAX_INTENTS = 4096
const OV_MAX_ESCROWS = 4096
const OV_MAX_WRITERS = 8192
const OV_BOUNCE_GAS = 250000
const OV_CREDIT_GAS = 160000
const OV_PAY_GAS = 180000
const OV_ADMIN_GAS = 60000
const OV_WITHDRAW_GAS = 85000
const OV_EXPIRE_GAS = 65000
struct WriterAmounts {
    funded:coins;
    available:coins;
    locked:coins;
    premium:coins
}
struct WriterPending {
    queryId:uint64;
    backing:coins;
    premium:coins;
    kept:coins
}
struct WriterReserve {
    owner:address;
    expiry:uint32;
    released:coins;
    amounts:Cell<WriterAmounts>;
    pending:Cell<WriterPending>?
}
struct VaultIntent {
    queryId:uint64;
    kind:uint8;
    owner:address;
    amount:coins;
    kept:coins;
    createdAt:uint32;
    askedAt:uint32;
    seriesId:uint64;
    notional:coins
}
struct VaultEscrow {
    owner:address;
    queryId:uint64;
    net:coins;
    fee:coins;
    locked:coins;
    kept:coins
}
struct VaultTotals {
    writer:coins;
    escrow:coins;
    intent:coins;
    fees:coins;
    nativeHeld:coins;
    pendingBuys:map<uint64,uint16>
}
struct VaultBook {
    nextIntentId:uint65;
    intentCount:uint16;
    escrowCount:uint16;
    writerCount:uint16;
    totals:Cell<VaultTotals>;
    writers:map<uint64,WriterReserve>;
    escrows:map<uint128,VaultEscrow>;
    intents:map<uint64,VaultIntent>
}
struct VaultPeers {
    feeSink:address;
    treasury:address;
    factory:address?
}
struct VaultStorage {
    gate:ModuleGate;
    peers:Cell<VaultPeers>;
    jetton:Cell<JettonManagedLedger>;
    sweeps:Cell<JettonSweeps>;
    book:Cell<VaultBook>
}
fun VaultStorage.load():VaultStorage{
    return VaultStorage.fromCell(contract.getData());
}
fun VaultStorage.save(self){
    contract.setData(self.toCell());
}
fun vault_key(seriesId:uint64,tokenId:uint64):uint128{
    return ((seriesId as int)<<64)|tokenId;
}

fun VaultStorage.ledger(self):JettonLedger{ return self.jetton.load().ledger; }
fun VaultStorage.setLedger(mutate self,l:JettonLedger){
    var m=self.jetton.load(); m.ledger=l; self.jetton=m.toCell();
}
fun VaultStorage.dispatch(mutate self,amount:coins){
    var m=self.jetton.load(); m.recovery.dispatch(0,amount); self.jetton=m.toCell();
}
fun VaultStorage.handled(mutate self,amount:coins){
    var m=self.jetton.load(); m.recovery.handled(0,amount); self.jetton=m.toCell();
}
fun VaultStorage.restored(mutate self,amount:coins){
    var m=self.jetton.load(); m.recovery.restored(0,amount); self.jetton=m.toCell();
}
