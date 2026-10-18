tolk 1.5.0
import "../shared/jetton/holder_recovery"
import "../t3/receipt_tree"
import "../t3/recovery_types"
import "../shared/utils/error_codes"
import "@stdlib/gas-payments"
import "sale_config_codec"
import "../shared/jetton/jetton_quotes"
import "@gen/op/t3"

fun launchpad_recovery_accept(sender:address,value:coins,body:slice){
    assert(value>=calculateGasFee(0,JETTON_RECEIPT_GAS)) throw ERR_JETTON_VALUE;setGasLimit(250000);
    var st=ChildStorage.load();var managed=st.jetton.load();val evidence=jetton_recovery_authenticate(managed.ledger,0,sender,body);
    assert(value>=jetton_receipt_value(T3Receipt{key:evidence.key,payload:evidence.item.toCell()}.toCell())) throw ERR_JETTON_VALUE;
    val receipt=managed.recovery.record(evidence);st.jetton=managed.toCell();st.save();
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0)+jetton_receipt_rent(),RESERVE_MODE_EXACT_AMOUNT|RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createExternalLogMessage({dest:createAddressNone(),body:JettonRecovered{receipt}}).send(SEND_MODE_PAY_FEES_SEPARATELY|SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    launchpad_return(sender);
}
get fun get_recovery(slot:uint8):Cell<JettonRecovery>?{return ChildStorage.load().jetton.load().recovery.get(slot);}
get fun get_min_recovery(certificate:cell):coins{
    var b=certificate.beginParse();b.loadUint(32);val config=b.loadRef() as Cell<ProofConfig>;b.loadRef();val code=b.loadRef();
    val e=jetton_recovery_authenticate(ChildStorage.load().ledger(),0,t3_proof_address(config,code),certificate.beginParse());
    return jetton_receipt_value(T3Receipt{key:e.key,payload:e.item.toCell()}.toCell());
}
get fun get_min_recovery_claim(receipt:Cell<T3Receipt>):coins{return calculateGasFee(0,JETTON_RECEIPT_GAS)+jetton_recovery_rent();}
