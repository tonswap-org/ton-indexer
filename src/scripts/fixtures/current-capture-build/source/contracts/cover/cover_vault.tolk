tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/jetton"
import "@gen/op/t3"
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"

const COVER_BOUNCE_GAS = 250000
const COVER_PREFIX_GAS = 30000
const COVER_ADMIN_GAS = 30000

struct CoverVaultStorage {
    governance: address
    treasury: address
    jetton: Cell<JettonManagedLedger>
    sweeps: Cell<JettonSweeps>
}
fun CoverVaultStorage.load(): CoverVaultStorage { return CoverVaultStorage.fromCell(contract.getData()); }
fun CoverVaultStorage.save(self) { contract.setData(self.toCell()); }
fun CoverVaultStorage.ledger(self):JettonLedger{return self.jetton.load().ledger;}
fun CoverVaultStorage.setLedger(mutate self,ledger:JettonLedger){var m=self.jetton.load();m.ledger=ledger;self.jetton=m.toCell();}
fun CoverVaultStorage.dispatch(mutate self,slot:uint8,amount:coins){var m=self.jetton.load();m.recovery.dispatch(slot,amount);self.jetton=m.toCell();}
fun CoverVaultStorage.liabilities(self,slot:uint8):coins{return self.ledger().owedTotal(slot)+self.jetton.load().recovery.pending(slot);}
fun cover_refund(): JettonRefund {
    return { forwardGram: 0, payload: null, payloadBits: 0, payloadCells: 0, plain: true,
        keep: 0, spent: 0, bounceGas: COVER_BOUNCE_GAS, tailGas: JETTON_REFUND_TAIL_GAS, owedCap: JETTON_OWED_CAP };
}
fun cover_min_value(ledger: JettonLedger, op: int): coins {
    if (op == OP_DISCOVER_WALLETS) { return ledger.minDiscover() + calculateForwardFee(BASECHAIN, 1300, 2); }
    if (op == OP_SWEEP_PROBE) { return ledger.jetton_min_sweep(0, COVER_BOUNCE_GAS); }
    return calculateGasFee(BASECHAIN, COVER_ADMIN_GAS) + calculateForwardFee(BASECHAIN, 1300, 2);
}
fun cover_return(sender: address) {
    createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0, body: beginCell().endCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun on_credit_cover(sender:address,value:coins,body:slice){
    var st=CoverVaultStorage.load();var managed=st.jetton.load();var ledger=managed.ledger;var sweeps=st.sweeps.load();
    val state=managed.recovery.get(0);val r=JettonSweeps.onNotification(mutate sweeps,ledger,sender,body,state!=null?state! as cell:null);
    assert(r.kind!=0 || state==null) throw ERR_JETTON_RECOVERY;
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(r.kind==2){if(jetton_sweep_pay(mutate ledger,r,st.treasury,value,0,null)!=0){managed.recovery.dispatch(r.slot,r.pay);}}
    else if(r.kind==1){val c=r.credit!;
        if(!c.claimReceipt){val result=ledger.refundOrOwe(c,c.from,value,cover_refund(),4);
            assert(result!=0 || state==null) throw ERR_JETTON_RECOVERY;
            managed.recovery.handled(c.slot,c.amount);if(result==1||result==2){managed.recovery.dispatch(c.slot,c.amount);}
        }else{jetton_bounce_excess(c.from,c.queryId,value,0);}
    }
    managed.ledger=ledger;st.jetton=managed.toCell();st.save();
}
fun onBouncedMessage(in:InMessageBounced){
    var st=CoverVaultStorage.load();var managed=st.jetton.load();var ledger=managed.ledger;var sweeps=st.sweeps.load();
    val r=JettonSweeps.onBounce(mutate sweeps,ledger,in.senderAddress,in.bouncedBody);
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(!r.probe&&r.b.kind==1){val result=ledger.bounceToOwed(r.b,r.b.destination!,in.valueCoins,JETTON_OWED_CAP);
        assert(result!=0 || managed.recovery.get(r.b.slot)==null) throw ERR_JETTON_RECOVERY;
        if(result!=0){managed.recovery.restored(r.b.slot,r.b.amount);}
    }else if(r.probe){jetton_bounce_excess(r.b.excessTo,r.b.queryId,in.valueCoins,0);}
    managed.ledger=ledger;st.jetton=managed.toCell();st.save();
}
fun cover_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=CoverVaultStorage.load();var managed=st.jetton.load();val evidence=jetton_recovery_authenticate(managed.ledger,0,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(evidence);st.jetton=managed.toCell();st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT|RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);cover_return(sender);
}
fun cover_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=CoverVaultStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);var ledger=managed.ledger;
    var owner:address;var queryId:uint64;
    if(item.incoming){val credit=jetton_parse_notification(item.slot,item.body.beginParse());assert(credit!=null&&credit!.amount==item.amount&&!credit!.claimReceipt) throw ERR_JETTON_RECOVERY;owner=credit!.from;queryId=credit!.queryId;}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;owner=command.destination;queryId=command.queryId;}
    val(result,keep)=ledger.owedCredit(item.slot,owner,item.amount,1);assert(result!=0) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(item.slot,owner,item.amount,item.incoming?4:3);managed.ledger=ledger;st.jetton=managed.toCell();st.save();
    jetton_bounce_excess(sender,queryId,value,keep);
}
fun onInternalMessage(in: InMessage) {
    val body = in.body; if (body.isEmpty()) { return; }
    val op = body.preloadUint(32);
    if (op == OP_TEP74_TRANSFER_NOTIFICATION) { on_credit_cover(in.senderAddress, in.valueCoins, body); return; }
    if (op == OP_TEP74_EXCESSES) { return; }
    if(op==OP_T3_NOTIFICATION_CERTIFICATE||op==OP_T3_FAILURE_CERTIFICATE){cover_recovery_accept(in.senderAddress,in.valueCoins,body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){cover_recovery_claim(in.senderAddress,in.valueCoins,body);return;}
    var st = CoverVaultStorage.load(); var ledger = st.ledger();
    if (op == OP_TEP89_TAKE_WALLET_ADDRESS) {
        val take = ledger.checkTake(in.senderAddress, body);
        if (take == null || take.wallet == st.governance || take.wallet == st.treasury) { return; }
        ledger.commitTake(take); st.setLedger(ledger); st.save(); return;
    }
    assert (in.valueCoins >= cover_min_value(ledger, op)) throw ERR_JETTON_VALUE;
    if (op == OP_DISCOVER_WALLETS) {
        val msg = DiscoverWallets.fromSlice(body);
        reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0), RESERVE_MODE_AT_MOST);
        ledger.discover(); cover_return(in.senderAddress); return;
    }
    if (op == OP_CLAIM_ARCHIVED) {
        val msg = ClaimArchived.fromSlice(body);
        ledger.claimArchived(msg, in.senderAddress, in.valueCoins, false, COVER_BOUNCE_GAS, 0);st.dispatch(msg.slot,msg.amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_CLAIM_OWED) {
        val msg = ClaimOwed.fromSlice(body);
        val amount=ledger.owedOf(msg.slot,msg.owner);ledger.claim(msg.slot, msg.owner, msg.queryId, in.senderAddress, in.valueCoins, false, COVER_BOUNCE_GAS, 0);st.dispatch(msg.slot,amount);
        st.setLedger(ledger); st.save(); return;
    }
    if (op == OP_SWEEP_ALLOW) {
        assert (in.senderAddress == st.governance) throw ERR_JETTON_NOT_OWNER;
        val msg = SweepAllow.fromSlice(body); var sweeps = st.sweeps.load();
        sweeps.allow(ledger, msg.slot, msg.amount); st.sweeps = sweeps.toCell(); st.save();
        reserveGramsOnBalance(max(contract.getOriginalBalance() - in.valueCoins, 0), RESERVE_MODE_AT_MOST);
        cover_return(in.senderAddress); return;
    }
    if (op == OP_SWEEP_PROBE) {
        val msg = SweepProbe.fromSlice(body); var sweeps = st.sweeps.load();
        sweeps.probe(ledger,msg.slot,st.liabilities(msg.slot),in.senderAddress,in.valueCoins,COVER_BOUNCE_GAS,st.jetton.load().recovery.reconciliation(msg.slot));
        st.sweeps = sweeps.toCell(); st.save(); return;
    }
    throw ERR_JETTON_CONFIG;
}
get fun get_jetton_slots(): map<uint8, JettonSlot> { return CoverVaultStorage.load().ledger().slots; }
get fun get_owed(slot: uint8, owner: address): coins { return CoverVaultStorage.load().ledger().owedOf(slot, owner); }
get fun get_owed_book(slot: uint8): (coins, int) {
    val ledger = CoverVaultStorage.load().ledger(); return (ledger.owedTotal(slot), ledger.owedCount(slot));
}
get fun get_jetton_liabilities(slot: uint8): coins { return CoverVaultStorage.load().liabilities(slot); }
get fun get_unattributed_surplus(slot:uint8,observedBalance:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int){
    val liabilities=get_jetton_liabilities(slot)+CoverVaultStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers); return (liabilities, max(observedBalance-liabilities, 0), max(liabilities-observedBalance, 0));
}
get fun get_sweep(slot: uint8): SweepSlot { return CoverVaultStorage.load().sweeps.load().get(slot); }
get fun get_min_sweep(slot: uint8): coins { return CoverVaultStorage.load().ledger().jetton_min_sweep(slot, COVER_BOUNCE_GAS); }
get fun get_min_claim(slot: uint8): coins { return CoverVaultStorage.load().ledger().jetton_min_claim(slot, COVER_BOUNCE_GAS); }
get fun get_min_discover(): coins { return cover_min_value(CoverVaultStorage.load().ledger(), OP_DISCOVER_WALLETS); }
get fun get_min_value(op: uint32): coins { return cover_min_value(CoverVaultStorage.load().ledger(), op); }
get fun get_min_forward(op: uint32, slot: uint8): coins {
    return CoverVaultStorage.load().ledger().refundFloor(slot, cover_refund(), COVER_PREFIX_GAS);
}
get fun get_peers(): (address, address) { val st = CoverVaultStorage.load(); return (st.governance, st.treasury); }
get fun get_rent_runway(): (coins, coins) {
    val (bits, cells) = CoverVaultStorage.load().ledger().owedStorageBounds();
    return (contract.getOriginalBalance(), calculateStorageFee(BASECHAIN, 31536000, 150000+bits, 384+cells));
}

get fun get_owed_archive(slot: uint8): (uint65, uint256, coins) { return CoverVaultStorage.load().ledger().owedArchive(slot); }
get fun get_min_archive_claim(slot: uint8): coins { return CoverVaultStorage.load().ledger().jetton_min_archive_claim(slot, COVER_BOUNCE_GAS); }

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return CoverVaultStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=jetton_recovery_authenticate(CoverVaultStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{return calculateGasFee(0,JETTON_RECEIPT_GAS)+jetton_recovery_rent();}
