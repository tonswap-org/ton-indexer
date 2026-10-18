tolk 1.5.0
import "./option_messages";
import "@stdlib/exotic-cells";
import "../shared/jetton/tep74_codec";

struct ChildTerms {
    writer: address; expiry: uint32; maxNotional: coins; strikeBps: uint32;
    collateralBps: uint32; cooldown: uint32; floorWindow: uint32; pools: Cell<OptionPools>;
}
struct ChildOracle {
    initial0: uint128; initial1: uint128; strike: uint128;
    answered0: bool; medium0: uint128; long0: uint128;
    answered1: bool; medium1: uint128; long1: uint128;
    state: uint2; window: uint16; decidedAt: uint64;
}
struct ChildAmounts { notional: coins; net: coins; lock: coins; payout: coins }
struct ChildPosition { owner: address; amounts: Cell<ChildAmounts>; shoutFloor: uint128; lastShoutAt: uint32; outcome: uint2 }
struct ChildStorage {
    factory: address; seriesId: uint64; terms: Cell<ChildTerms>?; oracle: Cell<ChildOracle>;
    positionCount: uint16; openNotional: coins; positions: map<uint64,ChildPosition>;
}
fun ChildStorage.load(): ChildStorage { return ChildStorage.fromCell(contract.getData()); }
fun ChildStorage.save(self) { contract.setData(self.toCell()); }

const CHILD_SEED = 1;
const CHILD_SETTLE = 2;
const CHILD_BUY = 3;
const CHILD_SHOUT = 4;
const CHILD_EXERCISE = 5;
// Internal continuation, serialized by kind so that the buy fits 968 bits without references.
struct ChildEcho {
    kind: uint8; side: uint1; sentAt: uint64; firstServedAt: uint64;
    actor: address; tokenId: uint64; notional: coins; net: coins; lock: coins;
    minimum: coins; firstPrice: uint128;
}
fun child_echo(kind: int,actor: address,tokenId: uint64): ChildEcho {
    return {kind:kind as uint8,side:0,sentAt:blockchain.now(),firstServedAt:0,actor,tokenId,
        notional:0,net:0,lock:0,minimum:0,firstPrice:0};
}
fun ChildEcho.encode(self): cell {
    var b=beginCell().storeUint(self.kind,8).storeUint(self.side,1).storeUint(self.sentAt,64).storeUint(self.firstServedAt,64);
    if(self.kind==CHILD_EXERCISE) {return b.storeUint(self.tokenId,64).storeAddress(self.actor).storeCoins(self.minimum).endCell();}
    if(self.kind==CHILD_BUY) {return b.storeUint(self.tokenId,64).storeAddress(self.actor).storeCoins(self.notional).storeCoins(self.net).storeCoins(self.lock).storeUint(self.firstPrice,128).endCell();}
    b.storeAddress(self.actor);
    if(self.kind==CHILD_SEED) {b.storeUint(self.firstPrice,128);}
    if(self.kind==CHILD_SHOUT) {b.storeUint(self.tokenId,64);}
    return b.endCell();
}
fun child_echo_decode(c: cell): ChildEcho? {
    var(s,exotic)=c.beginParseSpecial();
    if(exotic || s.remainingRefsCount()!=0 || s.remainingBitsCount()<137) {return null;}
    val kind=s.loadUint(8);if(kind<CHILD_SEED || kind>CHILD_EXERCISE) {return null;}
    val side=s.loadUint(1);val sentAt=s.loadUint(64);val firstServedAt=s.loadUint(64);
    var tokenId:uint64=0;
    if(kind==CHILD_BUY || kind==CHILD_EXERCISE) {if(s.remainingBitsCount()<64){return null;}tokenId=s.loadUint(64);}
    val actor=s.tryLoadStdAddress();if(actor==null){return null;}
    var e=ChildEcho{kind:kind as uint8,side:side as uint1,sentAt,firstServedAt,actor,tokenId,
        notional:0,net:0,lock:0,minimum:0,firstPrice:0};
    if(kind==CHILD_BUY) {
        val notional=s.tryLoadCoins();val net=s.tryLoadCoins();val lock=s.tryLoadCoins();
        if(notional==null || net==null || lock==null || s.remainingBitsCount()!=128){return null;}
        e.notional=notional;e.net=net;e.lock=lock;e.firstPrice=s.loadUint(128);
    }else if(kind==CHILD_EXERCISE) {val minimum=s.tryLoadCoins();if(minimum==null){return null;}e.minimum=minimum;
    }else if(kind==CHILD_SEED) {if(s.remainingBitsCount()!=128){return null;}e.firstPrice=s.loadUint(128);
    }else if(kind==CHILD_SHOUT) {if(s.remainingBitsCount()!=64){return null;}e.tokenId=s.loadUint(64);}
    return s.isEmpty()?e:null;
}
