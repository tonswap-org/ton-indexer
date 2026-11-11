tolk 1.5.0
import "@stdlib/gas-payments";
import "./child_budget";
import "../generated/op/options";
import "../shared/oracle/verdict";
import "./option_limits";

const OPTION_FACTORY_GAS = 120000;
fun of_local_value(): coins { return calculateGasFee(BASECHAIN,OPTION_FACTORY_GAS)+child_transport_fee(); }
fun of_record_rent(): coins {
    return 2*calculateStorageFee(BASECHAIN,OPTION_MAX_TENOR+OPTION_BUY_CUTOFF+2592000,2400,8);
}
fun of_admission_value(kind: int): coins {
    if(kind==1){return of_local_value()+child_callback_value();}
    return of_local_value()+child_min_value(OPTION_KIND_OUTPERF,OP_OX_BUY)+of_record_rent();
}
fun of_min_value(op: int): coins {
    if(op==OP_OS_CREATE){return option_create_value()-calculateGasFee(BASECHAIN,OPTION_MANAGER_GAS);}
    if(op==OP_FACTORY_EXERCISE){return of_local_value()+child_min_value(1,OP_OX_SETTLE_Q);}
    if(op==OP_OF_EXERCISE){return of_local_value()+child_min_value(1,OP_OF_EXERCISE);}
    if(op==OP_OV_CANCEL || op==OP_OPTION_WITHDRAW_REQUEST){return of_local_value()+child_callback_value();}
    if(op==OP_OV_ADMIT){return of_admission_value(2);}
    return of_local_value();
}
