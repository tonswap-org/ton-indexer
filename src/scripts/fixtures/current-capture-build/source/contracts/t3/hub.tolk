tolk 1.5.0
import "@gen/op/tep";
import "@stdlib/gas-payments";
import "@stdlib/exotic-cells";
import "hub_types";
import "fresh_math";
import "receipt_tree";
import "reserve_credit";
import "deposit_intent";
import "recovery_types";
import "wallet_types";
import "wallet_budget";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/tep89_codec";
import "../generated/op/t3";
import "../generated/op/jetton";
import "../generated/op/governance";

import "hub_helpers";
import "../shared/governance/module_gate";

fun t3_hub_plan(st:T3HubState,record:T3HubCredit,slot:int,key:uint64): (coins,OutMessage?) {
    var cost:coins=0;var message:OutMessage?=null;val credit=record.credit.load();
    if(record.mint!=null){val(c,m)=st.mint_plan(slot,key,record.mint!.load(),credit.queryId,credit.owner);cost+=c;message=m;}
    if(record.payout!=null){cost+=st.payout_cost(record.payout!.load());}
    return (cost,message);
}
fun t3_hub_send(st:T3HubState,record:T3HubCredit,slot:int,key:uint64,mint:OutMessage?) {
    if(mint!=null){mint!.send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);}
    if(record.payout!=null){st.send_payout(record.payout!.load(),0,slot,key,-1);}
}
fun t3_hub_accept_record(record:T3HubCredit,intent:T3HubIntent,q:T3MathQuote,lt:uint64): T3HubCredit {
    var next=record;val credit=record.credit.load();next.phase=T3_HUB_ACCEPTED;
    if(q.minted>0){next.mint=T3HubMint{amount:q.minted as coins,recipient:intent.recipient,attempt:0,sentLt:lt,status:T3_HUB_SENT}.toCell();}
    next.payout=t3_hub_payout(credit.owner,intent.kind==T3_MATH_PAIR?credit.owner:intent.recipient,credit.queryId,q.payout,lt);return next;
}
fun t3_hub_register(mutate st:T3HubState,receipt:T3Receipt,value:coins,topup:coins,slot:int,historical:cell?) {
    var credit=T3ReserveCredit.fromCell(receipt.payload);credit.intent=t3_deposit_intent(credit.intent);
    val intent=t3_hub_read_intent(credit.intent,false);
    var e=st.economy.load();
    e.pending=e.pending.load().add(slot,credit.amount).toCell();st.economy=e.toCell();
    var record:T3HubCredit={phase:T3_HUB_PENDING,linkedSlot:0,linkedKey:0,credit:credit.toCell(),mint:null,payout:null,staged:null};
    var accepted=false;var mint:OutMessage?=null;
    if(intent!=null && intent.kind!=T3_MATH_PAIR && value>=topup+calculateGasFee(0,T3_HUB_GAS)){
        val q=st.quote(intent,slot,credit.amount,0);
        if(q.status==T3_MATH_OK){
            val candidate=t3_hub_accept_record(record,intent,q,blockchain.logicalTime() as uint64);
            val(cost,message)=t3_hub_plan(st,candidate,slot,receipt.key);
            if(value>=topup+calculateGasFee(0,T3_HUB_GAS)+cost
                +t3_wallet_excess_fee(credit.queryId,credit.owner)){
                record=candidate;st.apply(q,slot,credit.amount,-1,0);accepted=true;mint=message;
            }
        }
    }
    val wrapped=T3Receipt{key:receipt.key,payload:record.toCell()}.toCell();
    if(historical==null){st.append(slot,wrapped);}
    else{var trees=st.trees.load();var tree=trees.get(slot);tree.replace(null,wrapped,historical!);trees.put(slot,tree);st.trees=trees.toCell();}
    st.save();st.log(slot,wrapped);
    if(accepted){t3_hub_send(st,record,slot,receipt.key,mint);}
    t3_hub_return(credit.queryId,credit.owner);
}
fun onBouncedMessage(in:InMessageBounced) {
    var st=T3HubState.load();val b=st.ledger.load().onBounce(in.senderAddress,in.bouncedBody);
    if(b.kind!=1 || b.payloadTag!=OP_T3_HUB_PAYOUT || b.payload==null || b.amount==0 || b.bouncedByPhase!=1){return;}
    var(payload,exotic)=b.payload!.beginParseSpecial();
    if(exotic || payload.remainingBitsCount()!=32 || payload.remainingRefsCount()!=1){return;}
    payload.skipBits(32);val(identityBits,identityExotic)=payload.loadRef().beginParseSpecial();
    if(identityExotic || identityBits.remainingBitsCount()!=134 || identityBits.remainingRefsCount()!=0){return;}
    val identity=T3HubIdentity.fromSlice(identityBits);
    if(identity.output!=b.slot || identity.key==0 || identity.domain!=(identity.slot==3?1:0)){return;}
    val policy=st.config.load().policies.mustGet(b.slot);var e=st.economy.load();val clears=e.clears.load();
    if(b.originalLt<=(b.slot==0?clears.r0:(b.slot==1?clears.r1:clears.r2))){return;}
    if(e.backing.math().at(b.slot)>0 && ((policy.lockExit!=0 && b.exitCode==policy.lockExit)
        || (policy.balanceExit!=0 && b.exitCode==policy.balanceExit))){
        assert(in.valueCoins>=calculateGasFee(0,T3_HUB_BOUNCE_GAS)) throw 1002;
        e.frozen=(e.frozen|(1<<b.slot)) as uint3;st.economy=e.toCell();
        st.reserve(in.valueCoins);st.save();t3_hub_return(b.queryId,b.excessTo);
    }
    // Neither a mint bounce nor a payout bounce changes supply or the exact claim.
    // The certificate path binds a current leaf without an unbounded bounce journal.
}
fun t3_hub_pair(mutate st:T3HubState,sender:address,value:coins,topup:coins,mode:int,aSlot:int,a:T3HubWitness,b:T3HubWitness) {
    assert(aSlot<2) throw 1000;val bSlot=1-aSlot;val ar=a.record.load();val br=b.record.load();
    var first=T3HubCredit.fromCell(ar.payload);var second=T3HubCredit.fromCell(br.payload);
    val ac=first.credit.load();val bc=second.credit.load();
    assert(ac.owner==bc.owner && sender==ac.owner) throw 1003;
    val ai=t3_hub_read_intent(ac.intent,false);val bi=t3_hub_read_intent(bc.intent,false);
    assert(ai!=null && bi!=null && ai.kind==T3_MATH_PAIR && bi.kind==T3_MATH_PAIR
        && ai.recipient==bi.recipient) throw 1004;
    if(mode==0){
        assert(first.phase==T3_HUB_PENDING && second.phase==T3_HUB_PENDING) throw 1005;
        st.trees.load().get(bSlot).verify(b);first.phase=T3_HUB_BOUND;first.linkedSlot=bSlot as uint2;first.linkedKey=br.key;
        st.replace(aSlot,a,first.toCell());
        st.save();st.log(aSlot,T3Receipt{key:ar.key,payload:first.toCell()}.toCell());t3_hub_return(ac.queryId,sender);return;
    }
    assert(first.phase==T3_HUB_BOUND && first.linkedSlot==bSlot && first.linkedKey==br.key) throw 1005;
    if(mode==1){
        assert(!((second.phase==T3_HUB_ACCEPTED || second.phase==T3_HUB_SEALED) && second.linkedSlot==aSlot && second.linkedKey==ar.key)) throw 1005;
        st.trees.load().get(bSlot).verify(b);first.phase=T3_HUB_PENDING;first.linkedSlot=0;first.linkedKey=0;
        st.replace(aSlot,a,first.toCell());st.save();st.log(aSlot,T3Receipt{key:ar.key,payload:first.toCell()}.toCell());
        t3_hub_return(ac.queryId,sender);return;
    }
    assert(mode==2 && second.phase==T3_HUB_PENDING) throw 1004;st.trees.load().get(aSlot).verify(a);
    second.phase=T3_HUB_SEALED;second.linkedSlot=aSlot as uint2;second.linkedKey=ar.key;second.staged=first.credit;
    st.replace(bSlot,b,second.toCell());st.save();
    st.log(bSlot,T3Receipt{key:br.key,payload:second.toCell()}.toCell());t3_hub_return(bc.queryId,sender);
}
fun t3_hub_failed_mint(mutate st:T3HubState,sender:address,config:Cell<ProofConfig>,proofCode:cell,slot:int,w:T3HubWitness) {
    val cfg=st.config.load();assert(sender==t3_checked_proof_address(config,proofCode,cfg.proofCodeHash)) throw 1040;
    val receipt=w.record.load();var record=T3HubCredit.fromCell(receipt.payload);
    assert(slot<3 && record.phase==T3_HUB_ACCEPTED && record.mint!=null) throw 1005;
    val credit=record.credit.load();var mint=record.mint!.load();assert(mint.status==T3_HUB_SENT) throw 1005;
    val c=config.load().credit.load();var ids=c.identities.beginParse();
    assert(ids.loadAddress()==contract.getAddress() && ids.loadAddress()==mint.recipient && ids.loadAddress()==contract.getAddress()) throw 1041;ids.assertEnd();
    val wallet=t3_wallet_init(mint.recipient,contract.getAddress(),cfg.proofCodeHash,cfg.walletCode).calculateAddress();
    var wallets=c.wallets.beginParse();assert(wallets.loadAddress()==wallet && wallets.loadAddress()==wallet
        && wallets.loadUint(64)==credit.queryId && wallets.loadCoins()==mint.amount) throw 1042;wallets.assertEnd();
    assert(c.codeHash==cfg.walletCode.hash() && c.requestHash==t3_wallet_mint_body(credit.queryId,mint.amount,
        t3_hub_mint_identity(slot,receipt.key,mint.attempt),credit.owner).hash()) throw 1043;
    val targets=config.load().targets.load();assert(targets.source.hash()==targets.target.hash() && targets.source.load().lt>mint.sentLt) throw 1044;
    mint.status=T3_HUB_FAILED;record.mint=mint.toCell();st.replace(slot,w,record.toCell());st.save();
    st.log(slot,T3Receipt{key:receipt.key,payload:record.toCell()}.toCell());t3_hub_return(credit.queryId,credit.owner);
}
fun t3_hub_failed_payout(mutate st:T3HubState,sender:address,config:Cell<ProofConfig>,proofCode:cell,slot:int,output:int,w:T3HubWitness,routed:bool) {
    assert(slot<=3 && output<3) throw 1000;val cfg=st.config.load();
    assert(sender==t3_checked_proof_address(config,proofCode,cfg.proofCodeHash)) throw 1040;
    var payout=t3_hub_get_payout(w.record,slot);var legs=payout.legs.load();var leg=legs.at(output);
    assert(leg.amount>0 && leg.status==T3_HUB_SENT) throw 1005;
    val reserve=st.ledger.load().slots.mustGet(output as uint8);assert(reserve.wallet!=null) throw 1006;
    val c=config.load().credit.load();var ids=c.identities.beginParse();
    assert(ids.loadAddress()==contract.getAddress() && ids.loadAddress()==leg.recipient && ids.loadAddress()==reserve.master) throw 1041;ids.assertEnd();
    var wallets=c.wallets.beginParse();assert(wallets.loadAddress()==reserve.wallet!) throw 1042;val target=wallets.loadAddress();
    assert((routed || target==reserve.wallet!) && wallets.loadUint(64)==payout.queryId && wallets.loadCoins()==leg.amount) throw 1042;wallets.assertEnd();
    assert(c.codeHash==cfg.policies.mustGet(output as uint8).codeHash && c.requestHash==tep74_transfer_body(
        t3_hub_transfer(payout,slot==3?1:0,slot,w.record.load().key,output)).endCell().hash()) throw 1043;
    val targets=config.load().targets.load();assert(targets.source.load().lt>leg.sentLt) throw 1044;
    assert(routed?targets.target.load().lt>targets.source.load().lt:targets.source.hash()==targets.target.hash()) throw 1044;
    leg.status=T3_HUB_FAILED;legs.put(output,leg);payout.legs=legs.toCell();st.put_payout(slot,w,payout);t3_hub_return(payout.queryId,payout.owner);
}
fun t3_hub_burn(mutate st:T3HubState,sender:address,value:coins,createdLt:uint64,body:slice,topup:coins) {
    body.skipBits(32);val attempt=body.loadRef() as Cell<WalletAttempt>;body.assertEnd();val a=attempt.load();val terms=a.terms.load();val details=terms.details.load();val cfg=st.config.load();
    assert(terms.burn && terms.amount>0 && terms.recipient==terms.owner && a.originLt>0 && createdLt>a.originLt
        && sender==t3_wallet_init(terms.owner,contract.getAddress(),cfg.proofCodeHash,cfg.walletCode).calculateAddress()) throw 1003;
    var payout:Cell<T3HubPayout>?=null;var e=st.economy.load();
    if(details.customPayload==null){assert(e.supply>=T3_MATH_DEAD && terms.amount<=e.supply-T3_MATH_DEAD) throw 1019;e.supply-=terms.amount;st.economy=e.toCell();}
    else{
        val intent=t3_hub_read_intent(details.customPayload!,true);assert(intent!=null) throw 1004;
        val q=st.quote(intent,0,terms.amount,0);assert(q.status==T3_MATH_OK) throw 1010+q.status;
        payout=t3_hub_payout(terms.owner,intent.recipient,details.queryId,q.payout,blockchain.logicalTime() as uint64);
        assert(payout!=null && value>=topup+calculateGasFee(0,T3_HUB_GAS)+st.payout_cost(payout!.load())+t3_wallet_excess_fee(details.queryId,details.response)) throw 1002;
        st.apply(q,-1,0,-1,0);
    }
    val key=blockchain.logicalTime() as uint64;val record=T3Receipt{key,payload:T3HubBurn{attempt,payout}.toCell()}.toCell();
    st.append(3,record);st.save();st.log(3,record);if(payout!=null){st.send_payout(payout!.load(),1,3,key,-1);}
    t3_hub_return(details.queryId,details.response);return;
}
fun onInternalMessage(in:InMessage) {
    if(in.body.remainingBitsCount()<32){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_EXCESSES){return;}
    var st=T3HubState.load();var ledger=st.ledger.load();var body=in.body;body.skipBits(32);
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){
        val take=ledger.checkTake(in.senderAddress,in.body);if(take==null){return;}
        ledger.commitTake(take);st.ledger=ledger.toCell();st.save();return;
    }
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){
        val credit=ledger.onNotification(in.senderAddress,in.body);if(credit==null || credit.slot>2 || in.createdLt<=1){return;}
        assert(in.valueCoins>=calculateGasFee(0,T3_HUB_GAS)) throw 1002;val topup=st.reserve(in.valueCoins);
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_GAS)+t3_wallet_excess_fee(credit.queryId,credit.from)) throw 1002;
        // A malformed intent remains an exact owner refund claim; no credit is discarded.
        val c:T3ReserveCredit={certified:false,owner:credit.from,queryId:credit.queryId,amount:credit.amount,
            intent:credit.payloadOk?beginCell().storeSlice(credit.payload).endCell():createEmptyCell(),evidence:null};
        t3_hub_register(mutate st,{key:(in.createdLt-1) as uint64,payload:c.toCell()},in.valueCoins,topup,credit.slot,null);return;
    }
    if(op==OP_T3_CREDIT_CERTIFICATE){
        val hash=body.loadUint(256);val config=body.loadRef() as Cell<ProofConfig>;var p=body.loadRef().beginParse();val proofCode=body.loadRef();body.assertEnd();
        val slot=p.loadUint(2);val path=p.loadMaybeRef();p.assertEnd();assert(slot<3) throw 1000;
        val s=ledger.slots.mustGet(slot as uint8);assert(s.wallet!=null) throw 1006;val cfg=st.config.load();
        assert(in.valueCoins>=calculateGasFee(0,T3_HUB_GAS)) throw 1002;val topup=st.reserve(in.valueCoins);
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_GAS)) throw 1002;
        val receipt=t3_credit_certificate(in.senderAddress,config,proofCode,cfg.proofCodeHash,contract.getAddress(),s.master,s.wallet!,cfg.policies.mustGet(slot as uint8).codeHash,hash as uint256);
        t3_hub_register(mutate st,receipt,in.valueCoins,topup,slot,path);return;
    }
    if(op==OP_TEP89_PROVIDE_WALLET_ADDRESS){
        val q=body.loadUint(64);val owner=body.loadAddressAny();val include=body.loadBool();body.assertEnd();
        assert(in.valueCoins>=calculateGasFee(0,T3_HUB_ADMIN_GAS)) throw 1002;val topup=st.reserve(in.valueCoins);
        val cfg=st.config.load();var answer=beginCell().storeUint(OP_TEP89_TAKE_WALLET_ADDRESS,32).storeUint(q,64);
        if(owner.isInternal() && owner.castToInternal().getWorkchain()==0){answer.storeAddress(t3_wallet_init(owner.castToInternal(),contract.getAddress(),cfg.proofCodeHash,cfg.walletCode).calculateAddress());}
        else{answer.storeAddressNone();}
        answer.storeMaybeRef(include?beginCell().storeAddressAny(owner).endCell():null);
        val message=createMessage({bounce:BounceMode.NoBounce,dest:in.senderAddress,value:0,body:answer});
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_ADMIN_GAS)+message.estimateFeeWithoutSending(SEND_MODE_REGULAR)) throw 1002;
        message.send(SEND_MODE_CARRY_ALL_BALANCE|SEND_MODE_BOUNCE_ON_ACTION_FAIL);return;
    }
    val admin=op==OP_T3_GOV || op==OP_WITHDRAWALS_ONLY_ON || op==OP_WITHDRAWALS_ONLY_OFF || op==OP_DISCOVER_WALLETS;
    val gas=admin?T3_HUB_ADMIN_GAS:T3_HUB_GAS;
    assert(in.valueCoins>=calculateGasFee(0,gas)) throw 1002;val topup=st.reserve(in.valueCoins);
    assert(in.valueCoins>=topup+calculateGasFee(0,gas)+t3_wallet_excess_fee(0,in.senderAddress)) throw 1002;
    if(op==OP_DISCOVER_WALLETS){
        val msg=DiscoverWallets.fromSlice(in.body);assert(in.valueCoins>=topup+ledger.minDiscover()+calculateGasFee(0,T3_HUB_ADMIN_GAS)) throw 1002;
        ledger.discover();t3_hub_return(msg.queryId,in.senderAddress);return;
    }
    if(op==OP_WITHDRAWALS_ONLY_ON || op==OP_WITHDRAWALS_ONLY_OFF){
        body.assertEnd();assert(in.senderAddress==st.config.load().governance) throw 1003;
        var e=st.economy.load();e.withdrawalsOnly=op==OP_WITHDRAWALS_ONLY_ON;st.economy=e.toCell();st.save();t3_hub_return(0,in.senderAddress);return;
    }
    if(op==OP_T3_GOV){
        val q=body.loadUint(64);val action=body.loadUint(8);val cfg=st.config.load();var e=st.economy.load();
        assert(in.senderAddress==cfg.governance) throw 1003;
        if(action==1){val fee=body.loadUint(16);assert(fee<=100) throw 1004;e.feeBps=fee as uint16;}
        else{val mask=body.loadUint(3);assert(action>=2 && action<=4 && (action!=2 || mask!=0)) throw 1004;
            if(action==2){e.frozen=(e.frozen|mask) as uint3;}else if(action==3){e.frozen=mask as uint3;var clears=e.clears.load();val lt=blockchain.logicalTime() as uint64;
                if((mask&1)==0){clears.r0=lt;}if((mask&2)==0){clears.r1=lt;}if((mask&4)==0){clears.r2=lt;}e.clears=clears.toCell();}
            else{var i=0;repeat(3){if((mask&(1<<i))!=0){assert(ledger.slots.mustGet(i as uint8).wallet!=null) throw 1006;}i+=1;}e.admitted=mask as uint3;}}
        body.assertEnd();st.economy=e.toCell();st.save();t3_hub_return(q,in.senderAddress);return;
    }
    if(op==OP_T3_HUB_PAIR_BIND){
        val mode=body.loadUint(2);val slot=body.loadUint(2);val a=T3HubWitness.fromCell(body.loadRef());val b=T3HubWitness.fromCell(body.loadRef());body.assertEnd();
        t3_hub_pair(mutate st,in.senderAddress,in.valueCoins,topup,mode,slot,a,b);return;
    }
    if(op==OP_T3_HUB_ACCEPT || op==OP_T3_HUB_REFUND){
        val slot=body.loadUint(2);val refundTo=op==OP_T3_HUB_REFUND?body.loadAddressOpt():null;val w=T3HubWitness.fromCell(body.loadRef());body.assertEnd();assert(slot<3) throw 1000;
        var record=T3HubCredit.fromCell(w.record.load().payload);val credit=record.credit.load();assert(record.phase==T3_HUB_PENDING || record.phase==T3_HUB_SEALED) throw 1005;
        if(op==OP_T3_HUB_REFUND){
            assert(in.senderAddress==credit.owner) throw 1003;val recipient=refundTo==null?credit.owner:refundTo!;assert(ledger.canPay(recipient)) throw 1004;record.phase=T3_HUB_REFUNDED;
            record.payout=t3_hub_payout(credit.owner,recipient,credit.queryId,t3_math_zero().put(slot,credit.amount),blockchain.logicalTime() as uint64);
            var e=st.economy.load();e.pending=e.pending.load().add(slot,-credit.amount).toCell();st.economy=e.toCell();
        }else{
            var intent=t3_hub_read_intent(credit.intent,false);assert(intent!=null) throw 1004;var staged:coins=0;var other=-1;
            if(record.phase==T3_HUB_SEALED){
                assert(intent.kind==T3_MATH_PAIR && record.staged!=null && slot<2 && record.linkedSlot==1-slot) throw 1005;
                val first=record.staged!.load();val firstIntent=t3_hub_read_intent(first.intent,false);
                assert(first.owner==credit.owner && firstIntent!=null && firstIntent.kind==T3_MATH_PAIR && firstIntent.recipient==intent.recipient) throw 1005;
                intent.minOut=max(intent.minOut,firstIntent.minOut) as coins;staged=first.amount;other=record.linkedSlot;
            }else{assert(intent.kind!=T3_MATH_PAIR) throw 1004;}
            val q=st.quote(intent,slot,credit.amount,staged);assert(q.status==T3_MATH_OK) throw 1010+q.status;
            record=t3_hub_accept_record(record,intent,q,blockchain.logicalTime() as uint64);st.apply(q,slot,credit.amount,other,staged);
        }
        record.staged=null;
        val(cost,message)=t3_hub_plan(st,record,slot,w.record.load().key);
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_GAS)+cost+t3_wallet_excess_fee(credit.queryId,in.senderAddress)) throw 1002;
        st.replace(slot,w,record.toCell());st.save();st.log(slot,T3Receipt{key:w.record.load().key,payload:record.toCell()}.toCell());
        t3_hub_send(st,record,slot,w.record.load().key,message);t3_hub_return(credit.queryId,in.senderAddress);return;
    }
    if(op==OP_T3_WALLET_BURN){t3_hub_burn(mutate st,in.senderAddress,in.valueCoins,in.createdLt,in.body,topup);return;}
    if(op==OP_T3_FAILURE_CERTIFICATE || op==OP_T3_ROUTED_FAILURE_CERTIFICATE){
        val routed=op==OP_T3_ROUTED_FAILURE_CERTIFICATE;if(routed){body.loadUint(256);}
        val config=body.loadRef() as Cell<ProofConfig>;var p=body.loadRef().beginParse();val proofCode=body.loadRef();body.assertEnd();
        val kind=p.loadUint(2);val slot=p.loadUint(2);val output=p.loadUint(2);val w=T3HubWitness.fromCell(p.loadRef());p.assertEnd();
        if(kind==0){assert(!routed && output==0) throw 1004;t3_hub_failed_mint(mutate st,in.senderAddress,config,proofCode,slot,w);}
        else{assert(kind==1) throw 1004;t3_hub_failed_payout(mutate st,in.senderAddress,config,proofCode,slot,output,w,routed);}return;
    }
    if(op==OP_T3_HUB_MINT_RETRY){
        val slot=body.loadUint(2);val redirect=body.loadAddressOpt();val w=T3HubWitness.fromCell(body.loadRef());body.assertEnd();assert(slot<3) throw 1000;
        var record=T3HubCredit.fromCell(w.record.load().payload);val credit=record.credit.load();assert(record.phase==T3_HUB_ACCEPTED && record.mint!=null) throw 1005;
        var mint=record.mint!.load();assert(mint.status==T3_HUB_FAILED && mint.attempt<18446744073709551615) throw 1005;
        if(redirect!=null && redirect!=mint.recipient){assert(in.senderAddress==credit.owner && ledger.canPay(redirect!)) throw 1003;mint.recipient=redirect!;}
        mint.attempt+=1;mint.status=T3_HUB_SENT;mint.sentLt=blockchain.logicalTime() as uint64;record.mint=mint.toCell();
        val(cost,message)=st.mint_plan(slot,w.record.load().key,mint,credit.queryId,credit.owner);
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_GAS)+cost+t3_wallet_excess_fee(credit.queryId,in.senderAddress)) throw 1002;
        st.replace(slot,w,record.toCell());st.save();st.log(slot,T3Receipt{key:w.record.load().key,payload:record.toCell()}.toCell());
        message.send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);t3_hub_return(credit.queryId,in.senderAddress);return;
    }
    if(op==OP_T3_HUB_PAYOUT_RETRY){
        val slot=body.loadUint(2);val output=body.loadUint(2);val redirect=body.loadAddressOpt();val w=T3HubWitness.fromCell(body.loadRef());body.assertEnd();assert(output<3) throw 1000;
        var payout=t3_hub_get_payout(w.record,slot);var legs=payout.legs.load();var leg=legs.at(output);
        assert(leg.amount>0 && leg.status==T3_HUB_FAILED && leg.attempt<18446744073709551615) throw 1005;
        if(redirect!=null && redirect!=leg.recipient){assert(in.senderAddress==payout.owner && ledger.canPay(redirect!)) throw 1003;leg.recipient=redirect!;}
        leg.attempt+=1;leg.sentLt=blockchain.logicalTime() as uint64;leg.status=T3_HUB_SENT;legs.put(output,leg);payout.legs=legs.toCell();
        assert(in.valueCoins>=topup+calculateGasFee(0,T3_HUB_GAS)+st.leg_cost(payout,output)+t3_wallet_excess_fee(payout.queryId,in.senderAddress)) throw 1002;
        st.put_payout(slot,w,payout);st.send_payout(payout,slot==3?1:0,slot,w.record.load().key,output);t3_hub_return(payout.queryId,in.senderAddress);return;
    }
    throw 1007;
}
get fun get_jetton_data(): (coins,bool,address?,cell,cell) {
    val st=T3HubState.load();val cfg=st.config.load();val supply=st.economy.load().supply;
    return ((supply>0?supply-T3_MATH_DEAD:0) as coins,true,null,cfg.metadata,cfg.walletCode);
}
get fun get_wallet_address(owner:address): address {val cfg=T3HubState.load().config.load();return t3_wallet_init(owner,contract.getAddress(),cfg.proofCodeHash,cfg.walletCode).calculateAddress();}
get fun get_t3_master(): address {return contract.getAddress();}
get fun get_ready(): bool {return T3HubState.load().ledger.load().coreReady();}
get fun get_hub_state(): cell {return T3HubState.load().economy;}
get fun get_hub_config(): cell {return T3HubState.load().config;}
get fun get_jetton_ledger(): cell {return T3HubState.load().ledger;}
get fun get_receipt_tree(slot:int): cell {return T3HubState.load().trees.load().get(slot).toCell();}
get fun get_quote(intent:cell,slot:int,amount:coins,staged:coins,burn:bool): (int,int,coins,coins,coins,coins,int) {
    val st=T3HubState.load();val parsed=t3_hub_read_intent(intent,burn);if(parsed==null){return (1,0,0,0,0,0,0);}
    val q=st.quote(parsed,slot,amount,staged);return(q.status,q.detail,q.minted as coins,q.payout.r0 as coins,q.payout.r1 as coins,q.payout.r2 as coins,q.feeBps);
}
get fun get_min_value(op:int): coins {
    val st=T3HubState.load();var cost=calculateGasFee(0,op==OP_DISCOVER_WALLETS || op==OP_T3_GOV?T3_HUB_ADMIN_GAS:T3_HUB_GAS)+st.topup()+calculateForwardFee(0,1000,2);
    if(op==OP_DISCOVER_WALLETS){cost+=st.ledger.load().minDiscover();}return cost;
}
get fun get_min_execute(intent:cell,slot:int,amount:coins,staged:coins,burn:bool,owner:address): coins {
    val st=T3HubState.load();val parsed=t3_hub_read_intent(intent,burn);assert(parsed!=null) throw 1004;
    val q=st.quote(parsed,slot,amount,staged);var cost=calculateGasFee(0,T3_HUB_GAS)+st.topup()+t3_wallet_excess_fee(0,owner);
    if(q.status!=T3_MATH_OK){return cost;}
    if(q.minted>0){cost+=st.mint_cost(slot,0,{amount:q.minted as coins,recipient:parsed.recipient,attempt:0,sentLt:0,status:0},0,owner);}
    val payout=t3_hub_payout(owner,parsed.recipient,0,q.payout,0);if(payout!=null){cost+=st.payout_cost(payout!.load());}return cost;
}
get fun get_min_refund(slot:int,receipt:cell,refundTo:address?): coins {
    assert(slot>=0 && slot<3) throw 1000;
    val st=T3HubState.load();val r=T3Receipt.fromCell(receipt);val record=T3HubCredit.fromCell(r.payload);val credit=record.credit.load();
    assert(record.phase==T3_HUB_PENDING || record.phase==T3_HUB_SEALED) throw 1005;
    val recipient=refundTo==null?credit.owner:refundTo!;assert(st.ledger.load().canPay(recipient)) throw 1004;
    val payout=t3_hub_payout(credit.owner,recipient,credit.queryId,t3_math_zero().put(slot,credit.amount),0);
    var cost=st.topup()+calculateGasFee(0,T3_HUB_GAS)+t3_wallet_excess_fee(credit.queryId,credit.owner);
    if(payout!=null){cost+=st.payout_cost(payout!.load());}return cost;
}

get fun get_min_mint_retry(slot:int,receipt:cell): coins {
    val st=T3HubState.load();val r=T3Receipt.fromCell(receipt);val record=T3HubCredit.fromCell(r.payload);val credit=record.credit.load();
    assert(slot<3 && record.mint!=null) throw 1005;
    return st.topup()+calculateGasFee(0,T3_HUB_GAS)+st.mint_cost(slot,r.key,record.mint!.load(),credit.queryId,credit.owner)+t3_wallet_excess_fee(credit.queryId,credit.owner);
}
get fun get_min_payout_retry(slot:int,output:int,receipt:cell): coins {
    val st=T3HubState.load();val payout=t3_hub_get_payout(receipt as Cell<T3Receipt>,slot);
    assert(output<3 && payout.legs.load().at(output).amount>0) throw 1005;
    return st.topup()+calculateGasFee(0,T3_HUB_GAS)+st.leg_cost(payout,output)+t3_wallet_excess_fee(payout.queryId,payout.owner);
}
