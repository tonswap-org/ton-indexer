tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"
import "@gen/op/jetton"
import "@gen/op/t3"
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"

const TR_BIND_GAS = 100000
const TR_PAY_GAS = 80000
const TR_GRAM_GAS = 30000
const TR_BOUNCE_GAS = 65000
const TR_CLAIM_GAS = 30000

struct TreasuryClaimPeer { merkleClaim: address }
struct TreasuryPeers { emissionsSplitter: address; remint: address; gasVault: address; claim: Cell<TreasuryClaimPeer> }
struct TreasuryFlow { tracked: coins; allow: coins; last: uint32 }
struct TreasuryGram { basis: coins; allow: coins; last: uint32 }
struct TreasuryStorage {
    governance: address
    salt: uint64
    jetton: Cell<JettonManagedLedger>
    peers: Cell<TreasuryPeers>?
    flows: map<uint8, TreasuryFlow>
    gram: TreasuryGram
}
struct (0x54424e44) TreasuryBind { queryId: uint64; tsMaster: address; peers: Cell<TreasuryPeers> }
struct (0x54424558) TreasuryBindExtra { queryId: uint64; slot: uint8; master: address; walletGas: uint32; walletGram: coins; budget: Cell<JettonWalletBudget> }
struct (0x54504a54) TreasuryPayJetton { queryId: uint64; slot: uint8; amount: coins; recipient: address; forwardGram: coins }
struct (0x5450544e) TreasuryPayGram { queryId: uint64; amount: coins }
struct (0x54434c4d) TreasuryClaim { queryId: uint64; index: uint32; proof: cell }
struct (0x4d434c4d) MerkleClaim { queryId: uint64; index: uint32; proof: cell }
struct (0x54504556) TreasuryEvent { kind: uint8; slot: uint8; amount: coins; recipient: address }

fun TreasuryStorage.load(): TreasuryStorage { return TreasuryStorage.fromCell(contract.getData()); }
fun TreasuryStorage.save(self) { contract.setData(self.toCell()); }
fun TreasuryStorage.ledger(self): JettonLedger { return self.jetton.load().ledger; }
fun TreasuryStorage.setLedger(mutate self,ledger:JettonLedger) { var managed=self.jetton.load();managed.ledger=ledger;self.jetton=managed.toCell(); }
fun TreasuryStorage.flowCredit(mutate self,slot:uint8,amount:coins,restore:bool) {
    var flow=self.flow(slot);flow.allow=treasury_allow(flow.tracked,flow.allow,flow.last);flow.last=blockchain.now();
    flow.tracked=min(JETTON_MAX_COINS,flow.tracked+amount);
    if(restore){flow.allow=min(flow.tracked/10,flow.allow+amount);}
    self.flows.set(slot,flow);
}
fun treasury_bucket(): int {
    val config = blockchain.configParam(19);
    if (config != null) {
        var body = config!.beginParse();
        if (body.remainingBitsCount() == 32 && body.remainingRefsCount() == 0 && body.loadInt(32) == -3) { return 600; }
    }
    return 86400;
}
fun treasury_allow(tracked: coins, allow: coins, last: uint32): coins {
    val cap = tracked / 10;
    return min(cap, allow + cap * max(0, blockchain.now() - last) / (30 * treasury_bucket()));
}
// Caller-return paths pass zero income; later reads clamp execution costs to actual cash.
fun TreasuryStorage.native_step(mutate self, value: coins, retained: coins) {
    val before = max(0, contract.getOriginalBalance() - value);
    self.gram.allow = self.peers == null ? 0 : treasury_allow(min(self.gram.basis, before), self.gram.allow, self.gram.last);
    self.gram.last = blockchain.now();
    self.gram.basis = before + retained;
}
fun treasury_native_credit(value: coins) {
    var st = TreasuryStorage.load();
    st.native_step(value, value);
    st.save();
}
fun TreasuryStorage.flow(self, slot: uint8): TreasuryFlow {
    val entry = self.flows.get(slot);
    return entry.isFound ? entry.loadValue() : TreasuryFlow { tracked: 0, allow: 0, last: blockchain.now() };
}
fun TreasuryStorage.peer(self, a: address): bool {
    if (a == self.governance) { return true; }
    if (self.peers == null) { return false; }
    val peers = self.peers!.load();
    return a == peers.emissionsSplitter || a == peers.remint || a == peers.gasVault || a == peers.claim.load().merkleClaim;
}
fun treasury_reserve(value: coins, spent: coins) {
    reserveGramsOnBalance(contract.getOriginalBalance() - value - spent,
        RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun treasury_return(to: address) {
    createMessage({ bounce: BounceMode.NoBounce, dest: to, value: 0, body: beginCell().endCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun treasury_log(kind: uint8, slot: uint8, amount: coins, recipient: address) {
    createExternalLogMessage({ dest: createAddressNone(), body: TreasuryEvent { kind, slot, amount, recipient } })
        .send(SEND_MODE_IGNORE_ERRORS);
}
fun treasury_pay_value(ledger: JettonLedger, slot: uint8, forwardGram: coins): coins {
    return calculateGasFee(BASECHAIN, TR_PAY_GAS) + calculateForwardFee(BASECHAIN, 1000, 1)
        + ledger.legValue(slot, forwardGram, 0, 0, TR_BOUNCE_GAS);
}
fun treasury_bind_value(ledger: JettonLedger, walletGram: coins): coins {
    return calculateGasFee(BASECHAIN, TR_BIND_GAS) + ledger.minDiscover() + jetton_discover_value(walletGram)
        + calculateForwardFee(BASECHAIN, 1000, 1);
}
fun treasury_gram_value(): coins {
    return calculateGasFee(BASECHAIN, TR_GRAM_GAS) + 3 * calculateForwardFee(BASECHAIN, 1000, 1);
}
fun on_credit(sender:address,value:coins,body:slice) {
    var st=TreasuryStorage.load();st.native_step(value,value);var managed=st.jetton.load();
    val credit=managed.ledger.onNotification(sender,body);
    assert(credit!=null || managed.recovery.slots.isEmpty()) throw ERR_JETTON_RECOVERY;
    if(credit!=null){val c=credit!;if(!c.claimReceipt){managed.recovery.handled(c.slot,c.amount);}st.flowCredit(c.slot,c.amount,false);}
    st.jetton=managed.toCell();st.save();
}
fun onBouncedMessage(in:InMessageBounced) {
    var st=TreasuryStorage.load();st.native_step(in.valueCoins,in.valueCoins);var managed=st.jetton.load();
    val b=managed.ledger.onBounce(in.senderAddress,in.bouncedBody);
    if(b.kind==1){st.flowCredit(b.slot,b.amount,true);managed.recovery.restored(b.slot,b.amount);}
    st.jetton=managed.toCell();st.save();
}
fun treasury_certificate_slot(ledger:JettonLedger,body:slice):uint8 {
    var b=body;b.loadUint(32);val config=(b.loadRef() as Cell<ProofConfig>).load();
    val(slot,_)=ledger.lookup(config.credit.load().wallets.beginParse().loadAddress());assert(slot>=0) throw ERR_JETTON_RECOVERY;return slot as uint8;
}
fun treasury_recovery_accept(sender:address,value:coins,body:slice) {
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=TreasuryStorage.load();var managed=st.jetton.load();
    val evidence=jetton_recovery_authenticate(managed.ledger,treasury_certificate_slot(managed.ledger,body),sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(evidence);st.jetton=managed.toCell();st.native_step(value,jetton_receipt_rent());st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    treasury_return(sender);
}
fun treasury_recovery_claim(sender:address,value:coins,body:slice) {
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=TreasuryStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);
    st.native_step(value,0);st.flowCredit(item.slot,item.amount,!item.incoming);st.jetton=managed.toCell();st.save();
    treasury_reserve(value,0);treasury_return(sender);
}
fun on_take(sender: address, value: coins, body: slice) {
    var st = TreasuryStorage.load();
    st.native_step(value, value);
    var ledger = st.ledger();
    val take = ledger.checkTake(sender, body);
    if (take == null || st.peer(take.wallet)) { st.save(); return; }
    ledger.commitTake(take);
    st.setLedger(ledger);
    st.save();
}
fun on_bind(sender: address, value: coins, body: slice) {
    val msg = TreasuryBind.fromSlice(body);
    var st = TreasuryStorage.load();
    st.native_step(value, 0);
    assert (sender == st.governance && st.peers == null) throw ERR_GOVERNANCE_UNAUTHORIZED;
    var ledger = st.ledger();
    assert (ledger.coreReady()) throw ERR_JETTON_SLOT;
    val peers = msg.peers.load();
    val merkleClaim = peers.claim.load().merkleClaim;
    val addresses = [peers.emissionsSplitter, peers.remint, peers.gasVault, merkleClaim];
    var i = 0;
    while (i < 4) {
        val a = addresses.get(i);
        assert (ledger.canPay(a) && a != st.governance && a != msg.tsMaster) throw ERR_JETTON_DEST;
        var j = 0;
        while (j < i) { assert (a != addresses.get(j)) throw ERR_JETTON_DEST; j += 1; }
        i += 1;
    }
    assert (!st.peer(msg.tsMaster) && value >= treasury_bind_value(ledger, 0)) throw ERR_JETTON_VALUE;
    ledger.slotAdd(1, msg.tsMaster, JETTON_V21_WALLET_GAS, 0, true, jetton_standard_budget(JETTON_V21_WALLET_GAS));
    st.peers = TreasuryPeers { emissionsSplitter: peers.emissionsSplitter, remint: peers.remint, gasVault: peers.gasVault,
        claim: TreasuryClaimPeer { merkleClaim }.toCell() }.toCell();
    st.gram.last = blockchain.now();
    st.setLedger(ledger);
    st.save();
    ledger.discover();
    treasury_reserve(value, 0);
    treasury_return(sender);
}
fun on_bind_extra(sender: address, value: coins, body: slice) {
    val msg = TreasuryBindExtra.fromSlice(body);
    var st = TreasuryStorage.load();
    st.native_step(value, 0);
    assert (sender == st.governance && st.peers != null) throw ERR_GOVERNANCE_UNAUTHORIZED;
    assert (msg.slot >= 2 && msg.slot <= 15 && !st.peer(msg.master)) throw ERR_JETTON_SLOT;
    var ledger = st.ledger();
    assert (value >= treasury_bind_value(ledger, msg.walletGram)) throw ERR_JETTON_VALUE;
    ledger.slotAdd(msg.slot, msg.master, msg.walletGas, msg.walletGram, true, msg.budget);
    if(msg.budget.load().creditProtection){var managed=st.jetton.load();managed.recovery.slots.set(msg.slot,jetton_empty_recovery());st.jetton=managed.toCell();}
    st.setLedger(ledger);
    st.save();
    ledger.discover();
    treasury_reserve(value, 0);
    treasury_return(sender);
}
fun on_pay_jetton(sender: address, value: coins, body: slice) {
    val msg = TreasuryPayJetton.fromSlice(body);
    var st = TreasuryStorage.load();
    st.native_step(value, 0);
    assert (sender == st.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
    val ledger = st.ledger();
    assert (ledger.slots.mustGet(msg.slot, ERR_JETTON_SLOT).wallet != null && ledger.canPay(msg.recipient)) throw ERR_JETTON_DEST;
    if (msg.slot == 1) {
        assert (st.peers != null) throw ERR_GOVERNANCE_CONFIG;
        val peers = st.peers!.load();
        assert ((msg.recipient == peers.emissionsSplitter || msg.recipient == peers.remint)
            && msg.forwardGram >= jetton_notify_value()) throw ERR_JETTON_DEST;
    }
    assert (value >= treasury_pay_value(ledger, msg.slot, msg.forwardGram)) throw ERR_JETTON_VALUE;
    var flow = st.flow(msg.slot);
    flow.allow = treasury_allow(flow.tracked, flow.allow, flow.last);
    assert (msg.amount > 0 && msg.amount <= flow.allow) throw ERR_GOVERNANCE_CONFIG;
    flow.allow -= msg.amount;
    flow.tracked -= msg.amount;
    var managed=st.jetton.load();managed.recovery.dispatch(msg.slot,msg.amount);st.jetton=managed.toCell();
    flow.last = blockchain.now();
    st.flows.set(msg.slot, flow);
    st.save();
    treasury_log(1, msg.slot, msg.amount, msg.recipient);
    treasury_reserve(value, 0);
    ledger.sendTransfer(msg.slot, { queryId: msg.queryId, amount: msg.amount, destination: msg.recipient,
        excessTo: contract.getAddress(), forwardGram: msg.forwardGram, forwardPayload: null },
        0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun on_pay_gram(sender: address, value: coins, body: slice) {
    val msg = TreasuryPayGram.fromSlice(body);
    var st = TreasuryStorage.load();
    st.native_step(value, 0);
    assert (sender == st.governance && st.peers != null) throw ERR_GOVERNANCE_UNAUTHORIZED;
    assert (value >= treasury_gram_value()) throw ERR_JETTON_VALUE;
    assert (msg.amount > 0 && msg.amount <= st.gram.allow) throw ERR_GOVERNANCE_CONFIG;
    st.gram.allow -= msg.amount;
    st.gram.basis -= msg.amount;
    val to = st.peers!.load().gasVault;
    st.save();
    treasury_log(2, 0, msg.amount, to);
    createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: to, value: msg.amount, body: beginCell().endCell() })
        .send(SEND_MODE_REGULAR | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    treasury_reserve(value, msg.amount);
    treasury_return(sender);
}
fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { treasury_native_credit(in.valueCoins); return; }
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit(in.senderAddress, in.valueCoins, in.body); return; }
    if(op==OP_T3_NOTIFICATION_CERTIFICATE || op==OP_T3_FAILURE_CERTIFICATE){treasury_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){treasury_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    if (op == OP_TEP74_EXCESSES) { treasury_native_credit(in.valueCoins); return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) { on_take(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TREASURY_BIND) { on_bind(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TREASURY_BIND_EXTRA) { on_bind_extra(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TREASURY_PAY_JETTON) { on_pay_jetton(in.senderAddress, in.valueCoins, in.body); return; }
    if (op == OP_TREASURY_PAY_GRAM) { on_pay_gram(in.senderAddress, in.valueCoins, in.body); return; }
    var st = TreasuryStorage.load();
    st.native_step(in.valueCoins, 0);
    val ledger = st.ledger();
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body);
        assert (in.valueCoins >= ledger.minDiscover() + calculateForwardFee(BASECHAIN, 1000, 1)) throw ERR_JETTON_VALUE;
        st.save();
        ledger.discover();
        treasury_reserve(in.valueCoins, 0);
        treasury_return(in.senderAddress);
        return;
    }
    if (op == OP_TREASURY_CLAIM) {
        val msg = TreasuryClaim.fromSlice(in.body);
        assert (st.peers != null && ledger.slots.mustGet(1, ERR_JETTON_SLOT).wallet != null) throw ERR_JETTON_SLOT;
        st.save();
        createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: st.peers!.load().claim.load().merkleClaim, value: 0,
            body: MerkleClaim { queryId: msg.queryId, index: msg.index, proof: msg.proof } })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        return;
    }
    throw ERR_GOVERNANCE_CONFIG;
}

get fun get_treasury(): (address, uint64, Cell<TreasuryPeers>?) {
    val st = TreasuryStorage.load(); return (st.governance, st.salt, st.peers);
}
get fun get_flow(slot: uint8): TreasuryFlow {
    var flow = TreasuryStorage.load().flow(slot);
    flow.allow = treasury_allow(flow.tracked, flow.allow, flow.last);
    return flow;
}
get fun get_gram_flow(): TreasuryFlow {
    val st = TreasuryStorage.load();
    val tracked = contract.getOriginalBalance();
    return { tracked, allow: st.peers == null ? 0 : treasury_allow(min(st.gram.basis, tracked), st.gram.allow, st.gram.last), last: st.gram.last };
}
get fun get_params(): (int, int) { val bucket = treasury_bucket(); return (bucket, 30 * bucket); }
get fun get_claim_value(claimValue: coins, proof: cell): coins {
    val size = proof.calculateSizeStrict(256);
    return claimValue + calculateGasFee(BASECHAIN, TR_CLAIM_GAS) + calculateForwardFee(BASECHAIN, size.1 + 1000, size.0 + 2);
}
get fun get_min_forward(): coins { return jetton_notify_value(); }
get fun get_min_discover(): coins { return TreasuryStorage.load().ledger().minDiscover() + calculateForwardFee(BASECHAIN, 1000, 1); }
get fun get_bind_value(walletGram: coins): coins { return treasury_bind_value(TreasuryStorage.load().ledger(), walletGram); }
get fun get_pay_value(slot: uint8, forwardGram: coins): coins { return treasury_pay_value(TreasuryStorage.load().ledger(), slot, forwardGram); }
get fun get_min_value(op: uint32): coins {
    if (op == OP_TREASURY_PAY_GRAM) { return treasury_gram_value(); }
    val ledger = TreasuryStorage.load().ledger();
    if (op == OP_TREASURY_BIND) { return treasury_bind_value(ledger, 0); }
    assert (op == OP_TREASURY_PAY_JETTON) throw ERR_GOVERNANCE_CONFIG;
    var value: coins = 0;
    var e = ledger.slots.findFirst();
    while (e.isFound) { value = max(value, treasury_pay_value(ledger, e.getKey(), jetton_notify_value())); e = ledger.slots.iterateNext(e); }
    return value;
}
get fun get_jetton_slots(): map<uint8, JettonSlot> { return TreasuryStorage.load().ledger().slots; }
get fun get_jetton_liabilities(slot: uint8): coins { val st=TreasuryStorage.load();return st.flow(slot).tracked+st.jetton.load().recovery.pending(slot); }
get fun get_jetton_balance(slot:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int) {
    val tracked=get_jetton_liabilities(slot)+TreasuryStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers); return (tracked, max(0, observed - tracked), max(0, tracked - observed));
}
get fun get_rent_target(): coins { return calculateStorageFee(BASECHAIN, 5 * 31536000, 450000, 1024); }

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return TreasuryStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();val ledger=TreasuryStorage.load().ledger();
    val e=jetton_recovery_authenticate(ledger,treasury_certificate_slot(ledger,certificate.beginParse()),t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{return calculateGasFee(0,JETTON_RECEIPT_GAS)+calculateForwardFee(0,256,1);}
