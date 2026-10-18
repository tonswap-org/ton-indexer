tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments";
import "@stdlib/exotic-cells";
import "../shared/jetton/holder_recovery";
import "../t3/receipt_tree";
import "../t3/recovery_types";
import "@gen/op/t3";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/jetton_quotes";
import "../shared/utils/error_codes";
import "../generated/op/testnet";
import "../generated/op/jetton";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/tep89_codec";

const FAUCET_MAX_CLAIMERS = 16384;
const FAUCET_DEPOSIT = 20000000;
const FAUCET_CLAIM_GAS = 235000;
const FAUCET_BOUNCE_GAS = 225000;
const FAUCET_PRUNE_GAS = 225000;
const FAUCET_CREDIT_GAS = 40000;
const ERR_FAUCET = 3101;

struct FaucetClaimer { last0: uint32; last1: uint32; last2: uint32; wire0: uint64; wire1: uint64; wire2: uint64 }
struct FaucetConfig { cooldown: uint32; grant0: coins; grant1: coins; grant2: coins; supplyBase: uint120; tsLifetimeCap: coins }
struct FaucetStorage {
    config: Cell<FaucetConfig>;
    jetton: Cell<JettonManagedLedger>;
    available0: coins;
    available1: coins;
    available2: coins;
    tsGranted: coins;
    nextWire: uint65;
    count: uint16;
    claimers: map<address,FaucetClaimer>;
}
struct (0x46434c4d) FaucetClaim { queryId: uint64; asset: uint8 }
struct (0x4650524e) FaucetPrune { queryId: uint64; owner: address }
struct (0x46435253) FaucetRestoreCooldown { receipt: Cell<T3Receipt>; proof: cell }
fun FaucetStorage.load(): FaucetStorage { return FaucetStorage.fromCell(contract.getData()); }
fun FaucetStorage.save(self) { contract.setData(self.toCell()); }
fun FaucetStorage.ledger(self):JettonLedger{return self.jetton.load().ledger;}
fun FaucetStorage.setLedger(mutate self,ledger:JettonLedger){var m=self.jetton.load();m.ledger=ledger;self.jetton=m.toCell();}
fun FaucetStorage.addAvailable(mutate self,slot:uint8,amount:coins){assert(slot<3) throw ERR_FAUCET;
    if(slot==0){self.available0+=amount;}else if(slot==1){self.available1+=amount;}else{self.available2+=amount;}}
fun FaucetStorage.restoreGrant(mutate self,slot:uint8,owner:address,wire:uint64,amount:coins){
    self.addAvailable(slot,amount);self.resetCooldown(slot,owner,wire);
}
fun FaucetStorage.resetCooldown(mutate self,slot:uint8,owner:address,wire:uint64){val found=self.claimers.get(owner);
    if(found.isFound){var claimer=found.loadValue();
        if((slot==0?claimer.wire0:(slot==1?claimer.wire1:claimer.wire2))==wire){
            if(slot==0){claimer.last0=0;}else if(slot==1){claimer.last1=0;}else{claimer.last2=0;}self.claimers.set(owner,claimer);}
    }
}
fun faucet_return_fee(): coins { return calculateForwardFee(BASECHAIN,700,1); }
fun faucet_return(dest: address) {
    createMessage({ bounce: BounceMode.NoBounce,dest,value: 0 })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun faucet_min_value(st: FaucetStorage,op: int,asset: uint8): coins {
    val ledger = st.ledger();
    if (op == OP_DISCOVER_WALLETS) { return ledger.minDiscover() + faucet_return_fee(); }
    if (op == OP_FAUCET_CLAIM) {
        assert (asset < 3) throw ERR_FAUCET;
        return FAUCET_DEPOSIT + calculateGasFee(BASECHAIN,FAUCET_CLAIM_GAS) + faucet_return_fee()
            + ledger.legValue(asset,0,0,0,FAUCET_BOUNCE_GAS) + calculateForwardFee(BASECHAIN,1400,2);
    }
    return calculateGasFee(BASECHAIN,FAUCET_PRUNE_GAS) + faucet_return_fee();
}
fun onBouncedMessage(in:InMessageBounced){
    var st=FaucetStorage.load();val b=st.ledger().onBounce(in.senderAddress,in.bouncedBody);if(b.kind!=1||b.slot>2){return;}
    st.restoreGrant(b.slot,b.destination!,b.queryId,b.amount);var m=st.jetton.load();m.recovery.restored(b.slot,b.amount);st.jetton=m.toCell();st.save();
    jetton_bounce_excess(b.excessTo,b.queryId,in.valueCoins,0);
}
fun on_credit_faucet(sender:address,body:slice){
    var st=FaucetStorage.load();var m=st.jetton.load();val credit=m.ledger.onNotification(sender,body);
    if(credit==null){assert(m.recovery.slots.isEmpty()) throw ERR_JETTON_RECOVERY;return;}
    assert(credit.slot<3) throw ERR_FAUCET;st.addAvailable(credit.slot,credit.amount);
    if(!credit.claimReceipt){m.recovery.handled(credit.slot,credit.amount);}st.jetton=m.toCell();st.save();
}
fun faucet_evidence(ledger:JettonLedger,sender:address,body:slice):JettonRecoveryEvidence{
    var header=body;header.loadUint(32);val config=ProofConfig.fromCell(header.loadRef());val credit=config.credit.load();var wallets=credit.wallets.beginParse();val wallet=wallets.loadAddress();
    val(slot,ready)=ledger.lookup(wallet);assert(slot>=0&&slot<3) throw ERR_JETTON_RECOVERY;return jetton_recovery_authenticate(ledger,slot as uint8,sender,body);
}
fun faucet_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=FaucetStorage.load();var m=st.jetton.load();val evidence=faucet_evidence(m.ledger,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=m.recovery.record(evidence);st.jetton=m.toCell();st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT|RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);faucet_return(sender);
}
fun faucet_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=FaucetStorage.load();var m=st.jetton.load();val item=m.recovery.claim(msg.receipt,msg.proof);
    if(item.incoming){val credit=jetton_parse_notification(item.slot,item.body.beginParse());assert(credit!=null&&credit!.amount==item.amount&&!credit!.claimReceipt) throw ERR_JETTON_RECOVERY;st.addAvailable(item.slot,item.amount);}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;st.addAvailable(item.slot,item.amount);}
    st.jetton=m.toCell();st.save();jetton_bounce_excess(sender,0,value,0);
}
// Read-only membership keeps a deepest cooldown update separate from receipt replacement.
fun faucet_restore_cooldown(sender:address,value:coins,body:slice){
    val msg=FaucetRestoreCooldown.fromSlice(body);assert(value>=get_min_cooldown_restore()) throw ERR_JETTON_VALUE;setGasLimit(250000);
    val rec=msg.receipt.load();val item=JettonRecoveryItem.fromCell(rec.payload);assert(item.claimed&&!item.incoming&&item.amount>0) throw ERR_JETTON_RECOVERY;
    var st=FaucetStorage.load();val recovery=st.jetton.load().recovery.get(item.slot);assert(recovery!=null&&recovery!.load().tree!=null) throw ERR_JETTON_RECOVERY;
    val tree=recovery!.load().tree!.load();var hash=t3_receipt_leaf(msg.receipt);var step=msg.proof;var level=0;
    repeat(64){var(s,exotic)=step.beginParseSpecial();assert(!exotic&&s.remainingBitsCount()==257) throw ERR_JETTON_RECOVERY;
        val sibling=s.loadUint(256);val tail=s.loadMaybeRef();s.assertEnd();assert((tail==null)==(level==63)) throw ERR_JETTON_RECOVERY;
        hash=((rec.key>>level)&1)==0?t3_receipt_pair(hash,sibling):t3_receipt_pair(sibling,hash);level+=1;if(tail!=null){step=tail!;}}
    assert(hash==tree.root) throw ERR_JETTON_RECOVERY;val command=jetton_source_failure(item.body);
    st.resetCooldown(item.slot,command.destination,command.queryId);st.save();jetton_bounce_excess(sender,command.queryId,value,0);
}
fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { return; }
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    if(op==OP_T3_NOTIFICATION_CERTIFICATE||op==OP_T3_FAILURE_CERTIFICATE){faucet_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){faucet_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_FAUCET_RESTORE_COOLDOWN){faucet_restore_cooldown(in.senderAddress,in.valueCoins,in.body);return;}
    var st = FaucetStorage.load(); var ledger = st.ledger();
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_faucet(in.senderAddress,in.body); return; }
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        val take = ledger.checkTake(in.senderAddress,in.body);
        if (take != null) { ledger.commitTake(take); st.setLedger(ledger); st.save(); }
        return;
    }
    val before = max(contract.getOriginalBalance()-in.valueCoins,0);
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(in.body);
        assert (in.valueCoins >= faucet_min_value(st,op,0)) throw ERR_JETTON_VALUE;
        reserveGramsOnBalance(before,RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
        ledger.discover(); faucet_return(in.senderAddress); return;
    }
    val cfg = st.config.load();
    if (op == OP_FAUCET_CLAIM) {
        val msg = FaucetClaim.fromSlice(in.body);
        assert (msg.asset < 3 && ledger.coreReady() && ledger.canPay(in.senderAddress)
            && st.nextWire < 18446744073709551616) throw ERR_FAUCET;
        val found = st.claimers.get(in.senderAddress);
        var claimer = found.isFound ? found.loadValue() : FaucetClaimer { last0: 0,last1: 0,last2: 0,wire0: 0,wire1: 0,wire2: 0 };
        val lastAt = msg.asset == 0 ? claimer.last0 : (msg.asset == 1 ? claimer.last1 : claimer.last2);
        assert ((lastAt == 0 || blockchain.now() >= lastAt + cfg.cooldown)
            && (found.isFound || st.count < FAUCET_MAX_CLAIMERS)) throw ERR_FAUCET;
        val amount = msg.asset == 0 ? cfg.grant0 : (msg.asset == 1 ? cfg.grant1 : cfg.grant2);
        assert ((msg.asset == 0 ? st.available0 : (msg.asset == 1 ? st.available1 : st.available2)) >= amount
            && (msg.asset != 2 || (st.tsGranted+amount <= cfg.tsLifetimeCap
                && cfg.tsLifetimeCap < max(1,(cfg.supplyBase*200+9999)/10000)))) throw ERR_FAUCET;
        val deposit = found.isFound ? 0 : FAUCET_DEPOSIT;
        assert (in.valueCoins >= faucet_min_value(st,op,msg.asset)-FAUCET_DEPOSIT+deposit) throw ERR_JETTON_VALUE;
        val wire = st.nextWire as uint64; st.nextWire += 1;
        if (msg.asset == 0) { claimer.last0 = blockchain.now() as uint32; claimer.wire0 = wire; st.available0 -= amount; }
        else if (msg.asset == 1) { claimer.last1 = blockchain.now() as uint32; claimer.wire1 = wire; st.available1 -= amount; }
        else { claimer.last2 = blockchain.now() as uint32; claimer.wire2 = wire; st.available2 -= amount; st.tsGranted += amount; }
        st.claimers.set(in.senderAddress,claimer); if (!found.isFound) { st.count += 1; }
        var managed=st.jetton.load();if(!managed.recovery.slots.isEmpty()){managed.recovery.dispatch(msg.asset,amount);st.jetton=managed.toCell();}st.save(); reserveGramsOnBalance(before+deposit,RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
        ledger.sendTransfer(msg.asset,{queryId: wire,amount,destination: in.senderAddress,excessTo: in.senderAddress,
            forwardGram: 0,forwardPayload: null},ledger.legValue(msg.asset,0,0,0,FAUCET_BOUNCE_GAS),
            SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        faucet_return(in.senderAddress); return;
    }
    assert (op == OP_FAUCET_PRUNE && in.senderAddress.getWorkchain() == BASECHAIN) throw ERR_FAUCET;
    val msg = FaucetPrune.fromSlice(in.body); val found = st.claimers.get(msg.owner);
    assert (found.isFound && in.valueCoins >= faucet_min_value(st,op,0)) throw ERR_FAUCET;
    val claimer = found.loadValue();
    assert ((claimer.last0 == 0 || blockchain.now() >= claimer.last0+cfg.cooldown)
        && (claimer.last1 == 0 || blockchain.now() >= claimer.last1+cfg.cooldown)
        && (claimer.last2 == 0 || blockchain.now() >= claimer.last2+cfg.cooldown)) throw ERR_FAUCET;
    st.claimers.delete(msg.owner); st.count -= 1; st.save();
    reserveGramsOnBalance(before-min(before,FAUCET_DEPOSIT),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    faucet_return(in.senderAddress);
}
get fun get_faucet(): (FaucetConfig,coins,coins,coins,coins,uint16,uint65) {
    val st = FaucetStorage.load(); return (st.config.load(),st.available0,st.available1,st.available2,st.tsGranted,st.count,st.nextWire);
}
get fun get_claimer(owner: address): FaucetClaimer? { val r = FaucetStorage.load().claimers.get(owner); return r.isFound ? r.loadValue() : null; }
get fun get_jetton_slots(): map<uint8,JettonSlot> { return FaucetStorage.load().ledger().slots; }
get fun get_jetton_liabilities(asset: uint8): coins { assert (asset < 3) throw ERR_FAUCET; val s = FaucetStorage.load(); return s.jetton.load().recovery.pending(asset)+(asset == 0 ? s.available0 : (asset == 1 ? s.available1 : s.available2)); }
get fun get_unattributed_surplus(asset:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int){val l=get_jetton_liabilities(asset)+FaucetStorage.load().jetton.load().recovery.excluded(asset,protectedCredits,acceptedTransfers); return (l,max(observed-l,0),max(l-observed,0)); }
get fun get_min_value(op: uint32,asset: uint8): coins { return faucet_min_value(FaucetStorage.load(),op,asset); }
get fun get_min_forward(op: uint32,asset: uint8): coins { return calculateGasFee(BASECHAIN,FAUCET_CREDIT_GAS); }
get fun get_min_discover(): coins { return faucet_min_value(FaucetStorage.load(),OP_DISCOVER_WALLETS,0); }

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return FaucetStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=faucet_evidence(FaucetStorage.load().ledger(),t3_proof_address(config,code),certificate.beginParse());return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{return calculateGasFee(0,JETTON_RECEIPT_GAS);}

get fun get_min_cooldown_restore():coins{return calculateGasFee(0,JETTON_RECEIPT_GAS);}
