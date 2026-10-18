tolk 1.5.0
import "@stdlib/gas-payments";
import "../generated/op/options";
import "../generated/op/oracle";
import "../shared/oracle/evidence";
import "./option_limits";

const CHILD_REQUEST_GAS = 60000;
const CHILD_REPLY_GAS = 120000;
// Full Factory commit/settlement plus the Vault continuation, each with margin.
const CHILD_SETTLEMENT_TAIL_GAS = 300000;
fun child_transport_fee(): coins { return calculateForwardFee(BASECHAIN,1900,3); }
fun child_callback_value(): coins {
    return calculateGasFee(BASECHAIN,CHILD_SETTLEMENT_TAIL_GAS) + 3*child_transport_fee();
}
fun child_query_value(kind: int): coins {
    return (kind==OPTION_KIND_OUTPERF?2:1)*(oracle_min_forward()+calculateGasFee(BASECHAIN,CHILD_REPLY_GAS)+child_transport_fee());
}
fun child_min_value(kind: int,op: int): coins {
    val base=calculateGasFee(BASECHAIN,CHILD_REQUEST_GAS)+child_transport_fee();
    if(op==OP_OPTION_SEED || op==OP_OX_BUY) {return base+child_query_value(kind)+(op==OP_OX_BUY?child_callback_value():0 as coins);}
    if(op==OP_OPTION_SETTLE || op==OP_SHOUT) {return base+child_query_value(OPTION_KIND_SHOUT);}
    if(op==OP_OX_SETTLE_Q) {return base+child_callback_value();}
    if(op==OP_OF_EXERCISE) {return base+child_query_value(OPTION_KIND_SHOUT)+child_callback_value();}
    return base;
}
