tolk 1.5.0
import "@stdlib/exotic-cells";
import "fresh_math";
import "receipt_tree";
import "wallet_types";
import "../shared/jetton/jetton_slots";
import "../shared/jetton/tep74_codec";
import "../generated/op/t3";

import "hub_types";
import "wallet_budget";
import "@stdlib/gas-payments";

const T3_HUB_GAS = 350000;
const T3_HUB_ADMIN_GAS = 60000;
const T3_HUB_BOUNCE_GAS = 60000;
const T3_HUB_RENT_SECONDS = 157680000;

fun T3ReceiptTree.verify(self,w:T3HubWitness) {
    val key=w.record.load().key;assert(self.initialized && key<=self.lastKey) throw 1001;
    var hash=t3_receipt_leaf(w.record);var step=w.path;var level=0;
    repeat(64){
        var (s,exotic)=step.beginParseSpecial();assert(!exotic && s.remainingBitsCount()==257) throw 884;
        val sibling=s.loadUint(256);val tail=s.loadMaybeRef();s.assertEnd();
        assert((tail==null)==(level==63)) throw 884;
        hash=((key>>level)&1)==0?t3_receipt_pair(hash,sibling):t3_receipt_pair(sibling,hash);
        level+=1;if(tail!=null){step=tail!;}
    }
    assert(hash==self.root) throw 885;
}
fun T3HubState.replace(mutate self,slot:int,w:T3HubWitness,payload:cell) {
    var trees=self.trees.load();var tree=trees.get(slot);
    tree.replace(w.record,T3Receipt{key:w.record.load().key,payload}.toCell(),w.path);
    trees.put(slot,tree);self.trees=trees.toCell();
}
fun T3HubState.append(mutate self,slot:int,record:Cell<T3Receipt>) {
    var trees=self.trees.load();var tree=trees.get(slot);tree.append(record);trees.put(slot,tree);self.trees=trees.toCell();
}
fun T3HubState.log(self,slot:int,record:Cell<T3Receipt>) {
    createExternalLogMessage({dest:createAddressNone(),body:beginCell().storeUint(OP_T3_HUB_RECEIPT,32)
        .storeUint(slot,2).storeRef(record)}).send(SEND_MODE_IGNORE_ERRORS);
}
fun t3_hub_read_intent(payload:cell,burn:bool): T3HubIntent? {
    var(s,exotic)=payload.beginParseSpecial();
    if(exotic || s.remainingBitsCount()<32){return null;}
    val op=s.loadUint(32);var kind=-1;var output=0;var strict=false;
    if(!burn && op==OP_T3_MINT){kind=T3_MATH_MINT;}
    else if(!burn && op==OP_T3_PAIR){kind=T3_MATH_PAIR;}
    else if(!burn && op==OP_T3_SWAP){
        if(s.remainingBitsCount()<3){return null;}kind=T3_MATH_SWAP;output=s.loadUint(2);strict=s.loadBool();
    }else if(burn && op==OP_T3_REDEEM){
        if(s.remainingBitsCount()<4){return null;}kind=s.loadBool()?T3_MATH_SINGLE:T3_MATH_PROPORTIONAL;output=s.loadUint(2);strict=s.loadBool();
    }else{return null;}
    val minOut=s.tryLoadCoins();if(minOut==null){return null;}val recipient=s.tryLoadStdAddress();
    if(recipient==null || !s.isEmpty() || output>2 || (kind==T3_MATH_PROPORTIONAL && output!=0)){return null;}
    return {kind,output,strict,minOut,recipient};
}
fun T3HubState.quote(self,intent:T3HubIntent,slot:int,amount:coins,staged:coins): T3MathQuote {
    val e=self.economy.load();val ledger=self.ledger.load();val st=self.math();
    if(!ledger.coreReady() || !ledger.canPay(intent.recipient)) {return t3_math_refuse(st,T3_MATH_REQUEST,0);}
    if(intent.kind!=T3_MATH_PROPORTIONAL && (e.withdrawalsOnly || e.frozen!=0)){
        return t3_math_refuse(st,T3_MATH_REQUEST,0);
    }
    if((intent.kind==T3_MATH_MINT || intent.kind==T3_MATH_PAIR || intent.kind==T3_MATH_SWAP)
        && (slot<0 || slot>2 || (e.admitted&(1<<slot))==0 || (staged>0 && (e.admitted&(1<<(1-slot)))==0))){
        return t3_math_refuse(st,T3_MATH_RESERVE,0);
    }
    return t3_quote_guarded(st,{kind:intent.kind,input:slot,output:intent.output,amount,staged,minOut:intent.minOut});
}
fun T3HubState.rent(self): coins {
    // Four bounded 64-level frontiers; no economic claim dictionary grows with users.
    val cfg=self.config.load();
    return calculateStorageFee(0,T3_HUB_RENT_SECONDS,cfg.rentBits+76000,cfg.rentCells+135);
}
fun T3HubState.reserve(self,incoming:coins): coins {
    val before=max(contract.getOriginalBalance()-incoming,0);val reserve=max(before,self.rent());
    reserveGramsOnBalance(reserve,RESERVE_MODE_EXACT_AMOUNT|RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    return reserve-before;
}
fun T3HubState.topup(self): coins {return max(self.rent()-contract.getOriginalBalance(),0) as coins;}
fun T3HubState.mint_plan(self,slot:int,key:uint64,m:T3HubMint,qid:uint64,owner:address): (coins,OutMessage) {
    val c=self.config.load();val dest=t3_wallet_init(m.recipient,contract.getAddress(),c.proofCodeHash,c.walletCode);
    val body=t3_wallet_mint_body(qid,m.amount,t3_hub_mint_identity(slot,key,m.attempt),owner);
    val value=t3_wallet_mint_value(qid,owner,c.walletCode)+calculateGasFee(0,T3_HUB_BOUNCE_GAS);
    val message=createMessage({bounce:BounceMode.RichBounce,dest,value,body});
    return (value+message.estimateFeeWithoutSending(SEND_MODE_PAY_FEES_SEPARATELY),message);
}
fun T3HubState.mint_cost(self,slot:int,key:uint64,m:T3HubMint,qid:uint64,owner:address): coins {
    val(cost,_)=self.mint_plan(slot,key,m,qid,owner);return cost;
}
fun t3_hub_transfer(p:T3HubPayout,domain:int,slot:int,key:uint64,output:int): JettonTransfer {
    val leg=p.legs.load().at(output);
    return {queryId:p.queryId,amount:leg.amount,destination:leg.recipient,excessTo:p.owner,forwardGram:0,
        forwardPayload:t3_hub_payout_identity(domain,slot,key,output,leg.attempt)};
}
fun T3HubState.payout_cost(self,p:T3HubPayout): coins {
    val ledger=self.ledger.load();val legs=p.legs.load();var total:coins=0;var i=0;
    repeat(3){if(legs.at(i).amount>0){total+=self.leg_cost(p,i);}i+=1;}
    return total;
}
fun T3HubState.leg_cost(self,p:T3HubPayout,output:int): coins {
    val ledger=self.ledger.load();val value=ledger.legValue(output as uint8,0,166,2,T3_HUB_BOUNCE_GAS);
    val wallet=ledger.slots.mustGet(output as uint8).wallet;assert(wallet!=null) throw 1006;
    return value+createMessage({bounce:BounceMode.RichBounce,dest:wallet!,value,
        body:tep74_transfer_body(t3_hub_transfer(p,0,0,0,output))}).estimateFeeWithoutSending(SEND_MODE_PAY_FEES_SEPARATELY);
}
fun t3_hub_get_payout(receipt:Cell<T3Receipt>,slot:int): T3HubPayout {
    val payload=receipt.load().payload;
    val p=slot==3?T3HubBurn.fromCell(payload).payout:T3HubCredit.fromCell(payload).payout;
    assert(p!=null) throw 1005;return p!.load();
}
fun T3HubState.put_payout(mutate self,slot:int,w:T3HubWitness,p:T3HubPayout) {
    var payload=w.record.load().payload;
    if(slot==3){var r=T3HubBurn.fromCell(payload);r.payout=p.toCell();payload=r.toCell();}
    else{var r=T3HubCredit.fromCell(payload);r.payout=p.toCell();payload=r.toCell();}
    self.replace(slot,w,payload);self.save();self.log(slot,T3Receipt{key:w.record.load().key,payload}.toCell());
}
fun T3HubState.send_payout(self,p:T3HubPayout,domain:int,slot:int,key:uint64,only:int) {
    val ledger=self.ledger.load();val legs=p.legs.load();var i=0;
    repeat(3){if(legs.at(i).amount>0 && (only<0 || only==i)){
        ledger.sendTransfer(i as uint8,t3_hub_transfer(p,domain,slot,key,i),ledger.legValue(i as uint8,0,166,2,T3_HUB_BOUNCE_GAS),
            SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }i+=1;}
}
fun t3_hub_return(queryId:uint64,to:address?) {
    if(to!=null){createMessage({bounce:BounceMode.NoBounce,dest:to!,value:0,body:t3_wallet_excess_body(queryId)})
        .send(SEND_MODE_CARRY_ALL_BALANCE|SEND_MODE_IGNORE_ERRORS);}
}
