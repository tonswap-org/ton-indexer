tolk 1.5.0

// Script only message ordering/statuses; token credits still use real wallets.
import "@gen/op/tep";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/tep74_codec";
import "../shared/jetton/tep89_codec";
import "../shared/dex/swap_payload";
import "@gen/op/testing";
struct MockOrderPoolConfig { admin: address; side: uint8 }
struct MockOrderPoolState { config: Cell<MockOrderPoolConfig>; mode: uint8; ledger: Cell<JettonLedger> }
struct (0x4f4d5053) MockPoolScript { mode: uint8 }
struct (0x4f4d5046) MockPoolForge { to: address; value: coins; body: cell }
fun onInternalMessage(in: InMessage){
    var st=MockOrderPoolState.fromCell(contract.getData());val cfg=st.config.load();var ledger=st.ledger.load();
    if(in.body.isEmpty()){ledger.discover();return;}
    val op=in.body.preloadUint(32);
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){val take=ledger.checkTake(in.senderAddress,in.body);if(take!=null){ledger.commitTake(take);st.ledger=ledger.toCell();contract.setData(st.toCell());}return;}
    if(op==OP_MOCK_POOL_SCRIPT){assert(in.senderAddress==cfg.admin) throw 1100;st.mode=MockPoolScript.fromSlice(in.body).mode;contract.setData(st.toCell());return;}
    if(op==OP_MOCK_POOL_FORGE){assert(in.senderAddress==cfg.admin) throw 1100;val msg=MockPoolForge.fromSlice(in.body);
        reserveGramsOnBalance(max(contract.getOriginalBalance()-in.valueCoins,0),RESERVE_MODE_EXACT_AMOUNT);
        createMessage({bounce:BounceMode.NoBounce,dest:msg.to,value:msg.value,body:msg.body}).send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);return;}
    if(op!=OP_TEP74_TRANSFER_NOTIFICATION){return;}
    mock_credit(in.senderAddress,in.body,in.valueCoins,st,cfg,mutate ledger);
}
fun onBouncedMessage(in: InMessageBounced){}

fun mock_credit(sender: address,body: slice,value: coins,st: MockOrderPoolState,cfg: MockOrderPoolConfig,mutate ledger: JettonLedger){
    val c=ledger.onNotification(sender,body);if(c==null || !c.payloadOk){return;}val req=swap_try_parse(c.payload);if(req==null){return;}
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_EXACT_AMOUNT);
    if(st.mode<=3){createMessage({bounce:BounceMode.NoBounce,dest:c.from,value:swap_notify_value(),body:SwapOutcome{
        queryId:c.queryId,status:st.mode==0?0:st.mode==3?2:1,reason:st.mode==0?0:7,inSide:cfg.side,amountIn:c.amount,amountOut:st.mode==0?c.amount:0}})
        .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);}
    if(st.mode==1 || st.mode==4){val receipt=SwapResult{queryId:c.queryId,origin:c.from,status:1,reason:7,amountIn:c.amount,amountOut:0,user:null}.toCell();
        ledger.sendTransfer(0,{queryId:c.queryId,amount:c.amount,destination:req.refundTo,excessTo:c.from,
            forwardGram:req.refundFwdGram,forwardPayload:receipt},0,SEND_MODE_CARRY_ALL_BALANCE);}
}
