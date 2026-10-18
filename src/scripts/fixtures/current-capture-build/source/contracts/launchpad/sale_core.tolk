tolk 1.5.0
import "@gen/op/tep";
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"
import "@gen/op/t3"
import "sale_config_codec"
import "recovery"
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "../dlmm/constants"
import "../shared/dex/swap_payload"
import "@gen/op/launchpad"
import "@gen/op/jetton"

fun sale_ready(ledger: JettonLedger): bool {
    val a=ledger.slots.get(0);val b=ledger.slots.get(1);return a.isFound&&b.isFound&&a.loadValue().wallet!=null&&b.loadValue().wallet!=null;
}
fun sale_armed(cfg: SaleConfig,b: SaleBook,ledger: JettonLedger): bool {
    val n=cfg.terms.load().caps.load().saleSupply;
    return sale_ready(ledger)&&(b.ready&(cfg.peers.load().vestingVault==null?1:3))==(cfg.peers.load().vestingVault==null?1:3)&&b.inventory>=n+n/2;
}
fun sale_open(cfg: SaleConfig,b: SaleBook,ledger: JettonLedger): bool {
    val t=cfg.terms.load();val c=t.caps.load();return b.phase==1&&sale_armed(cfg,b,ledger)&&blockchain.now()>=t.startTime&&blockchain.now()<t.endTime&&b.raised<c.hardCap&&b.sold<c.saleSupply;
}
fun sale_refund(): JettonRefund {return{forwardGram:0,payload:null,payloadBits:0,payloadCells:0,plain:true,keep:0,spent:0,bounceGas:SALE_BOUNCE_GAS,tailGas:SALE_REFUND_TAIL_GAS,owedCap:JETTON_OWED_CAP};}
fun sale_min_forward(ledger: JettonLedger,slot: uint8): coins {
    if(slot==1){return calculateGasFee(BASECHAIN,SALE_CREDIT_GAS);}
    return calculateGasFee(BASECHAIN,SALE_CREDIT_GAS+SALE_REFUND_TAIL_GAS)+SALE_ENTRY_DEPOSIT
        +ledger.legValue(slot,0,0,0,SALE_BOUNCE_GAS)+calculateForwardFee(BASECHAIN,1000,2);
}
fun sale_min_value(st: ChildStorage,op: int): coins {
    val l=st.ledger();if(op==OP_DISCOVER_WALLETS){return l.minDiscover()+launchpad_control_value();}
    if(op==OP_CLAIM_OWED){return launchpad_control_value();}
    if(op==OP_CLAIM_ARCHIVED){return launchpad_control_value();}
    if(st.config==null){return launchpad_init_value(0);}
    val cfg=SaleConfig.fromCell(st.config!);val p=cfg.peers.load();val b=SaleBook.fromCell(st.book);
    if(op==OP_SALE_FINALIZE||op==OP_SALE_CANCEL){
        var value=calculateGasFee(BASECHAIN,SALE_FIN_GAS)+8*calculateForwardFee(BASECHAIN,1300,2)+launchpad_control_value()*(p.vestingVault==null?1:2);
        if(b.phase<=1){value+=3*l.legValue(0,jetton_notify_value(),0,0,SALE_BOUNCE_GAS)+l.legValue(0,0,0,0,SALE_BOUNCE_GAS)
            +l.legValue(1,jetton_notify_value(),0,0,SALE_BOUNCE_GAS)+l.legValue(1,0,0,0,SALE_BOUNCE_GAS);}
        return value;
    }
    if(op==OP_SALE_CLAIM){return calculateGasFee(BASECHAIN,SALE_CLAIM_GAS)+3*calculateForwardFee(BASECHAIN,1300,2)
        +l.legValue(b.phase==2?1:0,0,0,0,SALE_BOUNCE_GAS);}
    return launchpad_control_value();
}
fun sale_log(q:uint64,kind:uint8,owner:address?,a:coins,b:coins){createExternalLogMessage({dest:createAddressNone(),body:SaleEvent{queryId:q,kind,owner,a,b}}).send(2);}
fun sale_pay(mutate st:ChildStorage,slot:uint8,q:uint64,amount:coins,to:address,payer:address,notify:bool){
    if(amount==0){return;}val l=st.ledger();st.dispatch(slot,amount);val fwd:coins=notify?jetton_notify_value():0;
    l.sendTransfer(slot,{queryId:q,amount,destination:to,excessTo:payer,forwardGram:fwd,forwardPayload:null},l.legValue(slot,fwd,0,0,SALE_BOUNCE_GAS),17);
}
fun sale_children(cfg:SaleConfig,success:bool){val p=cfg.peers.load();
    createMessage({bounce:BounceMode.Only256BitsOfBody,dest:p.lpVault,value:launchpad_control_value(),body:LpResult{success}}).send(17);
    if(p.vestingVault!=null){createMessage({bounce:BounceMode.Only256BitsOfBody,dest:p.vestingVault!,value:launchpad_control_value(),body:VestResult{success}}).send(17);}
}
fun on_credit_sale(sender:address,value:coins,body:slice){
    var st=ChildStorage.load();var l=st.ledger();val credit=l.onNotification(sender,body);
    if(credit==null){assert(!st.protected(0)) throw ERR_JETTON_RECOVERY;return;}
    if(credit.claimReceipt){return;}assert(st.config!=null) throw ERR_JETTON_RECOVERY;
    val c=credit!;val cfg=SaleConfig.fromCell(st.config!);val terms=cfg.terms.load();var b=SaleBook.fromCell(st.book);var reason=0;
    if(c.slot==1){if(b.phase==1&&b.raised==0&&c.amount<=JETTON_MAX_COINS-b.inventory){b.inventory+=c.amount;st.handled(c.slot,c.amount);st.book=b.toCell();st.save();return;}reason=20;}
    else{
        if(!l.canPay(c.from)){assert(!st.protected(c.slot)) throw ERR_JETTON_RECOVERY;return;}
        var payload=c.payload;var minTokens:coins?=null;
        if(c.payloadOk&&payload.remainingBitsCount()>=32&&payload.loadUint(32)==OP_SALE_CONTRIBUTE){minTokens=payload.tryLoadCoins();if(!payload.isEmpty()){minTokens=null;}}
        if(!sale_open(cfg,b,l)){reason=16;}
        else if(minTokens==null){reason=1;}
        else if(value<sale_min_forward(l,0)){reason=2;}
        else{
            val caps=terms.caps.load();val old=b.entries.get(c.from);var entry=old.isFound?old.loadValue():SaleEntry{paid:0,tokens:0};
            if(entry.paid+c.amount<caps.minContribution||entry.paid+c.amount>caps.maxContribution||b.raised+c.amount>caps.hardCap){reason=17;}
            else if(!old.isFound&&b.openEntries>=SALE_MAX_ENTRIES){reason=19;}
            else{
                val (tokens,exact,price)=sale_quote(st.identity.load().kind,terms,b.sold,c.amount,blockchain.now());
                if(tokens<max(minTokens!,1)||b.sold+tokens>caps.saleSupply||(st.identity.load().kind==1&&b.sold+tokens==caps.saleSupply&&exact!=c.amount)){reason=18;}
                else{
                    entry.paid+=c.amount;entry.tokens+=tokens;b.entries.set(c.from,entry);b.raised+=c.amount;b.sold+=tokens;
                    if(!old.isFound){b.openEntries+=1;}st.handled(c.slot,c.amount);st.book=b.toCell();st.save();
                    sale_log(c.queryId,1,c.from,c.amount,tokens);
                    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+(old.isFound?0:SALE_ENTRY_DEPOSIT),RESERVE_MODE_AT_MOST);
                    launchpad_return(c.from);return;
                }
            }
        }
    }
    var refundTo=c.from;val wrapped=c.payloadOk?swap_result_try_parse(c.payload):null;
    if(wrapped!=null&&wrapped.status==SWAP_EXECUTED){refundTo=wrapped.origin;}
    val result=l.refundOrOwe(c,refundTo,value,sale_refund(),reason as uint8);assert(result!=0||!st.protected(c.slot)) throw ERR_JETTON_RECOVERY;
    if(result!=0){st.handled(c.slot,c.amount);if(result==1||result==2){st.dispatch(c.slot,c.amount);}}st.setLedger(l);st.save();
}
fun on_take_sale(sender:address,body:slice){var st=ChildStorage.load();if(st.config==null){return;}var l=st.ledger();val t=l.checkTake(sender,body);if(t==null){return;}
    val id=st.identity.load();val p=SaleConfig.fromCell(st.config!).peers.load();
    if(t.wallet==id.factory||t.wallet==id.creator||t.wallet==p.feeSink||t.wallet==p.lpVault||(p.vestingVault!=null&&t.wallet==p.vestingVault!)){return;}
    l.commitTake(t);st.setLedger(l);st.save();
}
fun onBouncedMessage(in:InMessageBounced){var st=ChildStorage.load();var l=st.ledger();val b=l.onBounce(in.senderAddress,in.bouncedBody);
    if(b.kind==1){val result=l.bounceToOwed(b,b.destination!,in.valueCoins,JETTON_OWED_CAP);assert(result!=0||!st.protected(b.slot)) throw ERR_JETTON_RECOVERY;if(result!=0){st.restored(b.slot,b.amount);}st.setLedger(l);st.save();}
}
fun sale_recovery_claim(sender:address,value:coins,body:slice){
    val msg=JettonRecoveryClaim.fromSlice(body);assert(value>=get_min_recovery_claim(msg.receipt)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=ChildStorage.load();var managed=st.jetton.load();val item=managed.recovery.claim(msg.receipt,msg.proof);var ledger=managed.ledger;
    var owner:address;var queryId:uint64;
    if(item.incoming){val credit=jetton_parse_notification(item.slot,item.body.beginParse());assert(credit!=null&&credit!.amount==item.amount&&!credit!.claimReceipt) throw ERR_JETTON_RECOVERY;
        owner=credit!.from;queryId=credit!.queryId;val wrapped=credit!.payloadOk?swap_result_try_parse(credit!.payload):null;if(wrapped!=null&&wrapped.status==SWAP_EXECUTED){owner=wrapped.origin;}}
    else{val command=jetton_source_failure(item.body);assert(command.amount==item.amount) throw ERR_JETTON_RECOVERY;owner=command.destination;queryId=command.queryId;}
    val(result,keep)=ledger.owedCredit(item.slot,owner,item.amount,1);assert(result!=0) throw ERR_JETTON_RECOVERY;
    jetton_log_owed(item.slot,owner,item.amount,item.incoming?4:3);managed.ledger=ledger;st.jetton=managed.toCell();st.save();jetton_bounce_excess(sender,queryId,value,keep);
}
fun onInternalMessage(in:InMessage){
    if(in.body.remainingBitsCount()<32){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){on_credit_sale(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){on_take_sale(in.senderAddress,in.body);return;}
    if(op==OP_TEP74_EXCESSES){return;}
    if(op==OP_T3_NOTIFICATION_CERTIFICATE||op==OP_T3_FAILURE_CERTIFICATE){launchpad_recovery_accept(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_JETTON_RECOVERY_CLAIM){sale_recovery_claim(in.senderAddress,in.valueCoins,in.body);return;}
    var st=ChildStorage.load();val id=st.identity.load();var l=st.ledger();var b=SaleBook.fromCell(st.book);
    if(op==OP_SALE_INIT){val msg=SaleInit.fromSlice(in.body);assert(in.senderAddress==id.factory&&st.config==null&&id.role==0&&id.kind<=2) throw ERR_SALE;
        val p=msg.profile.load();l.slotAdd(0,msg.t3Master,p.walletGas,p.walletGram,false,p.budget);
        l.slotAdd(1,msg.terms.load().projectMaster,POOL_PUBLIC_WALLET_GAS_X,0,true,jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X));
        st.config=SaleConfig{feeBps:msg.feeBps,peers:msg.peers,terms:msg.terms}.toCell();b.phase=1;st.book=b.toCell();st.setLedger(l);st.initRecovery();st.save();
        reserveGramsOnBalance(launchpad_rent(0),RESERVE_MODE_AT_MOST);l.discover();launchpad_return(id.creator);return;
    }
    assert(st.config!=null) throw ERR_SALE;val cfg=SaleConfig.fromCell(st.config!);val peers=cfg.peers.load();
    if(op==OP_CHILD_READY){val msg=ChildReady.fromSlice(in.body);if(msg.role==1&&in.senderAddress==peers.lpVault){b.ready|=1;}
        else if(msg.role==2&&peers.vestingVault!=null&&in.senderAddress==peers.vestingVault!){b.ready|=2;}else{return;}
        st.book=b.toCell();st.save();return;}
    assert(in.valueCoins>=sale_min_value(st,op)) throw ERR_JETTON_VALUE;
    if(op==OP_DISCOVER_WALLETS){val discoveryRequest=DiscoverWallets.fromSlice(in.body);launchpad_reserve(in.valueCoins);l.discover();launchpad_return(in.senderAddress);return;}
    if(op==OP_CLAIM_OWED){val msg=ClaimOwed.fromSlice(in.body);val amount=l.owedOf(msg.slot,msg.owner);l.claim(msg.slot,msg.owner,msg.queryId,in.senderAddress,in.valueCoins,false,SALE_BOUNCE_GAS,0);st.dispatch(msg.slot,amount);st.setLedger(l);st.save();return;}
    if(op==OP_CLAIM_ARCHIVED){val msg=ClaimArchived.fromSlice(in.body);l.claimArchived(msg,in.senderAddress,in.valueCoins,false,SALE_BOUNCE_GAS,0);st.dispatch(msg.slot,msg.amount);st.setLedger(l);st.save();return;}
    if(op==OP_SALE_CLAIM){val msg=SaleClaim.fromSlice(in.body);assert(b.phase==2||b.phase==3) throw ERR_SALE;val e=b.entries.get(in.senderAddress);assert(e.isFound) throw ERR_SALE;
        val slot=b.phase==2?1:0;val amount=b.phase==2?e.loadValue().tokens:e.loadValue().paid;
        assert(l.owedCanCredit(slot as uint8,amount,JETTON_OWED_CAP)) throw ERR_SALE;
        b.entries.delete(in.senderAddress);b.openEntries-=1;if(b.phase==2){b.tokDue-=amount;}else{b.t3Due-=amount;}
        st.book=b.toCell();st.save();reserveGramsOnBalance(max(contract.getOriginalBalance()-in.valueCoins-SALE_ENTRY_DEPOSIT,0),RESERVE_MODE_EXACT_AMOUNT);
        sale_pay(mutate st,slot as uint8,msg.queryId,amount,in.senderAddress,in.senderAddress,false);st.save();sale_log(msg.queryId,5,in.senderAddress,slot==0?amount:0,slot==1?amount:0);launchpad_return(in.senderAddress);return;
    }
    var q:uint64=0;var cancel=false;
    if(op==OP_SALE_CANCEL){q=SaleCancel.fromSlice(in.body).queryId;assert(in.senderAddress==id.creator&&b.phase==1&&b.raised==0&&(!sale_armed(cfg,b,l)||blockchain.now()<cfg.terms.load().startTime)) throw ERR_SALE;cancel=true;}
    else if(op==OP_SALE_FINALIZE){q=SaleFinalize.fromSlice(in.body).queryId;
        if(b.phase>=2){launchpad_reserve(in.valueCoins);sale_children(cfg,b.phase==2);launchpad_return(in.senderAddress);return;}
        val t=cfg.terms.load();val c=t.caps.load();assert(b.phase==1&&(blockchain.now()>=t.endTime||b.raised==c.hardCap||b.sold==c.saleSupply)) throw ERR_SALE;
    }else{throw ERR_SALE;}
    val success=!cancel&&b.sold>0&&b.raised>=cfg.terms.load().caps.load().softCap;
    launchpad_reserve(in.valueCoins);
    if(success){val fee=b.raised*cfg.feeBps/10000;val net=b.raised-fee;val lp=net/2;val tok=b.sold/2;
        sale_pay(mutate st,0,q,fee,peers.feeSink,in.senderAddress,true);sale_pay(mutate st,0,q,lp,peers.lpVault,in.senderAddress,true);
        sale_pay(mutate st,1,q,tok,peers.lpVault,in.senderAddress,true);sale_pay(mutate st,0,q,net-lp,id.creator,in.senderAddress,false);
        sale_pay(mutate st,1,q,b.inventory-b.sold-tok,id.creator,in.senderAddress,false);b.tokDue=b.sold;b.phase=2;
    }else{sale_pay(mutate st,1,q,b.inventory,id.creator,in.senderAddress,false);b.t3Due=b.raised;b.phase=cancel?4:3;}
    sale_children(cfg,success);sale_log(q,b.phase,null,b.raised,b.sold);st.book=b.toCell();st.save();launchpad_return(in.senderAddress);
}
get fun get_sale(): (cell,cell,bool,bool) {val st=ChildStorage.load();if(st.config==null){return(beginCell().endCell(),st.book,false,false);}val cfg=SaleConfig.fromCell(st.config!);val b=SaleBook.fromCell(st.book);return(st.config!,st.book,sale_armed(cfg,b,st.ledger()),sale_open(cfg,b,st.ledger()));}
get fun get_entry(owner:address): (coins,coins){val e=SaleBook.fromCell(ChildStorage.load().book).entries.get(owner);return e.isFound?(e.loadValue().paid,e.loadValue().tokens):(0,0);}
get fun get_quote(amount:coins): (coins,coins,coins){val st=ChildStorage.load();return sale_quote(st.identity.load().kind,SaleConfig.fromCell(st.config!).terms.load(),SaleBook.fromCell(st.book).sold,amount,blockchain.now());}
get fun get_jetton_slots(): map<uint8,JettonSlot>{return ChildStorage.load().ledger().slots;}
get fun get_jetton_liabilities(slot:uint8): coins{val st=ChildStorage.load();val b=SaleBook.fromCell(st.book);return st.ledger().owedTotal(slot)+st.jetton.load().recovery.pending(slot)+(slot==0?(b.phase==1?b.raised:b.t3Due):(b.phase==1?b.inventory:b.tokDue));}
get fun get_unattributed_surplus(slot:uint8,observed:coins,protectedCredits:int?,acceptedTransfers:int?): (int,int,int){val l=get_jetton_liabilities(slot)+ChildStorage.load().jetton.load().recovery.excluded(slot,protectedCredits,acceptedTransfers);return(l,max(observed-l,0),max(l-observed,0));}
get fun get_owed(slot:uint8,owner:address): coins{return ChildStorage.load().ledger().owedOf(slot,owner);}
get fun get_owed_book(slot:uint8): (coins,int){val l=ChildStorage.load().ledger();return(l.owedTotal(slot),l.owedCount(slot));}
get fun get_owed_archive(slot:uint8): (uint65,uint256,coins){return ChildStorage.load().ledger().owedArchive(slot);}
get fun get_min_claim(slot:uint8): coins{return ChildStorage.load().ledger().jetton_min_claim(slot,SALE_BOUNCE_GAS);}
get fun get_min_archive_claim(slot:uint8): coins{return ChildStorage.load().ledger().jetton_min_archive_claim(slot,SALE_BOUNCE_GAS);}
get fun get_min_forward(op:uint32,slot:uint8): coins{return sale_min_forward(ChildStorage.load().ledger(),slot);}
get fun get_min_value(op:uint32): coins{return sale_min_value(ChildStorage.load(),op);}
get fun get_min_discover(): coins{return sale_min_value(ChildStorage.load(),OP_DISCOVER_WALLETS);}
