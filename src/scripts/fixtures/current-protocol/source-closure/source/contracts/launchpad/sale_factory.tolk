tolk 1.5.0
import "@gen/op/tep";
import "sale_config_codec"
import "@stdlib/gas-payments"
import "../shared/governance/module_gate"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../dlmm/constants"
import "../dlmm/pool_state_init"
import "@gen/op/launchpad"

const SF_CREATE_GAS = 180000
struct ChildCode { code: cell; bits: uint32; cells: uint16 }
struct FactoryPeers { t3Master: address; feeSink: address; dlmmFactory: address; profile: Cell<T3Profile> }
struct FactoryStorage { gate: ModuleGate; peers: Cell<FactoryPeers>; feeBps: uint16; codes: map<uint8,ChildCode> }
struct (0x53464642) FactorySetFee { queryId:uint64; feeBps:uint16 }
struct (0x53464e57) FactoryNewSale { queryId:uint64; nonce:uint64; kind:uint8; terms:Cell<SaleTerms> }
struct (0x53464556) SaleCreated { creator:address; nonce:uint64; kind:uint8; sale:address }
fun sf_child(st:FactoryStorage,creator:address,nonce:uint64,kind:uint8,role:uint8):AutoDeployAddress{
    val code=st.codes.mustGet(role==0?kind:(role+2) as uint8).code;
    return {stateInit:{code,data:launchpad_initial({factory:contract.getAddress(),creator,nonce,kind,role},role==0?sale_empty_book():(role==1?lp_empty_book():vest_empty_book()))}};
}
fun sf_min(st:FactoryStorage,kind:uint8,vesting:bool,duration:uint32):coins{
    var value=calculateGasFee(BASECHAIN,SF_CREATE_GAS)+calculateForwardFee(BASECHAIN,1400,2);var role=0;
    repeat(vesting?3:2){val code=st.codes.mustGet(role==0?kind:(role+2) as uint8);
        value+=launchpad_init_value(role==2?duration:0)+calculateForwardFee(BASECHAIN,code.bits+8000,code.cells+40);role+=1;}
    return value;
}
fun sf_payable(p:FactoryPeers,sale:address,lp:address,vest:address,x:address,a:address):bool{
    return a.getWorkchain()==0&&a!=x&&a!=p.t3Master&&a!=contract.getAddress()&&a!=p.feeSink&&a!=p.dlmmFactory&&a!=sale&&a!=lp&&a!=vest;
}
fun onInternalMessage(in:InMessage){if(in.body.remainingBitsCount()<32){return;}val op=in.body.preloadUint(32);if(op==OP_TEP74_EXCESSES){return;}
    var st=FactoryStorage.fromCell(contract.getData());val p=st.peers.load();
    if(gate_handle(mutate st.gate,in.senderAddress,in.body)){contract.setData(st.toCell());launchpad_reserve(in.valueCoins);launchpad_return(in.senderAddress);return;}
    if(op==OP_FACTORY_SET_FEE){val m=FactorySetFee.fromSlice(in.body);gate_require_governance(st.gate,in.senderAddress);assert(m.feeBps<=500&&in.valueCoins>=launchpad_control_value()) throw ERR_SALE;
        st.feeBps=m.feeBps;contract.setData(st.toCell());launchpad_reserve(in.valueCoins);launchpad_return(in.senderAddress);return;}
    assert(op==OP_FACTORY_NEW_SALE) throw ERR_SALE;val m=FactoryNewSale.fromSlice(in.body);gate_require_open(st.gate);val t=m.terms.load();assert(sale_terms_valid(m.kind,t)) throw ERR_SALE;
    val sale=sf_child(st,in.senderAddress,m.nonce,m.kind,0);val lp=sf_child(st,in.senderAddress,m.nonce,m.kind,1);val vest=sf_child(st,in.senderAddress,m.nonce,m.kind,2);
    val a=sale.calculateAddress();val b=lp.calculateAddress();val c=vest.calculateAddress();
    assert(sf_payable(p,a,b,c,t.projectMaster,in.senderAddress)&&sf_payable(p,a,b,c,t.projectMaster,t.lpRecipient)) throw ERR_SALE;
    assert(t.projectMaster!=p.t3Master&&t.projectMaster!=contract.getAddress()&&t.projectMaster!=p.feeSink&&t.projectMaster!=p.dlmmFactory&&t.projectMaster!=a&&t.projectMaster!=b&&t.projectMaster!=c) throw ERR_SALE;
    if(t.vesting!=null){assert(sf_payable(p,a,b,c,t.projectMaster,t.vesting!.load().beneficiary)) throw ERR_SALE;}
    val duration:uint32=t.vesting==null?0:t.vesting!.load().duration;assert(in.valueCoins>=sf_min(st,m.kind,t.vesting!=null,duration)) throw ERR_SALE;
    launchpad_reserve(in.valueCoins);
    createMessage({bounce:BounceMode.NoBounce,dest:sale,value:launchpad_init_value(0),body:SaleInit{feeBps:st.feeBps,t3Master:p.t3Master,profile:p.profile,
        peers:SalePeers{feeSink:p.feeSink,lpVault:b,vestingVault:t.vesting==null?null:c}.toCell(),terms:m.terms}}).send(1|16);
    val poolId=PoolId{xMaster:t.projectMaster,binSpacing:POOL_PUBLIC_BIN_SPACING,feePips:POOL_PUBLIC_FEE_PIPS,xDecimals:t.xDecimals,
        walletGasX:POOL_PUBLIC_WALLET_GAS_X,walletGramX:0,walletBudgetX:jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X)}.toCell();
    createMessage({bounce:BounceMode.NoBounce,dest:lp,value:launchpad_init_value(0),body:LpInit{sale:a,lpRecipient:t.lpRecipient,seedBin:t.seedBin,
        more:LpInitMore{dlmmFactory:p.dlmmFactory,t3Master:p.t3Master,projectMaster:t.projectMaster,profile:p.profile}.toCell(),poolId}}).send(1|16);
    if(t.vesting!=null){createMessage({bounce:BounceMode.NoBounce,dest:vest,value:launchpad_init_value(duration),body:VestInit{sale:a,projectMaster:t.projectMaster,terms:t.vesting!}}).send(1|16);}
    createExternalLogMessage({dest:createAddressNone(),body:SaleCreated{creator:in.senderAddress,nonce:m.nonce,kind:m.kind,sale:a}}).send(2);launchpad_return(in.senderAddress);
}
fun onBouncedMessage(in:InMessageBounced){}
get fun get_factory():(address,bool,int,address,address,address){val st=FactoryStorage.fromCell(contract.getData());val p=st.peers.load();return(st.gate.governance,st.gate.withdrawalsOnly,st.feeBps,p.t3Master,p.feeSink,p.dlmmFactory);}
get fun get_child_addresses(creator:address,nonce:uint64,kind:uint8):(address,address,address){assert(kind<=2) throw ERR_SALE;val st=FactoryStorage.fromCell(contract.getData());return(sf_child(st,creator,nonce,kind,0).calculateAddress(),sf_child(st,creator,nonce,kind,1).calculateAddress(),sf_child(st,creator,nonce,kind,2).calculateAddress());}
get fun get_create_value(kind:uint8,hasVesting:bool,vestDuration:uint32):coins{assert(kind<=2) throw ERR_SALE;return sf_min(FactoryStorage.fromCell(contract.getData()),kind,hasVesting,vestDuration);}
get fun get_min_value(op:uint32):coins{return launchpad_control_value();}
get fun get_child_code_hash(slot:uint8):uint256{return FactoryStorage.fromCell(contract.getData()).codes.mustGet(slot).code.hash();}
