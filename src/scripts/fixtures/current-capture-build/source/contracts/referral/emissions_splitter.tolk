tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/tep89_codec"
import "../shared/utils/error_codes"
import "@gen/op/referral"
import "@gen/op/jetton"

const ES_CREDIT_GAS = 40000
const ES_ADMIN_GAS = 70000
const ES_DRIP_GAS = 200000
const ES_BIND_GAS = 100000
const ES_BOUNCE_GAS = 250000
const ES_WINDOW = 604800
const ES_GRAM_TARGET = 1000000000
const ES_GRAM_SWEEP_MIN = 100000000

struct EmissionsPeers { governance: address; treasury: address; gasVault: address }
struct EmissionsStream { releasable: coins; pending: coins; last: uint32; end: uint32 }
struct EmissionsRecipient { to: address; forwardGas: uint32 }
struct EmissionsConfig { recipients: map<uint8, EmissionsRecipient>; weights: map<uint8, uint16> }
struct EmissionsStorage {
    peers: Cell<EmissionsPeers>
    jetton: Cell<JettonLedger>
    sweeps: Cell<JettonSweeps>
    config: Cell<EmissionsConfig>
    merkleClaim: address?
    stream: EmissionsStream
    funded: coins
    sent: coins
}
struct (0x45534e44) SplitterBind { queryId: uint64; tsMaster: address; merkleClaim: address }
struct (0x45535243) SplitterSetRecipient { queryId: uint64; slot: uint3; to: address; forwardGas: uint32 }
struct (0x4553424b) SplitterSetWeights { queryId: uint64; weights: uint128 }
struct (0x45534452) SplitterDrip { queryId: uint64 }
struct (0x45534d43) SplitterGenesisClaim { queryId: uint64; index: uint32; proof: cell }
struct (0x4d434c4d) MerkleClaim { queryId: uint64; index: uint32; proof: cell }
fun EmissionsStorage.load(): EmissionsStorage { return EmissionsStorage.fromCell(contract.getData()); }
fun EmissionsStorage.save(self) { contract.setData(self.toCell()); }
fun EmissionsStream.sync(mutate self, nowTs: int) {
    if (nowTs > self.last) {
        if (self.pending > 0) {
            val rel = nowTs >= self.end ? self.pending as int : self.pending * (nowTs-self.last) / (self.end-self.last);
            self.releasable += rel; self.pending -= rel;
        }
        self.last = nowTs;
    }
}
fun EmissionsStorage.liabilities(self, slot: uint8): coins {
    return (slot == 0 ? self.stream.releasable + self.stream.pending : 0 as coins) + self.jetton.load().owedTotal(slot);
}
fun es_return(to: address) { createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS); }
fun es_reserve(value: coins, gasVault: address, sweep: bool) {
    val pre=max(contract.getOriginalBalance()-value,0);
    if (sweep && pre >= ES_GRAM_TARGET+ES_GRAM_SWEEP_MIN) {
        reserveGramsOnBalance(ES_GRAM_TARGET,RESERVE_MODE_EXACT_AMOUNT);
        createMessage({bounce:BounceMode.NoBounce,dest:gasVault,value:pre-ES_GRAM_TARGET}).send(SEND_MODE_IGNORE_ERRORS);
    } else { reserveGramsOnBalance(pre,RESERVE_MODE_EXACT_AMOUNT); }
}
fun es_min_value(st: EmissionsStorage, op: int): coins {
    val ledger=st.jetton.load();
    if (op==OP_DISCOVER_WALLETS) { return ledger.minDiscover()+calculateForwardFee(BASECHAIN,1300,2); }
    if (op==OP_SWEEP_PROBE) { return ledger.jetton_min_sweep(0,ES_BOUNCE_GAS); }
    if (op==OP_SPLITTER_BIND) { return calculateGasFee(BASECHAIN,ES_BIND_GAS)+jetton_discover_value(0)+calculateForwardFee(BASECHAIN,1300,2); }
    if (op==OP_SPLITTER_DRIP) {
        val cfg=st.config.load(); var value=calculateGasFee(BASECHAIN,ES_DRIP_GAS)+3*calculateForwardFee(BASECHAIN,1300,2);
        var item=cfg.recipients.findFirst(); while(item.isFound) {
            val w=cfg.weights.get(item.getKey()); if(w.isFound && w.loadValue()>0) {
                value += ledger.legValue(0,calculateGasFee(BASECHAIN,item.loadValue().forwardGas),0,0,ES_BOUNCE_GAS);
            }
            item=cfg.recipients.iterateNext(item);
        }
        return value;
    }
    return calculateGasFee(BASECHAIN,ES_ADMIN_GAS)+calculateForwardFee(BASECHAIN,1300,2);
}
fun on_credit_emissions(sender:address,value:coins,body:slice) {
    var st=EmissionsStorage.load(); var ledger=st.jetton.load(); var sweeps=st.sweeps.load();
    val r=JettonSweeps.onNotification(mutate sweeps,ledger,sender,body);
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(r.kind==2){jetton_sweep_pay(mutate ledger,r,st.peers.load().treasury,value,0,null);st.jetton=ledger.toCell();st.save();return;}
    if(r.kind==1){
        val amount=r.credit!.amount; val nowTs=blockchain.now(); st.stream.sync(nowTs);
        val rem=st.stream.pending==0 || st.stream.end<=nowTs ? 0 : st.stream.end-nowTs;
        st.stream.end=nowTs+(st.stream.pending*rem+amount*ES_WINDOW)/(st.stream.pending+amount);
        st.stream.pending+=amount; st.funded=min(JETTON_MAX_COINS,st.funded+amount); st.save(); return;
    }
    if(r.dirty){st.save();}
}
fun onBouncedMessage(in:InMessageBounced) {
    var st=EmissionsStorage.load();var ledger=st.jetton.load();var sweeps=st.sweeps.load();
    val r=JettonSweeps.onBounce(mutate sweeps,ledger,in.senderAddress,in.bouncedBody);
    if(r.dirty){st.sweeps=sweeps.toCell();}
    if(!r.probe && r.b.kind==1){
        if(r.b.claimReceipt){ledger.bounceToOwed(r.b,r.b.destination!,in.valueCoins,JETTON_OWED_CAP);st.jetton=ledger.toCell();}
        else{st.stream.releasable+=r.b.amount;st.sent=max(st.sent-r.b.amount,0);jetton_bounce_excess(r.b.excessTo,r.b.queryId,in.valueCoins,0);}
        st.save();return;
    }
    if(r.dirty){st.save();}if(r.probe){jetton_bounce_excess(r.b.excessTo,r.b.queryId,in.valueCoins,0);}
}
fun on_take_emissions(sender:address,body:slice) {
    var st=EmissionsStorage.load();var ledger=st.jetton.load();val peers=st.peers.load();val take=ledger.checkTake(sender,body);
    if(take==null || take.wallet==peers.governance || take.wallet==peers.treasury || take.wallet==peers.gasVault
        || (st.merkleClaim!=null && take.wallet==st.merkleClaim!)){return;}
    ledger.commitTake(take);st.jetton=ledger.toCell();st.save();
}
fun onInternalMessage(in:InMessage) {
    if(in.body.isEmpty()){return;}val op=in.body.preloadUint(32);
    if(op==OP_TEP74_TRANSFER_NOTIFICATION){on_credit_emissions(in.senderAddress,in.valueCoins,in.body);return;}
    if(op==OP_TEP74_EXCESSES){return;}
    if(op==OP_TEP89_TAKE_WALLET_ADDRESS){on_take_emissions(in.senderAddress,in.body);return;}
    var st=EmissionsStorage.load();var ledger=st.jetton.load();val peers=st.peers.load();
    assert(in.valueCoins>=es_min_value(st,op)) throw ERR_JETTON_VALUE;
    if(op==OP_DISCOVER_WALLETS){val msg=DiscoverWallets.fromSlice(in.body);es_reserve(in.valueCoins,peers.gasVault,false);ledger.discover();es_return(in.senderAddress);return;}
    if(op==OP_SPLITTER_DRIP){
        val msg=SplitterDrip.fromSlice(in.body);val cfg=st.config.load();var sum=0;var i=0;
        while(i<8){val w=cfg.weights.get(i as uint8);sum+=w.isFound?w.loadValue():0;i+=1;}
        assert(ledger.coreReady() && !ledger.slots.isEmpty() && sum==10000) throw ERR_JETTON_CONFIG;
        st.stream.sync(blockchain.now());assert(st.stream.releasable>=1000000000) throw ERR_JETTON_VALUE;
        val amount=st.stream.releasable;es_reserve(in.valueCoins,peers.gasVault,true);i=0;
        while(i<8){val w=cfg.weights.get(i as uint8);val part=w.isFound?amount*w.loadValue()/10000:0;
            if(part>0){val to=cfg.recipients.mustGet(i as uint8,ERR_JETTON_CONFIG);val fwd=calculateGasFee(BASECHAIN,to.forwardGas);
                st.stream.releasable-=part;st.sent=min(JETTON_MAX_COINS,st.sent+part);
                ledger.sendTransfer(0,{queryId:i as uint64,amount:part,destination:to.to,excessTo:in.senderAddress,forwardGram:fwd,forwardPayload:null},
                    ledger.legValue(0,fwd,0,0,ES_BOUNCE_GAS),SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            }i+=1;}
        st.save();es_return(in.senderAddress);return;
    }
    if(op==OP_SPLITTER_GENESIS_CLAIM){
        val msg=SplitterGenesisClaim.fromSlice(in.body);assert(st.merkleClaim!=null && ledger.slots.mustGet(0,ERR_JETTON_SLOT).wallet!=null) throw ERR_JETTON_SLOT;
        createMessage({bounce:BounceMode.Only256BitsOfBody,dest:st.merkleClaim!,value:0,body:MerkleClaim{queryId:msg.queryId,index:msg.index,proof:msg.proof}})
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);return;
    }
    if(op==OP_CLAIM_ARCHIVED){val msg=ClaimArchived.fromSlice(in.body);ledger.claimArchived(msg,in.senderAddress,in.valueCoins,false,ES_BOUNCE_GAS,0);st.jetton=ledger.toCell();st.save();return;}
    if(op==OP_CLAIM_OWED){val msg=ClaimOwed.fromSlice(in.body);ledger.claim(msg.slot,msg.owner,msg.queryId,in.senderAddress,in.valueCoins,false,ES_BOUNCE_GAS,0);st.jetton=ledger.toCell();st.save();return;}
    if(op==OP_SWEEP_PROBE){val msg=SweepProbe.fromSlice(in.body);var sweeps=st.sweeps.load();sweeps.probe(ledger,msg.slot,st.liabilities(msg.slot),in.senderAddress,in.valueCoins,ES_BOUNCE_GAS);st.sweeps=sweeps.toCell();st.save();return;}
    assert(in.senderAddress==peers.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
    if(op==OP_SPLITTER_BIND){val msg=SplitterBind.fromSlice(in.body);
        assert(st.merkleClaim==null && msg.merkleClaim.getWorkchain()==BASECHAIN && ledger.canPay(msg.merkleClaim)
            && msg.merkleClaim!=msg.tsMaster && msg.merkleClaim!=peers.governance && msg.merkleClaim!=peers.treasury && msg.merkleClaim!=peers.gasVault
            && msg.tsMaster!=peers.governance && msg.tsMaster!=peers.treasury && msg.tsMaster!=peers.gasVault) throw ERR_JETTON_CONFIG;
        ledger.slotAdd(0,msg.tsMaster,JETTON_V21_WALLET_GAS,0,false,jetton_standard_budget(JETTON_V21_WALLET_GAS));st.merkleClaim=msg.merkleClaim;st.jetton=ledger.toCell();ledger.discover();
    }else if(op==OP_SPLITTER_SET_RECIPIENT){val msg=SplitterSetRecipient.fromSlice(in.body);
        assert(ledger.slots.mustGet(0,ERR_JETTON_SLOT).wallet!=null && ledger.canPay(msg.to) && msg.forwardGas<=120000) throw ERR_JETTON_DEST;
        var cfg=st.config.load();cfg.recipients.set(msg.slot as uint8,{to:msg.to,forwardGas:msg.forwardGas});st.config=cfg.toCell();
    }else if(op==OP_SPLITTER_SET_WEIGHTS){val msg=SplitterSetWeights.fromSlice(in.body);var cfg=st.config.load();var sum=0;var i=0;
        while(i<8){val w=(msg.weights >> ((7-i)*16)) & 65535;assert(w==0 || cfg.recipients.exists(i as uint8)) throw ERR_JETTON_DEST;cfg.weights.set(i as uint8,w as uint16);sum+=w;i+=1;}
        assert(sum==0 || sum==10000) throw ERR_JETTON_CONFIG;st.config=cfg.toCell();
    }else if(op==OP_SWEEP_ALLOW){val msg=SweepAllow.fromSlice(in.body);var sweeps=st.sweeps.load();sweeps.allow(ledger,msg.slot,msg.amount);st.sweeps=sweeps.toCell();
    }else{throw ERR_JETTON_CONFIG;}
    st.save();es_reserve(in.valueCoins,peers.gasVault,false);es_return(in.senderAddress);
}
get fun get_stream(): (coins,coins,int,int,coins,coins){var st=EmissionsStorage.load();st.stream.sync(blockchain.now());return(st.stream.releasable,st.stream.pending,st.stream.last,st.stream.end,st.funded,st.sent);}
get fun get_recipients(): (map<uint8,EmissionsRecipient>,map<uint8,uint16>){val cfg=EmissionsStorage.load().config.load();return(cfg.recipients,cfg.weights);}
get fun get_peers(): (address,address,address,address?){val st=EmissionsStorage.load();val p=st.peers.load();return(p.governance,p.treasury,p.gasVault,st.merkleClaim);}
get fun get_jetton_slots(): map<uint8,JettonSlot>{return EmissionsStorage.load().jetton.load().slots;}
get fun get_jetton_liabilities(slot:uint8): coins{return EmissionsStorage.load().liabilities(slot);}
get fun get_unattributed_surplus(slot:uint8,observed:coins): (coins,coins,coins){val l=get_jetton_liabilities(slot);return(l,max(observed-l,0),max(l-observed,0));}
get fun get_owed(slot:uint8,owner:address): coins{return EmissionsStorage.load().jetton.load().owedOf(slot,owner);}
get fun get_owed_book(slot:uint8): (coins,int){val l=EmissionsStorage.load().jetton.load();return(l.owedTotal(slot),l.owedCount(slot));}
get fun get_sweep(slot:uint8): SweepSlot{return EmissionsStorage.load().sweeps.load().get(slot);}
get fun get_min_value(op:uint32): coins{return es_min_value(EmissionsStorage.load(),op);}
get fun get_min_forward(): coins{return calculateGasFee(BASECHAIN,ES_CREDIT_GAS);}
get fun get_min_sweep(slot:uint8): coins{return EmissionsStorage.load().jetton.load().jetton_min_sweep(slot,ES_BOUNCE_GAS);}
get fun get_min_claim(slot:uint8): coins{return EmissionsStorage.load().jetton.load().jetton_min_claim(slot,ES_BOUNCE_GAS);}
get fun get_min_discover(): coins{return es_min_value(EmissionsStorage.load(),OP_DISCOVER_WALLETS);}
get fun get_claim_value(claimValue:coins,proof:cell): coins{val size=proof.calculateSizeStrict(256);return claimValue+calculateGasFee(BASECHAIN,ES_ADMIN_GAS)+calculateForwardFee(BASECHAIN,size.1+1000,size.0+2);}

get fun get_owed_archive(slot:uint8): (uint65,uint256,coins){return EmissionsStorage.load().jetton.load().owedArchive(slot);}
get fun get_min_archive_claim(slot:uint8): coins{return EmissionsStorage.load().jetton.load().jetton_min_archive_claim(slot,ES_BOUNCE_GAS);}
