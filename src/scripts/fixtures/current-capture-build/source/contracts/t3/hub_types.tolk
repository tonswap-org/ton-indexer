tolk 1.5.0

import "fresh_math";
import "receipt_tree";
import "reserve_credit";
import "wallet_types";
import "../shared/jetton/jetton_slots";
import "../generated/op/t3";

const T3_HUB_PENDING = 0;
const T3_HUB_BOUND = 1;
const T3_HUB_ACCEPTED = 2;
const T3_HUB_REFUNDED = 3;
const T3_HUB_SEALED = 4;
const T3_HUB_SENT = 0;
const T3_HUB_FAILED = 1;

struct T3ReservePolicy { scale: uint32; codeHash: uint256; lockExit: uint16; balanceExit: uint16 }
struct T3HubConfig {
    governance: address; proofCodeHash: uint256; amp: uint16; rentBits: uint32; rentCells: uint32;
    walletCode: cell; metadata: cell; policies: map<uint8,T3ReservePolicy>
}
struct T3HubBasket { r0: coins; r1: coins; r2: coins }
struct T3HubPending { r0: uint256; r1: uint256; r2: uint256 }
struct T3HubClears { r0: uint64; r1: uint64; r2: uint64 }
struct T3HubEconomy {
    backing: T3HubBasket; pending: Cell<T3HubPending>; supply: coins;
    feeBps: uint16; admitted: uint3; frozen: uint3; withdrawalsOnly: bool; clears: Cell<T3HubClears>
}
struct T3HubTrees {
    reserve0: Cell<T3ReceiptTree>; reserve1: Cell<T3ReceiptTree>;
    reserve2: Cell<T3ReceiptTree>; burns: Cell<T3ReceiptTree>
}
struct T3HubState {
    config: Cell<T3HubConfig>; ledger: Cell<JettonLedger>;
    economy: Cell<T3HubEconomy>; trees: Cell<T3HubTrees>
}
struct T3HubMint { amount: coins; recipient: address; attempt: uint64; sentLt: uint64; status: uint1 }
struct T3HubLeg { amount: coins; attempt: uint64; sentLt: uint64; status: uint1; recipient: address }
struct T3HubLegs { l0: Cell<T3HubLeg>; l1: Cell<T3HubLeg>; l2: Cell<T3HubLeg> }
struct T3HubPayout { owner: address; recipient: address; queryId: uint64; legs: Cell<T3HubLegs> }
struct T3HubCredit {
    phase: uint3; linkedSlot: uint2; linkedKey: uint64;
    credit: Cell<T3ReserveCredit>; mint: Cell<T3HubMint>?; payout: Cell<T3HubPayout>?; staged: Cell<T3ReserveCredit>?
}
struct T3HubBurn { attempt: Cell<WalletAttempt>; payout: Cell<T3HubPayout>? }
struct T3HubIntent { kind: int; output: int; strict: bool; minOut: coins; recipient: address }
// Identifiers are public, but only a current committed leaf authorizes a retry.
struct T3HubIdentity { domain: uint2; slot: uint2; key: uint64; output: uint2; attempt: uint64 }
struct T3HubWitness { record: Cell<T3Receipt>; path: cell }

fun T3HubState.load(): T3HubState { return T3HubState.fromCell(contract.getData()); }
fun T3HubState.save(self) { contract.setData(self.toCell()); }
fun T3HubPending.add(self,slot:int,amount:int): T3HubPending {
    var next=self;if(slot==0){next.r0=(next.r0+amount) as uint256;}else if(slot==1){next.r1=(next.r1+amount) as uint256;}
    else{assert(slot==2) throw 1000;next.r2=(next.r2+amount) as uint256;}return next;
}
fun T3HubBasket.math(self): T3MathBasket { return {r0:self.r0,r1:self.r1,r2:self.r2}; }
fun t3_hub_basket(b:T3MathBasket): T3HubBasket { return {r0:b.r0 as coins,r1:b.r1 as coins,r2:b.r2 as coins}; }
fun T3HubBasket.add(self,slot:int,amount:int): T3HubBasket { return t3_hub_basket(self.math().put(slot,self.math().at(slot)+amount)); }
fun T3HubTrees.get(self,slot:int): T3ReceiptTree {
    assert (slot>=0 && slot<=3) throw 1000;
    return (slot==0?self.reserve0:(slot==1?self.reserve1:(slot==2?self.reserve2:self.burns))).load();
}
fun T3HubTrees.put(mutate self,slot:int,tree:T3ReceiptTree) {
    if(slot==0){self.reserve0=tree.toCell();}else if(slot==1){self.reserve1=tree.toCell();}
    else if(slot==2){self.reserve2=tree.toCell();}else{assert(slot==3) throw 1000;self.burns=tree.toCell();}
}
fun T3HubLegs.at(self,slot:int): T3HubLeg { return (slot==0?self.l0:(slot==1?self.l1:self.l2)).load(); }
fun T3HubLegs.put(mutate self,slot:int,leg:T3HubLeg) {
    assert(slot>=0 && slot<3) throw 1000;
    if(slot==0){self.l0=leg.toCell();}else if(slot==1){self.l1=leg.toCell();}else{self.l2=leg.toCell();}
}
fun t3_hub_leg(amount:int,lt:uint64,recipient:address): Cell<T3HubLeg> {return T3HubLeg{amount:amount as coins,attempt:0,sentLt:lt,status:T3_HUB_SENT,recipient}.toCell();}
fun t3_hub_payout(owner:address,recipient:address,queryId:uint64,p:T3MathBasket,lt:uint64): Cell<T3HubPayout>? {
    if(p.sum()==0){return null;}
    val legs:T3HubLegs={l0:t3_hub_leg(p.r0,lt,recipient),l1:t3_hub_leg(p.r1,lt,recipient),l2:t3_hub_leg(p.r2,lt,recipient)};
    return T3HubPayout{owner,recipient,queryId,legs:legs.toCell()}.toCell();
}
fun T3HubState.math(self): T3MathState {
    val e=self.economy.load();val c=self.config.load();
    return {reserve:e.backing.math(),supply:e.supply,amp:c.amp,feeBps:e.feeBps,
        scale:{r0:c.policies.mustGet(0).scale,r1:c.policies.mustGet(1).scale,r2:c.policies.mustGet(2).scale}};
}
fun T3HubState.apply(mutate self,q:T3MathQuote,slot:int,amount:int,other:int,staged:int) {
    var e=self.economy.load();e.backing=t3_hub_basket(q.next.reserve);e.supply=q.next.supply as coins;
    var pending=e.pending.load();if(slot>=0){pending=pending.add(slot,-amount);}
    if(staged>0){pending=pending.add(other,-staged);}e.pending=pending.toCell();
    self.economy=e.toCell();
}
fun t3_hub_mint_identity(slot:int,key:uint64,attempt:uint64): cell {
    return T3HubIdentity{domain:0,slot:slot as uint2,key,output:0,attempt}.toCell();
}
fun t3_hub_payout_identity(domain:int,slot:int,key:uint64,output:int,attempt:uint64): cell {
    return beginCell().storeUint(OP_T3_HUB_PAYOUT,32).storeRef(T3HubIdentity{
        domain:domain as uint2,slot:slot as uint2,key,output:output as uint2,attempt}.toCell()).endCell();
}
