tolk 1.5.0
import "@stdlib/gas-payments";
import "../generated/op/options";
import "../shared/oracle/verdict";
import "./option_messages";
import "./option_limits";
import "../shared/utils/error_codes";

struct OptionTemplate {
    kind: uint16; basePool: address; quotePool: address?; tenor: uint32;
    strikeBps: uint32; collateralBps: uint32; premiumBps: uint32;
}
struct SeriesManagerStorage {
    governance: address; factory: address; nextSeriesId: uint64;
    templateCount: uint16; seriesCount: uint16;
    templates: map<uint32,OptionTemplate>; series: map<uint64,cell>;
}
fun SeriesManagerStorage.load(): SeriesManagerStorage { return SeriesManagerStorage.fromCell(contract.getData()); }
fun SeriesManagerStorage.save(self) { contract.setData(self.toCell()); }
fun manager_min_value(op: int): coins {
    if (op == OP_OM_CREATE || op == OP_OS_RESEND) { return option_create_value(); }
    return calculateGasFee(BASECHAIN,OPTION_MANAGER_GAS) + calculateForwardFee(BASECHAIN,700,1);
}
fun manager_tenor(tenor: int) {
    assert (tenor >= OPTION_MIN_TENOR && tenor <= OPTION_MAX_TENOR) throw ERR_OPTIONS_CONFIG;
}
fun manager_forward(factory: address,body: cell) {
    createMessage({bounce:BounceMode.Only256BitsOfBody,dest:factory,value:0,body})
        .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}
fun manager_return(sender: address,value: coins) {
    reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({bounce:BounceMode.NoBounce,dest:sender,value:0})
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}
fun onBouncedMessage(in: InMessageBounced) {}
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    assert (in.body.remainingBitsCount() >= 32) throw ERR_OPTIONS_CONFIG;
    var st = SeriesManagerStorage.load();
    val op = in.body.preloadUint(32);
    if (op == OP_OS_RESEND) {
        val msg = OsResend.fromSlice(in.body);
        val found = st.series.get(msg.seriesId);
        assert (found.isFound && in.valueCoins >= manager_min_value(op)) throw ERR_OPTIONS_CONFIG;
        val body = found.loadValue(); val terms = OsCreate.fromCell(body);
        assert (blockchain.now() < terms.expiry - OPTION_BUY_CUTOFF) throw ERR_OPTIONS_CONFIG;
        manager_forward(st.factory,body); return;
    }
    assert (in.senderAddress == st.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
    assert (in.valueCoins >= manager_min_value(op)) throw ERR_OPTIONS_CONFIG;
    if (op == OP_REGISTER_TEMPLATE) {
        val msg = RegisterTemplate.fromSlice(in.body);
        assert (msg.templateId > 0 && !st.templates.exists(msg.templateId)
            && st.templateCount < OPTION_MAX_TEMPLATES
            && (msg.optionKind == OPTION_KIND_SHOUT || msg.optionKind == OPTION_KIND_OUTPERF)
            && !msg.underlyingPool.isNone()) throw ERR_OPTIONS_CONFIG;
        val base = msg.underlyingPool as address;
        val quote: address? = msg.quotePool.isNone() ? null : msg.quotePool as address;
        assert (option_basechain(base) && (quote == null || option_basechain(quote))
            && (msg.optionKind != OPTION_KIND_OUTPERF || (quote != null && quote != base))) throw ERR_OPTIONS_CONFIG;
        manager_tenor(msg.tenorSeconds);
        st.templates.set(msg.templateId,OptionTemplate {kind:msg.optionKind,basePool:base,quotePool:quote,
            tenor:msg.tenorSeconds as uint32,strikeBps:msg.strikeBps,
            collateralBps:msg.collateralMultiplierBps,premiumBps:msg.basePremiumBps});
        st.templateCount += 1; st.save(); manager_return(in.senderAddress,in.valueCoins); return;
    }
    if (op == OP_UPDATE_TEMPLATE) {
        val msg = UpdateTemplate.fromSlice(in.body); val found = st.templates.get(msg.templateId);
        assert (found.isFound) throw ERR_OPTIONS_CONFIG;
        manager_tenor(msg.tenorSeconds);
        var t = found.loadValue(); t.tenor = msg.tenorSeconds as uint32; t.strikeBps = msg.strikeBps;
        t.collateralBps = msg.collateralMultiplierBps; t.premiumBps = msg.basePremiumBps;
        st.templates.set(msg.templateId,t); st.save(); manager_return(in.senderAddress,in.valueCoins); return;
    }
    if (op == OP_OM_CREATE) {
        val msg = OmCreate.fromSlice(in.body); val found = st.templates.get(msg.templateId);
        assert (found.isFound && msg.maxNotional >= OPTION_MIN_NOTIONAL && msg.maxNotional <= OPTION_MAX_NOTIONAL
            && option_basechain(msg.writer) && msg.writer != st.governance && msg.writer != st.factory
            && msg.writer != contract.getAddress()
            && st.seriesCount < OPTION_MAX_SERIES) throw ERR_OPTIONS_CONFIG;
        val t = found.loadValue(); val id = st.nextSeriesId as uint64;
        val body = OsCreate {seriesId:id,kind:t.kind,expiry:(blockchain.now()+t.tenor) as uint32,
            maxNotional:msg.maxNotional,premiumBps:t.premiumBps,collateralMultiplierBps:t.collateralBps,
            strikeBps:t.strikeBps,writer:msg.writer,pools:OptionPools {base:t.basePool,quote:t.quotePool}.toCell()}.toCell();
        st.nextSeriesId += 1; st.seriesCount += 1; st.series.set(id,body); st.save();
        manager_forward(st.factory,body); return;
    }
    throw ERR_OPTIONS_CONFIG;
}
get fun get_min_value(op: int): coins { return manager_min_value(op); }
get fun get_manager(): (address,address,int,int,int) {
    val st = SeriesManagerStorage.load(); return (st.governance,st.factory,st.nextSeriesId,st.templateCount,st.seriesCount);
}
get fun get_template(id: uint32): cell? {
    val found = SeriesManagerStorage.load().templates.get(id); return found.isFound ? found.loadValue().toCell() : null;
}
get fun get_series(id: uint64): cell? {
    val found = SeriesManagerStorage.load().series.get(id); return found.isFound ? found.loadValue() : null;
}
get fun get_capacity(): (int,int) { return (OPTION_MAX_TEMPLATES,OPTION_MAX_SERIES); }
get fun get_rent_runway(): (coins,coins) {
    val st = SeriesManagerStorage.load();
    return (contract.getOriginalBalance(),calculateStorageFee(BASECHAIN,31536000,
        100000 + 1100*st.templateCount + 1500*st.seriesCount,
        256 + 2*st.templateCount + 3*st.seriesCount));
}
