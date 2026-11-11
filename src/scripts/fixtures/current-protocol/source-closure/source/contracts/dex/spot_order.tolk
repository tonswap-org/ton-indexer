tolk 1.5.0

import "@gen/op/tep";
import "./spot_order_messages";
import "@stdlib/gas-payments";
import "@gen/op/orders";
import "@gen/op/dex";
import "../shared/dex/swap_payload";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/jetton_quotes";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/tep89_codec";
import "@gen/op/jetton";
import "@gen/op/t3";

fun OrderStorage.load(): OrderStorage { return OrderStorage.fromCell(contract.getData()); }
fun OrderStorage.save(mutate self,b: OrderBody){ self.body=b.toCell(); contract.setData(self.toCell()); }
fun order_pass(to: address,funds: coins,body: cell){
    reserveGramsOnBalance(max(contract.getOriginalBalance()-funds,0),RESERVE_MODE_EXACT_AMOUNT);
    createMessage({bounce:BounceMode.NoBounce,dest:to,value:0,body}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
@inline
fun order_close(mutate st: OrderStorage,mutate b: OrderBody,nums: Cell<OrderNums>,peers: OrderPeers,reason: int,payer: address,reward: coins,payerBody: cell){
    val n=lazy OrderNums.fromCell(nums);
    val away=b.state==ORDER_EXECUTING && !b.refundSeen ? order_slice(n.amountIn,n.slices,b.executedSlices) : (0 as coins);
    val refund=n.amountIn-order_sold(n.amountIn,n.slices,b.executedSlices)-away;
    val leg=refund>0 && peers.inputWallet!=null?jetton_leg_value(n.walletGas,n.walletGram,n.walletBudget.load(),0,0,0,ORDER_CLOSED_BOUNCE_GAS):(0 as coins);
    b.state=ORDER_CLOSED; b.closeReason=reason as uint2; st.save(b);
    if(refund>0 && peers.inputWallet!=null){
        createMessage({bounce:BounceMode.Only256BitsOfBody,dest:peers.inputWallet!,value:leg,
            body:tep74_transfer_body_from(0,refund,st.owner,st.owner,0,null)})
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
    val notice=OrderClosed{reason:reason as uint8,executedSlices:b.executedSlices,refund,away}.toCell();
    reserveGramsOnBalance(ORDER_CLOSED_RESERVE,RESERVE_MODE_AT_MOST);
    if(payer!=st.owner){
        // Mode 64 returns this transaction's unspent inbound value and the earned reward.
        createMessage({bounce:BounceMode.NoBounce,dest:payer,value:reward,body:payerBody})
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
    }
    createMessage({bounce:BounceMode.NoBounce,dest:st.owner,value:0,body:notice}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
@inline
fun order_finish_refund(mutate st: OrderStorage,mutate b: OrderBody,value: coins){
    val peers=b.peers.load(); val t=lazy OrderTerms.fromCell(b.terms);
    if(b.refusal==0 || !b.refundSeen){st.save(b);order_pass(peers.keeper!,value,createEmptyCell());return;}
    b.state=ORDER_ACTIVE; b.attemptAt=blockchain.now();
    val reply=KeeperPaid{execId:b.execId,status:b.refusal as uint8,tip:0}.toCell();
    if(b.cancelRequested){order_close(mutate st,mutate b,t.nums,peers,ORDER_CANCELLED,peers.keeper!,0,reply);}
    else{st.save(b);order_pass(peers.keeper!,value,reply);}
}
fun order_credit(sender: address,value: coins,body: slice){
    var st=OrderStorage.load(); if(st.body==null){return;} var b=st.body!.load(); val peers=b.peers.load();
    if(b.state!=ORDER_EXECUTING || b.refundSeen || peers.inputWallet==null || sender!=peers.inputWallet!){return;}
    val c=jetton_parse_notification(0,body); val t=lazy OrderTerms.fromCell(b.terms); val n=lazy OrderNums.fromCell(t.nums);
    if(c==null || !c.payloadOk || c.from!=t.pool || c.queryId!=(ORDER_EXEC_DOMAIN | b.execId) || c.amount!=order_slice(n.amountIn,n.slices,b.executedSlices)){return;}
    val result=swap_result_try_parse(c.payload);
    if(result!=null && result.status==SWAP_REFUND && result.queryId==c.queryId && result.origin==contract.getAddress()
        && result.amountIn==c.amount && result.amountOut==0 && result.user==null){b.refundKind=1;}
    else if(c.claimReceipt){b.refundKind=2;}
    else{return;}
    b.refundSeen=true; order_finish_refund(mutate st,mutate b,value);
}
fun order_outcome(sender: address,value: coins,body: slice){
    var st=OrderStorage.load(); if(st.body==null){return;} var b=st.body!.load(); val t=lazy OrderTerms.fromCell(b.terms);
    assert(sender==t.pool) throw ERR_ORDER_AUTH;
    val msg=swap_outcome_try_parse(body); val n=lazy OrderNums.fromCell(t.nums);
    if(msg==null || b.state!=ORDER_EXECUTING || msg.queryId!=(ORDER_EXEC_DOMAIN | b.execId)
        || msg.inSide!=t.sellIndex || msg.amountIn!=order_slice(n.amountIn,n.slices,b.executedSlices) || b.refusal!=0){return;}
    if(msg.status!=SWAP_EXECUTED){b.refusal=msg.status as uint2;order_finish_refund(mutate st,mutate b,value);return;}
    val peers=b.peers.load();val keeper=peers.keeper!; b.executedSlices+=1; b.lastExecutedAt=b.attemptAt; b.attemptAt=blockchain.now(); b.state=ORDER_ACTIVE;
    val reply=KeeperPaid{execId:b.execId,status:0,tip:n.tipPerSlice}.toCell();
    if(b.executedSlices==n.slices || b.cancelRequested){order_close(mutate st,mutate b,t.nums,peers,b.executedSlices==n.slices?ORDER_FILLED:ORDER_CANCELLED,keeper,n.tipPerSlice,reply);}
    else{st.save(b);order_pass(keeper,value+n.tipPerSlice,reply);}
}
fun onBouncedMessage(in: InMessageBounced){
    var body=in.bouncedBody;
    if(body.remainingBitsCount()<128 || body.loadUint(32)!=0xffffffff || body.loadUint(32)!=OP_TEP74_TRANSFER){return;}
    var st=OrderStorage.load();if(st.body==null){return;}var b=st.body!.load();val peers=b.peers.load();
    if(b.state!=ORDER_EXECUTING || peers.inputWallet==null || in.senderAddress!=peers.inputWallet!){return;}
    val queryId=body.loadUint(64);val amount=body.tryLoadCoins();
    val t=lazy OrderTerms.fromCell(b.terms);val n=lazy OrderNums.fromCell(t.nums);
    if(amount==null || queryId!=(ORDER_EXEC_DOMAIN | b.execId) || amount!=order_slice(n.amountIn,n.slices,b.executedSlices)){return;}
    b.state=ORDER_ACTIVE;b.attemptAt=blockchain.now();
    val reply=KeeperPaid{execId:b.execId,status:7,tip:0}.toCell();
    if(b.cancelRequested){order_close(mutate st,mutate b,t.nums,peers,ORDER_CANCELLED,peers.keeper!,0,reply);}
    else{st.save(b);order_pass(peers.keeper!,in.valueCoins,reply);}
}
fun onInternalMessage(in: InMessage){
    if(in.body.isEmpty()){return;} assert(in.body.remainingBitsCount()>=32) throw ERR_ORDER_STATE;
    val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){order_credit(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_SWAP_OUTCOME){order_outcome(in.senderAddress,in.valueCoins,in.body);return;}
    var st=OrderStorage.load();
    if(op==OP_ORDER_INIT){
        val msg=OrderInit.fromSlice(in.body); assert(in.senderAddress==st.factory) throw ERR_ORDER_AUTH;
        if(st.body==null){
            val t=msg.terms.load();
            val b=OrderBody{state:ORDER_ACTIVE,closeReason:0,executedSlices:0,execId:0,lastExecutedAt:0,attemptAt:0,
                cancelRequested:false,refundSeen:false,refundKind:0,refusal:0,
                peers:OrderPeers{inputWallet:null,keeper:null,prevKeeper:null}.toCell(),terms:msg.terms};
            st.save(b);
            createMessage({bounce:BounceMode.Only256BitsOfBody,dest:t.inputMaster,value:jetton_discover_value(t.nums.load().walletGram),
                body:tep89_provide_body(0,contract.getAddress())}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }else{
            val b=st.body!.load();val t=lazy OrderTerms.fromCell(b.terms);
            if(b.state!=ORDER_CLOSED && b.peers.load().inputWallet==null && in.valueCoins>=2*jetton_discover_value(t.nums.load().walletGram)){
                createMessage({bounce:BounceMode.Only256BitsOfBody,dest:t.inputMaster,value:jetton_discover_value(t.nums.load().walletGram),
                    body:tep89_provide_body(0,contract.getAddress())}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
            }
            order_pass(st.owner,in.valueCoins,createEmptyCell());
        }return;
    }
    assert(st.body!=null) throw ERR_ORDER_STATE;
    var b=st.body!.load();val t=lazy OrderTerms.fromCell(b.terms);val n=lazy OrderNums.fromCell(t.nums);var peers=b.peers.load();
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){
        val msg=tep89_try_parse_take(in.body);
        if(msg==null || in.senderAddress!=t.inputMaster || peers.inputWallet!=null || msg.queryId!=0 || msg.owner!=contract.getAddress()
            || msg.wallet==contract.getAddress() || msg.wallet==t.inputMaster || msg.wallet==t.pool || msg.wallet==st.owner || msg.wallet==t.recipient || msg.wallet==st.factory){return;}
        peers.inputWallet=msg.wallet;b.peers=peers.toCell();st.save(b);return;
    }
    if(op==OP_TEP74_EXCESSES){
        var s=in.body;s.loadUint(32);val q=s.loadUint(64);s.assertEnd();var target:address?=null;
        if(b.execId>=1 && q==(ORDER_EXEC_DOMAIN | b.execId)){target=peers.keeper;}
        else if(b.execId>=2 && q==(ORDER_EXEC_DOMAIN | (b.execId-1))){target=peers.prevKeeper;}
        if(target!=null){order_pass(target!,in.valueCoins,in.body.toCell());}return;
    }
    if(op==OP_EXECUTE_SLICE){
        val msg=ExecuteSlice.fromSlice(in.body);assert(b.state==ORDER_ACTIVE && !b.cancelRequested && b.execId<4294967295) throw ERR_ORDER_STATE;
        assert(peers.inputWallet!=null) throw ERR_ORDER_SLOT;
        assert(n.executor==null || in.senderAddress==n.executor! || in.senderAddress==st.owner) throw ERR_ORDER_AUTH;
        val now=blockchain.now();assert(b.execId==0 || now>=b.attemptAt+ORDER_ATTEMPT_GAP) throw ERR_ORDER_GAP;
        assert(now>=(b.executedSlices==0?(n.startAt as int):b.lastExecutedAt+n.interval) && now<n.expiresAt) throw ERR_ORDER_ELIGIBLE;
        assert(msg.forwardGram>=order_forward_floor(n)) throw ERR_ORDER_FORWARD;
        val leg=order_leg(n,msg.forwardGram,972,1,ORDER_BOUNCE_GAS);assert(in.valueCoins>=leg+order_exec_fee()) throw ERR_ORDER_VALUE;
        b.execId+=1;b.attemptAt=now;b.state=ORDER_EXECUTING;b.refundSeen=false;b.refundKind=0;b.refusal=0;
        peers.prevKeeper=peers.keeper;peers.keeper=in.senderAddress;b.peers=peers.toCell();st.save(b);
        val amount=order_slice(n.amountIn,n.slices,b.executedSlices);
        val payload=Swap{minOut:(amount*n.minOutTotal+n.amountIn-1)/n.amountIn,deadline:n.expiresAt,recipient:t.recipient,
            refundTo:contract.getAddress(),notifyOrigin:true,fwdGram:0,refundFwdGram:order_refund_forward(),fwdPayload:null}.toCell();
        createMessage({bounce:BounceMode.Only256BitsOfBody,dest:peers.inputWallet!,value:leg,
            body:tep74_transfer_body_from(ORDER_EXEC_DOMAIN | b.execId,amount,t.pool,in.senderAddress,msg.forwardGram,payload)})
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        order_pass(in.senderAddress,in.valueCoins,createEmptyCell());return;
    }
    if(op==OP_CANCEL_ORDER || op==OP_CLOSE_EXPIRED){
        if(op==OP_CANCEL_ORDER){val msg=CancelOrder.fromSlice(in.body);assert(in.senderAddress==st.owner) throw ERR_ORDER_AUTH;}
        else{val msg=CloseExpired.fromSlice(in.body);assert(blockchain.now()>=n.expiresAt) throw ERR_ORDER_ELIGIBLE;}
        assert(b.state!=ORDER_CLOSED) throw ERR_ORDER_STATE;assert(in.valueCoins>=order_control_value()) throw ERR_ORDER_VALUE;
        if(op==OP_CANCEL_ORDER && b.state==ORDER_EXECUTING && blockchain.now()<b.attemptAt+ORDER_STUCK_TIMEOUT){
            b.cancelRequested=true;st.save(b);order_pass(st.owner,in.valueCoins,createEmptyCell());return;
        }
        assert(b.state!=ORDER_EXECUTING || blockchain.now()>=b.attemptAt+ORDER_STUCK_TIMEOUT) throw ERR_ORDER_ELIGIBLE;
        if(op==OP_CLOSE_EXPIRED && in.senderAddress!=st.owner){
            assert(contract.getOriginalBalance()-in.valueCoins>=order_close_balance(n,b,peers)) throw ERR_ORDER_VALUE;
        }
        order_close(mutate st,mutate b,t.nums,peers,op==OP_CANCEL_ORDER?ORDER_CANCELLED:ORDER_EXPIRED,in.senderAddress,
            op==OP_CLOSE_EXPIRED?order_close_reward():0,createEmptyCell());return;
    }
    if(op==OP_WITHDRAW_JETTON){
        val msg=WithdrawJetton.fromSlice(in.body);assert(in.senderAddress==st.owner && b.state==ORDER_CLOSED) throw ERR_ORDER_AUTH;
        assert(msg.wallet.getWorkchain()==0 && msg.wallet!=contract.getAddress() && in.valueCoins>=order_control_value()) throw ERR_ORDER_VALUE;
        var body:cell=createEmptyCell();
        if(msg.recovery!=null){
            assert(peers.inputWallet!=null && msg.wallet==peers.inputWallet! && msg.amount==0) throw ERR_ORDER_SLOT;
            var recovery=msg.recovery!.beginParse();val record=recovery.loadRef();val witness=recovery.loadRef();recovery.assertEnd();
            body=beginCell().storeUint(OP_T3_WALLET_RETRY,32).storeRef(record).storeRef(witness).storeAddress(st.owner).endCell();
        }else{assert(msg.amount>0 && msg.queryId<ORDER_EXEC_DOMAIN) throw ERR_ORDER_VALUE;body=tep74_transfer_body_from(msg.queryId,msg.amount,st.owner,st.owner,0,null).endCell();}
        reserveGramsOnBalance(ORDER_CLOSED_RESERVE,RESERVE_MODE_AT_MOST);
        createMessage({bounce:BounceMode.Only256BitsOfBody,dest:msg.wallet,value:0,body}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);return;
    }
    throw ERR_ORDER_STATE;
}
get fun get_order(): (address,address,int,int,int,int,int,int,int,coins,coins,coins,address?,address?,address?,bool,bool,int){
    val st=OrderStorage.load();if(st.body==null){return(st.factory,st.owner,st.nonce,0,0,0,0,0,0,0,0,0,null,null,null,false,false,0);}
    val b=st.body!.load();val n=lazy OrderNums.fromCell(b.terms.load().nums);val p=b.peers.load();val sold=order_sold(n.amountIn,n.slices,b.executedSlices);
    return(st.factory,st.owner,st.nonce,b.state,b.closeReason,b.executedSlices,b.execId,b.lastExecutedAt,b.attemptAt,sold,
        b.state==ORDER_EXECUTING && !b.refundSeen?order_slice(n.amountIn,n.slices,b.executedSlices):(0 as coins),n.amountIn-sold,p.inputWallet,p.keeper,p.prevKeeper,b.cancelRequested,b.refundSeen,b.refusal);
}
get fun get_order_terms(): cell { return OrderStorage.load().body!.load().terms as cell; }
get fun get_next_slice(): (bool,int,int,coins,coins){
    val st=OrderStorage.load();if(st.body==null){return(false,1,0,0,0);}val b=st.body!.load();val n=lazy OrderNums.fromCell(b.terms.load().nums);
    if(b.executedSlices==n.slices){return(false,1,0,0,0);}val amount=order_slice(n.amountIn,n.slices,b.executedSlices);val minimum=(amount*n.minOutTotal+n.amountIn-1)/n.amountIn;
    val schedule=b.executedSlices==0?(n.startAt as int):b.lastExecutedAt+n.interval;val gap=b.execId==0?0:b.attemptAt+ORDER_ATTEMPT_GAP;val at=max(schedule,gap);
    val reason=b.state!=ORDER_ACTIVE || b.cancelRequested?1:b.peers.load().inputWallet==null?2:blockchain.now()>=n.expiresAt?5:blockchain.now()<schedule?3:blockchain.now()<gap?4:0;
    return(reason==0,reason,at,amount,minimum);
}
get fun get_exec_budget(forwardGram: coins): (coins,coins){val n=OrderStorage.load().body!.load().terms.load().nums.load();val floor=order_forward_floor(n);return(order_leg(n,max(forwardGram,floor),972,1,ORDER_BOUNCE_GAS)+order_exec_fee(),floor);}
get fun get_control_value(): coins { return order_control_value(); }
get fun get_close_budget(): (coins,coins,coins) {
    val b=OrderStorage.load().body!.load();
    return(order_control_value(),order_close_reward(),order_close_balance(b.terms.load().nums.load(),b,b.peers.load()));
}

get fun get_refund_forward(): coins { return order_refund_forward(); }
