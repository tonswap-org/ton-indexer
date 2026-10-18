tolk 1.5.0
import "../shared/governance/module_gate";
import "../shared/risk/exposure_cap";
import "./option_messages";

const OPTION_MAX_FACTORY_RECORDS = 4096;
struct FactoryPeers { vault: address; manager: address?; shoutCode: cell; outperfCode: cell }
struct FactoryPolicy {
    cap: ExposureCap; protocolFeeBps: uint16;
    bumpActivate: uint16; bumpDeactivate: uint16; pauseThreshold: uint16; bumpPercent: uint16; bumpActive: bool;
    fundedTotal: coins; lockedTotal: coins; pendingNotional: coins;
    seriesCount: uint16; recordCount: uint16; shoutCollateral: uint32; outperfCollateral: uint32;
}
struct FactoryTerms {
    writer: address; child: address; kind: uint16; expiry: uint32; maxNotional: coins;
    premiumBps: uint32; collateralBps: uint32; requiredReserve: coins; creation: Cell<OsCreate>;
}
struct FactoryPosition { buyer: address; notional: coins; net: coins; fee: coins; lock: coins; released: bool }
struct FactorySeries {
    terms: Cell<FactoryTerms>; funded: coins; fundIntent: uint64; withdrawnBacking: coins;
    locked: coins; pendingLock: coins; pendingNotional: coins; openNotional: coins;
    purged: bool; recordCount: uint16; positions: map<uint64,FactoryPosition>;
}
struct PendingBuy { seriesId: uint64; buyer: address; notional: coins; net: coins; fee: coins; lock: coins }
struct FactoryStorage {
    gate: ModuleGate; peers: Cell<FactoryPeers>; policy: Cell<FactoryPolicy>;
    series: map<uint64,FactorySeries>; pending: map<uint64,PendingBuy>;
}
fun FactoryStorage.load(): FactoryStorage { return FactoryStorage.fromCell(contract.getData()); }
fun FactoryStorage.save(self) { contract.setData(self.toCell()); }
struct FactoryQuote { status: uint16; net: coins; fee: coins; lock: coins; utilisation: uint16; bump: bool }
