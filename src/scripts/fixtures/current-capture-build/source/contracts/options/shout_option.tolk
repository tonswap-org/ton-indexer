tolk 1.5.0
import "./option_child";
import "./child_budget";
import "./child_types";
fun onInternalMessage(in: InMessage) { child_on_internal(1,in.senderAddress,in.valueCoins,in.body); }
fun onBouncedMessage(in: InMessageBounced) { child_on_bounce(1,in.senderAddress,in.valueCoins,in.bouncedBody); }
get fun position_outcome(tokenId: uint64): cell? { return child_get_position(tokenId); }
get fun terminal_state(): (int,int,int,int,int) { return child_get_terminal(); }
get fun strike_state(): (int,int,int) { return child_get_strike(); }
get fun exercise_preview(tokenId: uint64,priceE9: int): coins { return child_get_preview(1,tokenId,priceE9); }
get fun get_min_value(op: int): coins { return child_min_value(1,op); }
get fun get_rent_runway(): (coins,coins) { return child_get_runway(); }
get fun get_capacity(): (int,int,int) { val st=ChildStorage.load();return(st.positionCount,st.openNotional,256); }
