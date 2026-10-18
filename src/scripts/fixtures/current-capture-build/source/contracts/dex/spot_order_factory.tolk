tolk 1.5.0

import "./spot_order_messages";
import "@stdlib/gas-payments";

fun order_address(code: cell, factory: address, owner: address, nonce: uint64): AutoDeployAddress {
    return { stateInit:{code,data:order_initial(factory,owner,nonce)} };
}

fun factory_create_fee(st: OrderFactoryStorage, owner: address, nonce: uint64, terms: Cell<OrderTerms>): coins {
    val msg=createMessage({bounce:BounceMode.NoBounce,dest:order_address(st.orderCode,contract.getAddress(),owner,nonce),
        value:((1<<120)-1) as coins,body:OrderInit{queryId:0,terms}});
    return calculateGasFee(BASECHAIN,ORDER_CREATE_GAS)+msg.estimateFeeWithoutSending(SEND_MODE_PAY_FEES_SEPARATELY);
}
fun onInternalMessage(in: InMessage) {
    if(in.body.isEmpty()){return;}
    val req=CreateOrder.fromSlice(in.body);
    var t=order_validate(req.terms,in.senderAddress); var n=t.nums.load(); n.startAt=max(n.startAt,blockchain.now()); t.nums=n.toCell();
    val terms=t.toCell(); val st=OrderFactoryStorage.fromCell(contract.getData());
    assert(in.valueCoins>=order_bond(n)+factory_create_fee(st,in.senderAddress,req.nonce,terms)) throw ERR_ORDER_VALUE;
    reserveGramsOnBalance(max(contract.getOriginalBalance()-in.valueCoins,0),RESERVE_MODE_EXACT_AMOUNT);
    createMessage({bounce:BounceMode.NoBounce,dest:order_address(st.orderCode,contract.getAddress(),in.senderAddress,req.nonce),
        value:0,body:OrderInit{queryId:req.queryId,terms}}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun onBouncedMessage(in: InMessageBounced) {}
get fun get_order_address(owner: address,nonce: uint64): address {
    assert(owner.getWorkchain()==0) throw ERR_ORDER_TERMS;
    return order_address(OrderFactoryStorage.fromCell(contract.getData()).orderCode,contract.getAddress(),owner,nonce).calculateAddress();
}
get fun get_required_bond(owner: address,nonce: uint64,terms: cell): coins {
    val t=order_validate(terms as Cell<OrderTerms>,owner); val st=OrderFactoryStorage.fromCell(contract.getData());
    return order_bond(t.nums.load())+factory_create_fee(st,owner,nonce,t.toCell());
}
get fun get_forward_floor(terms: cell): coins { return order_forward_floor((terms as Cell<OrderTerms>).load().nums.load()); }
get fun get_order_code_hash(): uint256 { return OrderFactoryStorage.fromCell(contract.getData()).orderCode.hash(); }
