tolk 1.5.0
import "@stdlib/common.tolk";
import "../shared/risk/counterparty.tolk";
fun onInternalMessage(_:InMessage) {}
fun onBouncedMessage(_:InMessageBounced) {}
get fun plan(reserved:coins,funding:coins,collected:coins,pnl:int128,closeSize:uint128,totalSize:uint128,userCash:coins,minimum:coins,fundingDebt:coins,remainingEntitlement:coins): (coins,coins,coins,bool,uint128,int128,coins,coins,coins,coins,coins) {
    val result=counterparty_plan_close(CounterpartyPosition {reserved,pendingFunding:funding,collectedLoss:collected,remainingEntitlement},pnl,closeSize,totalSize,userCash,minimum,fundingDebt);
    return(result.state.reserved,result.state.pendingFunding,result.state.collectedLoss,result.forceFullClose,result.closedSize,result.realizedPnl,result.userProfit,result.userDebit,result.lpReleased,result.unpaidLoss,result.state.remainingEntitlement);
}
get fun reservation(notional:coins,bps:uint32,minimum:coins):coins { return counterparty_reservation(notional,bps,minimum); }
get fun credit(reserved:coins,funding:coins,collected:coins,amount:coins,remainingEntitlement:coins):(coins,coins,coins,coins) {
    val state=counterparty_credit_collected(CounterpartyPosition{reserved,pendingFunding:funding,collectedLoss:collected,remainingEntitlement},amount);
    return(state.reserved,state.pendingFunding,state.collectedLoss,state.remainingEntitlement);
}
get fun should_liquidate(reserved:coins,funding:coins,remainingEntitlement:coins,pnl:int128,minimum:coins):bool {
    return counterparty_should_liquidate(CounterpartyPosition{reserved,pendingFunding:funding,collectedLoss:0,remainingEntitlement},pnl,minimum);
}
