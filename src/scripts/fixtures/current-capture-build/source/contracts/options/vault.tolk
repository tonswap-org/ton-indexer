tolk 1.5.0
import "@gen/op/tep";
import "@stdlib/gas-payments"
import "vault_state"
import "option_messages"
import "option_limits"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep89_codec"
import "../shared/jetton/tep74_codec"
import "../shared/utils/error_codes"
import "@gen/op/jetton"
import "@gen/op/risk"
import "@gen/op/options"
import "../shared/jetton/jetton_slots"
import "factory_budget"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/protected_credit"
import "../shared/jetton/holder_recovery"
import "../t3/recovery_types"
import "../t3/receipt_tree"
import "@gen/op/t3"
import "../shared/governance/module_gate"

struct (0x46535750) HolderFeeSweep {
    queryId:uint64
}
fun vault_reserve(value:coins,delta:int){
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value+delta,0),RESERVE_MODE_AT_MOST);
}
fun vault_return(to:address){
    createMessage({
        bounce:BounceMode.NoBounce,dest:to,value:0
    }
    ).send(128|2);
}
fun vault_log(q:uint64,kind:uint8,seriesId:uint64,tokenId:uint64,intentId:uint64,amount:coins,party:address){
    createExternalLogMessage({
        dest:createAddressNone(),body:OvEvent{
            queryId:q,kind,seriesId,tokenId,intentId,amount,party
        }
    }
    ).send(2);
}
fun vault_refund():JettonRefund{
    return{
        forwardGram:0,payload:null,payloadBits:0,payloadCells:0,plain:true,keep:0,spent:0,
        bounceGas:OV_BOUNCE_GAS,tailGas:JETTON_REFUND_TAIL_GAS,owedCap:JETTON_OWED_CAP
    }
    ;
}
fun vault_pay_value(l:JettonLedger):coins{
    return calculateGasFee(BASECHAIN,OV_PAY_GAS)+4*calculateForwardFee(BASECHAIN,1300,2)+l.legValue(0,0,0,0,OV_BOUNCE_GAS);
}
fun vault_min(l:JettonLedger,op:int):coins{
    if(op==OP_CLAIM_OWED){
        return l.jetton_min_claim(0,OV_BOUNCE_GAS);
    }
    if(op==OP_CLAIM_ARCHIVED){
        return l.jetton_min_archive_claim(0,OV_BOUNCE_GAS);
    }
    if(op==OP_DISCOVER_WALLETS){
        return l.minDiscover()+calculateForwardFee(BASECHAIN,1300,2);
    }
    if(op==OP_SWEEP_PROBE){
        return l.jetton_min_sweep(0,OV_BOUNCE_GAS);
    }
    if(op==OP_OV_EXPIRE){
        return calculateGasFee(BASECHAIN,OV_EXPIRE_GAS)+6*calculateForwardFee(BASECHAIN,1400,2)+of_min_value(OP_OV_CANCEL);
    }
    if(op==OP_OPTION_WITHDRAW_RESEND){
        return calculateGasFee(BASECHAIN,OV_ADMIN_GAS)+6*calculateForwardFee(BASECHAIN,1400,2)+of_min_value(OP_OPTION_WITHDRAW_REQUEST);
    }
    if(op==OP_WRITER_WITHDRAW){
        return vault_pay_value(l)+calculateGasFee(BASECHAIN,OV_WITHDRAW_GAS)+6*calculateForwardFee(BASECHAIN,1400,2)+of_min_value(OP_OPTION_WITHDRAW_REQUEST);
    }
    if(op==OP_HOLDER_FEE_SWEEP){
        return calculateGasFee(BASECHAIN,OV_PAY_GAS)+4*calculateForwardFee(BASECHAIN,1300,2)
            +l.legValue(0,jetton_notify_value(),32,1,OV_BOUNCE_GAS);
    }
    if(op==OP_OV_COMMIT||op==OP_OV_REJECT||op==OP_OV_SETTLE||op==OP_VOID_REFUND||op==OP_OPTION_WITHDRAW_ACK){
        return vault_pay_value(l);
    }
    return calculateGasFee(BASECHAIN,OV_ADMIN_GAS)+calculateForwardFee(BASECHAIN,1300,2);
}
fun vault_forward(l:JettonLedger,op:int):coins{

    return max(l.refundFloor(0,vault_refund(),OV_CREDIT_GAS),calculateGasFee(BASECHAIN,OV_CREDIT_GAS)+of_admission_value(op==OP_OV_FUND?1:2)
    +12*calculateForwardFee(BASECHAIN,1400,2)+vault_pay_value(l));
}
// An accepted buy may reach Factory before its commit reaches this vault.
fun vault_pending(t:VaultTotals,series:uint64):int{
    val f=t.pendingBuys.get(series);
    return f.isFound?f.loadValue():0;
}
fun vault_drop_pending(mutate t:VaultTotals,series:uint64){
    val n=vault_pending(t,series);
    if(n<=1){
        t.pendingBuys.delete(series);
    }
    else{
        t.pendingBuys.set(series,(n-1) as uint16);
    }
}
fun vault_liabilities(st:VaultStorage):coins{
    val t=st.book.load().totals.load();
    return t.writer+t.escrow+t.intent+t.fees+st.ledger().owedTotal(0)+st.jetton.load().recovery.pending(0);
}
fun vault_peer(st:VaultStorage,a:address):bool{
    val p=st.peers.load();
    return a==st.gate.governance||a==p.feeSink||a==p.treasury||(p.factory!=null&&a==p.factory!);
}
fun vault_send(l:JettonLedger,q:uint64,amount:coins,to:address,payer:address,value:coins,mode:int,fwd:coins,payload:cell?=null){
    if(amount>0){
        l.sendTransfer(0,{
            queryId:q,amount,destination:to,excessTo:payer,forwardGram:fwd,forwardPayload:payload
        }
        ,value,mode);
    }
}
fun on_credit_vault(sender:address,value:coins,body:slice){
    var st=VaultStorage.load();
    var l=st.ledger();
    var sweeps=st.sweeps.load();
    val protection=st.jetton.load().recovery.get(0);
    val received=JettonSweeps.onNotification(mutate sweeps,l,sender,body,protection!=null?protection! as cell:null);
    assert(received.kind!=0||protection==null) throw ERR_JETTON_RECOVERY;
    if(received.dirty){
        st.sweeps=sweeps.toCell();
    }
    if(received.kind==2){
        if(jetton_sweep_pay(mutate l,received,st.peers.load().treasury,value,0,null)!=0){ st.dispatch(received.pay); }
        st.setLedger(l);
        st.save();
        return;
    }
    if(received.kind!=1||received.credit!.claimReceipt){
        if(received.dirty){
            st.save();
        }
        return;
    }
    val c=received.credit!;
    st.handled(c.amount);
    var p=c.payload;
    var kind=0;
    var series:uint64=0;
    var notional:coins=0;
    var valid=false;
    if(c.payloadOk&&p.remainingBitsCount()>=160&&p.remainingRefsCount()==0){
        val op=p.loadUint(32);
        val query=p.loadUint(64);
        series=p.loadUint(64);
        if(op==OP_OV_FUND&&p.isEmpty()){
            kind=1;
            valid=true;
        }
        else if(op==OP_OV_BUY){
            val n=p.tryLoadCoins();
            if(n!=null&&p.isEmpty()&&n>=OPTION_MIN_NOTIONAL){
                kind=2;
                notional=n!;
                valid=true;
            }
        }
    }
    var b=st.book.load();
    var t=b.totals.load();
    val peers=st.peers.load();
    val op=kind==1?OP_OV_FUND:OP_OV_BUY;
    if(!valid||!l.canPay(c.from)||vault_peer(st,c.from)||peers.factory==null||st.gate.withdrawalsOnly||b.intentCount>=OV_MAX_INTENTS
    ||(kind==1&&b.writerCount+b.intentCount>=OV_MAX_WRITERS)||(kind==2&&b.escrowCount+b.intentCount>=OV_MAX_ESCROWS)
    ||b.nextIntentId>=(1<<64)||value<vault_forward(l,op)||c.amount>JETTON_MAX_COINS-t.intent){
        val result=l.refundOrOwe(c,c.from,value,vault_refund(),4);
        assert(result!=0||protection==null) throw ERR_JETTON_RECOVERY;
        if(result==1||result==2){ st.dispatch(c.amount); }
        st.setLedger(l);
        st.save();
        return;
    }
    val kept=vault_pay_value(l);
    val id=b.nextIntentId as uint64;
    b.nextIntentId+=1;
    b.intentCount+=1;
    t.intent+=c.amount;
    t.nativeHeld+=kept;
    b.intents.set(id,VaultIntent{
        queryId:c.queryId,kind:kind as uint8,owner:c.from,amount:c.amount,kept,createdAt:blockchain.now(),askedAt:0,seriesId:series,notional
    }
    );
    if(kind==2){
        t.pendingBuys.set(series,(vault_pending(t,series)+1) as uint16);
    }
    b.totals=t.toCell();
    st.book=b.toCell();
    st.save();
    vault_reserve(value,kept);
    createMessage({
        bounce:BounceMode.Only256BitsOfBody,dest:peers.factory!,value:0,body:OvAdmit{
            intentId:id,kind:kind as uint8,from:c.from,amount:c.amount,seriesId:series,notional
        }
    }
    ).send(128|2);
}
// Fee payouts restore only fees; every other failed send retains its exact payee.
fun vault_source_failure(mutate st:VaultStorage,mutate l:JettonLedger,c:JettonSourceFailure,value:coins,cap:int){
    if(!c.claimReceipt&&c.destination==st.peers.load().feeSink&&c.payload!=null&&jetton_exact_tag(c.payload!,OP_HOLDER_FEE_SWEEP)){
        var b=st.book.load(); var t=b.totals.load(); t.fees+=c.amount;
        b.totals=t.toCell(); st.book=b.toCell();
        jetton_bounce_excess(c.excessTo,c.queryId,value,0);
    }else{
        val(result,keep)=l.owedCredit(0,c.destination,c.amount,cap);
        assert(result!=0) throw ERR_JETTON_RECOVERY;
        jetton_log_owed(0,c.destination,c.amount,3);
        jetton_bounce_excess(c.excessTo,c.queryId,value,keep);
    }
}
fun vault_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE; setGasLimit(250000);
    var st=VaultStorage.load(); var m=st.jetton.load();
    val e=jetton_recovery_authenticate(m.ledger,0,sender,body);
    val candidate=T3Receipt{key:e.key,payload:e.item.toCell()}.toCell();
    assert(value>=jetton_receipt_value(candidate)) throw ERR_JETTON_VALUE;
    val receipt=m.recovery.record(e); st.jetton=m.toCell(); st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT|RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    vault_return(sender);
}
fun vault_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);
    assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE; setGasLimit(250000);
    var st=VaultStorage.load(); var m=st.jetton.load();
    val item=m.recovery.claim(msg.receipt,msg.proof); var l=m.ledger; st.jetton=m.toCell();
    if(item.incoming){
        // Admission never committed. Do not buy later at different terms or time.
        val c=jetton_parse_notification(item.slot,item.body.beginParse());
        assert(c!=null&&!c!.claimReceipt&&c!.amount==item.amount) throw ERR_JETTON_RECOVERY;
        val(result,keep)=l.owedCredit(item.slot,c!.from,item.amount,1);
        assert(result!=0) throw ERR_JETTON_RECOVERY;
        jetton_log_owed(item.slot,c!.from,item.amount,3); jetton_bounce_excess(sender,c!.queryId,value,keep);
    }else{
        val c=jetton_source_failure(item.body); assert(c.amount==item.amount) throw ERR_JETTON_RECOVERY;
        vault_source_failure(mutate st,mutate l,c,value,1);
    }
    st.setLedger(l); st.save();
}
fun onBouncedMessage(in:InMessageBounced){
    var st=VaultStorage.load();
    var l=st.ledger();
    var sweeps=st.sweeps.load();
    val r=JettonSweeps.onBounce(mutate sweeps,l,in.senderAddress,in.bouncedBody);
    if(r.dirty){
        st.sweeps=sweeps.toCell();
    }
    if(r.probe||r.b.kind!=1){
        if(r.dirty){
            st.save();
        }
        return;
    }
    val command:JettonSourceFailure={queryId:r.b.queryId,amount:r.b.amount,destination:r.b.destination!,excessTo:r.b.excessTo!,claimReceipt:r.b.claimReceipt,payload:r.b.payload};
    vault_source_failure(mutate st,mutate l,command,in.valueCoins,JETTON_OWED_CAP);
    st.restored(r.b.amount);
    st.setLedger(l); st.save();
}
fun onInternalMessage(in:InMessage){
    if(in.body.remainingBitsCount()<32){
        return;
    }
    val op=in.body.preloadUint(32);
    if(op==OP_T3_NOTIFICATION_CERTIFICATE||op==OP_T3_FAILURE_CERTIFICATE){ vault_recovery_accept(in.senderAddress,in.valueCoins,in.body); return; }
    if(op==OP_JETTON_RECOVERY_CLAIM){ vault_recovery_claim(in.senderAddress,in.valueCoins,in.body); return; }
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){
        on_credit_vault(in.senderAddress,in.valueCoins,in.body);
        return;
    }
    if(op==OP_TEP74_EXCESSES){
        return;
    }
    var st=VaultStorage.load();
    var l=st.ledger();
    var peers=st.peers.load();
    var b=st.book.load();
    var totals=b.totals.load();
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){
        val take=l.checkTake(in.senderAddress,in.body);
        if(take==null||vault_peer(st,take.wallet)){
            return;
        }
        l.commitTake(take);
        st.setLedger(l);
        st.save();
        return;
    }
    if(op==OP_OV_COMMIT||op==OP_OV_REJECT||op==OP_OV_SETTLE||op==OP_VOID_REFUND||op==OP_OPTION_WITHDRAW_ACK){
        if(peers.factory==null||in.senderAddress!=peers.factory!){
            return;
        }
        if(op==OP_OV_COMMIT){
            val m=OvCommit.fromSlice(in.body);
            val found=b.intents.get(m.intentId);
            if(!found.isFound){
                return;
            }
            val i=found.loadValue();
            if(i.kind!=m.kind||i.seriesId!=m.seriesId){
                return;
            }
            val w=b.writers.get(m.seriesId);
            if(m.kind==1){
                if(w.isFound||b.writerCount>=OV_MAX_WRITERS||in.valueCoins+i.kept<vault_pay_value(l)){
                    return;
                }
                b.writers.set(m.seriesId,WriterReserve{
                    owner:i.owner,expiry:m.expiry,released:0,amounts:WriterAmounts{
                        funded:i.amount,available:i.amount,locked:0,premium:0
                    }
                    .toCell(),pending:null
                }
                );
                b.writerCount+=1;
                totals.writer+=i.amount;
                totals.nativeHeld-=i.kept;
            }
            else{
                if(!w.isFound||b.escrowCount>=OV_MAX_ESCROWS||m.net+m.fee!=i.amount||m.lock==0){
                    vault_log(i.queryId,7,i.seriesId,0,m.intentId,i.amount,i.owner);
                    return;
                }
                var writer=w.loadValue();
                var a=writer.amounts.load();
                if(m.expiry!=writer.expiry||m.lock>a.available||in.valueCoins<calculateGasFee(BASECHAIN,OV_PAY_GAS)+3*calculateForwardFee(BASECHAIN,1300,2)){
                    return;
                }
                a.available-=m.lock;
                a.locked+=m.lock;
                writer.amounts=a.toCell();
                b.writers.set(m.seriesId,writer);
                b.escrows.set(vault_key(m.seriesId,m.intentId),VaultEscrow{
                    owner:i.owner,queryId:i.queryId,net:m.net,fee:m.fee,locked:m.lock,kept:i.kept
                }
                );
                b.escrowCount+=1;
                totals.escrow+=i.amount;
            }
            if(i.kind==2){
                vault_drop_pending(mutate totals,i.seriesId);
            }
            b.intents.delete(m.intentId);
            b.intentCount-=1;
            totals.intent-=i.amount;
            b.totals=totals.toCell();
            st.book=b.toCell();
            st.save();
            vault_reserve(in.valueCoins,m.kind==1?-i.kept:0);
            vault_log(i.queryId,m.kind==1?1:2,m.seriesId,m.kind==1?0:m.intentId,m.intentId,i.amount,i.owner);
            vault_return(i.owner);
            return;
        }
        if(op==OP_OV_REJECT){
            val m=OvReject.fromSlice(in.body);
            val found=b.intents.get(m.intentId);
            if(!found.isFound){
                return;
            }
            val i=found.loadValue();
            if(in.valueCoins+i.kept<vault_pay_value(l)){
                return;
            }
            if(i.kind==2){
                vault_drop_pending(mutate totals,i.seriesId);
            }
            b.intents.delete(m.intentId);
            b.intentCount-=1;
            totals.intent-=i.amount;
            totals.nativeHeld-=i.kept;
            b.totals=totals.toCell();
            st.book=b.toCell();
            st.dispatch(i.amount);
            st.save();
            vault_reserve(in.valueCoins,-i.kept);
            vault_log(i.queryId,3,i.seriesId,0,m.intentId,i.amount,i.owner);
            vault_send(l,i.queryId,i.amount,i.owner,i.owner,l.legValue(0,0,0,0,OV_BOUNCE_GAS),1,0);
            vault_return(i.owner);
            return;
        }
        // Only the current cumulative release can consume this reserved pair.
        if(op==OP_OPTION_WITHDRAW_ACK){
            val m=OptionWithdrawAck.fromSlice(in.body);
            val found=b.writers.get(m.seriesId);
            if(!found.isFound){
                return;
            }
            var w=found.loadValue();
            if(w.pending==null){
                return;
            }
            val p=w.pending!.load();
            if(m.cumulativeBacking!=w.released+p.backing||in.valueCoins+p.kept<vault_pay_value(l)){
                return;
            }
            w.released=m.cumulativeBacking;
            w.pending=null;
            b.writers.set(m.seriesId,w);
            val amount=p.backing+p.premium;
            totals.writer-=amount;
            totals.nativeHeld-=p.kept;
            b.totals=totals.toCell();
            st.book=b.toCell();
            st.dispatch(amount);
            st.save();
            vault_reserve(in.valueCoins,-p.kept);
            vault_log(p.queryId,6,m.seriesId,0,0,amount,w.owner);
            vault_send(l,p.queryId,amount,w.owner,w.owner,l.legValue(0,0,0,0,OV_BOUNCE_GAS),1,0);
            vault_return(w.owner);
            return;
        }
        var series:uint64=0;
        var token:uint64=0;
        var owner:address;
        var payout:coins=0;
        if(op==OP_OV_SETTLE){
            val m=OvSettle.fromSlice(in.body);
            series=m.seriesId;
            token=m.tokenId;
            owner=m.holder;
            payout=m.payout;
        }
        else{
            val m=VoidRefund.fromSlice(in.body);
            series=m.seriesId;
            token=m.tokenId;
            owner=m.holder;
        }
        val key=vault_key(series,token);
        val found=b.escrows.get(key);
        val wf=b.writers.get(series);
        if(!found.isFound||!wf.isFound){
            return;
        }
        val e=found.loadValue();
        var w=wf.loadValue();
        var a=w.amounts.load();
        if(owner!=e.owner||in.valueCoins+e.kept<vault_pay_value(l)){
            return;
        }
        val paid:coins=op==OP_OV_SETTLE?(min(payout,e.locked) as coins):e.net+e.fee;
        a.locked-=e.locked;
        a.available+=e.locked-(op==OP_OV_SETTLE?paid:(0 as coins));
        if(op==OP_OV_SETTLE){
            a.premium+=e.net;
            totals.writer+=e.net-paid;
            totals.fees+=e.fee;
        }
        w.amounts=a.toCell();
        b.writers.set(series,w);
        b.escrows.delete(key);
        b.escrowCount-=1;
        totals.escrow-=e.net+e.fee;
        totals.nativeHeld-=e.kept;
        b.totals=totals.toCell();
        st.book=b.toCell();
        st.dispatch(paid);
        st.save();
        vault_reserve(in.valueCoins,-e.kept);
        vault_log(e.queryId,op==OP_OV_SETTLE?4:5,series,token,token,paid,owner);
        vault_send(l,e.queryId,paid,owner,owner,l.legValue(0,0,0,0,OV_BOUNCE_GAS),1,0);
        vault_return(owner);
        return;
    }
    assert(in.valueCoins>=vault_min(l,op)) throw ERR_JETTON_VALUE;
    if(gate_handle(mutate st.gate,in.senderAddress,in.body)){
        st.save();
        vault_reserve(in.valueCoins,0);
        vault_return(in.senderAddress);
        return;
    }
    if(op==OP_OV_CONFIG){
        val m=OvConfig.fromSlice(in.body);
        gate_require_governance(st.gate,in.senderAddress);
        assert(peers.factory==null&&l.canPay(m.factory)&&!vault_peer(st,m.factory)) throw ERR_OPTIONS_CONFIG;
        peers.factory=m.factory;
        st.peers=peers.toCell();
        st.save();
        vault_reserve(in.valueCoins,0);
        vault_return(in.senderAddress);
        return;
    }
    // Cancellation requests never spend or release the original credit.
    if(op==OP_OV_EXPIRE){
        val m=OvExpire.fromSlice(in.body);
        val i=b.intents.mustGet(m.intentId,ERR_OPTIONS_CLAIM);
        assert(blockchain.now()>=i.createdAt+180&&blockchain.now()>=i.askedAt+180) throw ERR_OPTIONS_CLAIM;
        var next=i;
        next.askedAt=blockchain.now();
        b.intents.set(m.intentId,next);
        st.book=b.toCell();
        st.save();
        createMessage({
            bounce:BounceMode.Only256BitsOfBody,dest:peers.factory!,value:0,body:OvCancel{
                intentId:m.intentId,kind:i.kind,seriesId:i.seriesId
            }
        }
        ).send(64|16);
        return;
    }
    if(op==OP_WRITER_WITHDRAW){
        val m=WriterWithdraw.fromSlice(in.body);
        var w=b.writers.mustGet(m.seriesId,ERR_OPTIONS_CLAIM);
        var a=w.amounts.load();
        assert(in.senderAddress==w.owner&&blockchain.now()>=w.expiry&&m.amount>0) throw ERR_OPTIONS_CLAIM;
        val amount=min(m.amount,a.available+a.premium);
        assert(amount>0) throw ERR_OPTIONS_CLAIM;
        val premium=min(amount,a.premium);
        val backing=amount-premium;
        assert(backing==0||(w.pending==null&&vault_pending(totals,m.seriesId)==0)) throw ERR_OPTIONS_CLAIM;
        a.premium-=premium;
        a.available-=backing;
        w.amounts=a.toCell();
        if(backing>0){
            val kept=vault_pay_value(l);
            w.pending=WriterPending{
                queryId:m.queryId,backing,premium,kept
            }
            .toCell();
            totals.nativeHeld+=kept;
            b.writers.set(m.seriesId,w);
            b.totals=totals.toCell();
            st.book=b.toCell();
            st.save();
            vault_reserve(in.valueCoins,kept);
            createMessage({
                bounce:BounceMode.Only256BitsOfBody,dest:peers.factory!,value:0,body:OptionWithdrawRequest{
                    seriesId:m.seriesId,cumulativeBacking:w.released+backing
                }
            }
            ).send(128|16);
            return;
        }
        totals.writer-=amount;
        b.writers.set(m.seriesId,w);
        b.totals=totals.toCell();
        st.book=b.toCell();
        st.dispatch(amount);
        st.save();
        vault_reserve(in.valueCoins,0);
        vault_log(m.queryId,6,m.seriesId,0,0,amount,w.owner);
        vault_send(l,m.queryId,amount,w.owner,w.owner,l.legValue(0,0,0,0,OV_BOUNCE_GAS),17,0);
        vault_return(w.owner);
        return;
    }
    if(op==OP_OPTION_WITHDRAW_RESEND){
        val m=OptionWithdrawResend.fromSlice(in.body);
        val w=b.writers.mustGet(m.seriesId,ERR_OPTIONS_CLAIM);
        assert(w.pending!=null) throw ERR_OPTIONS_CLAIM;
        createMessage({
            bounce:BounceMode.Only256BitsOfBody,dest:peers.factory!,value:0,body:OptionWithdrawRequest{
                seriesId:m.seriesId,cumulativeBacking:w.released+w.pending!.load().backing
            }
        }
        ).send(64|16);
        return;
    }
    if(op==OP_HOLDER_FEE_SWEEP){
        val m=HolderFeeSweep.fromSlice(in.body);
        assert(totals.fees>=1000000000) throw ERR_OPTIONS_CLAIM;
        val amount=totals.fees;
        totals.fees=0;
        st.dispatch(amount);
        b.totals=totals.toCell();
        st.book=b.toCell();
        st.save();
        vault_reserve(in.valueCoins,0);
        vault_send(l,m.queryId,amount,peers.feeSink,in.senderAddress,l.legValue(0,jetton_notify_value(),32,1,OV_BOUNCE_GAS),17,jetton_notify_value(),beginCell().storeUint(OP_HOLDER_FEE_SWEEP,32).endCell());
        vault_return(in.senderAddress);
        return;
    }
    if(op==OP_DISCOVER_WALLETS){
        val discovery=DiscoverWallets.fromSlice(in.body);
        vault_reserve(in.valueCoins,0);
        l.discover();
        vault_return(in.senderAddress);
        return;
    }
    if(op==OP_CLAIM_OWED){
        val m=ClaimOwed.fromSlice(in.body);
        val before=l.owedTotal(m.slot);
        l.claim(m.slot,m.owner,m.queryId,in.senderAddress,in.valueCoins,false,OV_BOUNCE_GAS,0);
        st.dispatch(before-l.owedTotal(m.slot));
        st.setLedger(l);
        st.save();
        return;
    }
    if(op==OP_CLAIM_ARCHIVED){
        val m=ClaimArchived.fromSlice(in.body);
        l.claimArchived(m,in.senderAddress,in.valueCoins,false,OV_BOUNCE_GAS,0);
        st.dispatch(m.amount);
        st.setLedger(l);
        st.save();
        return;
    }
    if(op==OP_SWEEP_ALLOW){
        val m=SweepAllow.fromSlice(in.body);
        gate_require_governance(st.gate,in.senderAddress);
        assert(m.slot==0) throw ERR_JETTON_SLOT;
        var s=st.sweeps.load();
        s.allow(l,0,m.amount);
        st.sweeps=s.toCell();
        st.save();
        vault_reserve(in.valueCoins,0);
        vault_return(in.senderAddress);
        return;
    }
    if(op==OP_SWEEP_PROBE){
        val m=SweepProbe.fromSlice(in.body);
        assert(m.slot==0) throw ERR_JETTON_SLOT;
        var s=st.sweeps.load();
        s.probe(l,0,vault_liabilities(st),in.senderAddress,in.valueCoins,OV_BOUNCE_GAS,st.jetton.load().recovery.reconciliation(0));
        st.sweeps=s.toCell();
        st.save();
        return;
    }
    throw ERR_OPTIONS_CONFIG;
}
get fun get_state():cell{
    return contract.getData();
}
get fun get_intent(id:uint64):cell?{
    val e=VaultStorage.load().book.load().intents.get(id);
    return e.isFound?e.loadValue().toCell():null;
}
get fun get_position_escrow(seriesId:uint64,tokenId:uint64):cell?{
    val e=VaultStorage.load().book.load().escrows.get(vault_key(seriesId,tokenId));
    return e.isFound?e.loadValue().toCell():null;
}
get fun writer_reserve(seriesId:uint64):cell?{
    val e=VaultStorage.load().book.load().writers.get(seriesId);
    return e.isFound?e.loadValue().toCell():null;
}
get fun get_ledger():(coins,coins,coins,coins,coins){
    val st=VaultStorage.load();
    val t=st.book.load().totals.load();
    return(t.writer,t.escrow,t.intent,t.fees,st.ledger().owedTotal(0));
}
get fun get_min_value(op:uint32):coins{
    return vault_min(VaultStorage.load().ledger(),op);
}
get fun get_min_forward(op:uint32,slot:uint8):coins{
    assert(slot==0) throw ERR_JETTON_SLOT;
    return vault_forward(VaultStorage.load().ledger(),op);
}
get fun get_jetton_slots():map<uint8,JettonSlot>{
    return VaultStorage.load().ledger().slots;
}
get fun get_jetton_liabilities(slot:uint8):coins{
    return slot==0?vault_liabilities(VaultStorage.load()):0;
}
get fun get_unattributed_surplus(slot:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?):(int,int,int){
    val n=get_jetton_liabilities(slot)+VaultStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers);
    return(n,max(observed-n,0),max(n-observed,0));
}
get fun get_owed(slot:uint8,owner:address):coins{
    return VaultStorage.load().ledger().owedOf(slot,owner);
}
get fun get_owed_book(slot:uint8):(coins,int){
    val l=VaultStorage.load().ledger();
    return(l.owedTotal(slot),l.owedCount(slot));
}
get fun get_owed_archive(slot:uint8):(uint65,uint256,coins){
    return VaultStorage.load().ledger().owedArchive(slot);
}
get fun get_min_claim(slot:uint8):coins{
    return VaultStorage.load().ledger().jetton_min_claim(slot,OV_BOUNCE_GAS);
}
get fun get_min_archive_claim(slot:uint8):coins{
    return VaultStorage.load().ledger().jetton_min_archive_claim(slot,OV_BOUNCE_GAS);
}
get fun get_min_discover():coins{
    return vault_min(VaultStorage.load().ledger(),OP_DISCOVER_WALLETS);
}
get fun get_sweep(slot:uint8):SweepSlot{
    return VaultStorage.load().sweeps.load().get(slot);
}
get fun get_min_sweep(slot:uint8):coins{
    return VaultStorage.load().ledger().jetton_min_sweep(slot,OV_BOUNCE_GAS);
}
get fun get_rent_runway():(coins,coins){
    val st=VaultStorage.load();
    val b=st.book.load();
    val(bits,cells)=st.ledger().owedStorageBounds();
    return(max(contract.getOriginalBalance()-b.totals.load().nativeHeld,0),calculateStorageFee(BASECHAIN,31536000,2000000+bits+1200*(b.writerCount+b.intentCount+b.escrowCount),4096+cells+4*b.writerCount+4*b.intentCount+2*b.escrowCount));
}

get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{ return VaultStorage.load().jetton.load().recovery.get(slot); }
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse(); b.loadUint(32); val config=b.loadRef() as Cell<ProofConfig>; b.loadRef(); val code=b.loadRef();
    val e=jetton_recovery_authenticate(VaultStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{
    JettonRecoveryItem.fromCell(receipt.load().payload);
    return calculateGasFee(0,JETTON_RECEIPT_GAS)+jetton_recovery_rent();
}
